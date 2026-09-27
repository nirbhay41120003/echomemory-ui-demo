let stream, recorder, audioChunks = [], timerInterval, isCapturing = false, isStarting = false, isProcessing = false;
let realtimeSocket, realtimeReady = false, realtimeFailed = false, realtimeSessionEnded = false, resolveRealtimeEnd;
let audioContext, audioProcessor;
let finalized = [], partial = "";
let pendingMemory = "";
const MEMORY_KEY = "echomemory-demo-memories";
let demoMemories = loadStoredMemories();
const $ = (id) => document.getElementById(id);

function loadStoredMemories() {
  try {
    const saved = JSON.parse(localStorage.getItem(MEMORY_KEY) || "[]");
    return Array.isArray(saved) ? saved.filter((item) => item && typeof item.text === "string") : [];
  } catch (_) { return []; }
}

function setStatus(text, state = "") {
  $("status").querySelector("span").textContent = text;
  $("status").className = `status ${state}`;
}

function setCaptureButton(capturing) {
  isCapturing = capturing;
  const button = $("capture");
  button.classList.toggle("recording", capturing);
  button.innerHTML = capturing ? "<span aria-hidden=\"true\">■</span><span>Stop capture</span>" : "<span aria-hidden=\"true\">●</span><span>Start capture</span>";
}

function renderTranscript() {
  const target = $("transcript");
  const lines = finalized.map((text) => text);
  if (partial) lines.push(`${partial} …`);
  target.classList.toggle("empty", lines.length === 0);
  target.textContent = lines.length ? lines.join("\n\n") : "Your words will appear here as you speak.";
  target.scrollTop = target.scrollHeight;
}

function setTranscriptMode(text, state = "") {
  const mode = $("transcript-mode");
  mode.textContent = text;
  mode.className = `transcript-mode ${state}`;
}

async function cleanAndSaveMemory(rawText) {
  const response = await fetch("/api/cleanup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: rawText }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Groq cleanup failed. Nothing was saved.");
  const cleaned = typeof data.text === "string" ? data.text.trim() : "";
  if (!cleaned || cleaned.length > 10_000) throw new Error("Groq returned no usable cleaned memory. Nothing was saved.");
  if (!persistMemory(cleaned)) throw new Error("Memory storage is full. The cleaned text is ready to retry.");
  return cleaned;
}

function downsample(input, inputRate, outputRate = 16000) {
  if (inputRate === outputRate) return input;
  const ratio = inputRate / outputRate;
  const output = new Float32Array(Math.floor(input.length / ratio));
  for (let index = 0; index < output.length; index += 1) {
    const start = Math.floor(index * ratio), end = Math.min(Math.floor((index + 1) * ratio), input.length);
    let sum = 0;
    for (let sample = start; sample < end; sample += 1) sum += input[sample];
    output[index] = sum / Math.max(1, end - start);
  }
  return output;
}

async function recordingToWav(blob) {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) throw new Error("This browser cannot convert the recording for transcription.");
  const context = new AudioContextClass();
  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer());
    const mono = new Float32Array(decoded.length);
    for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
      const samples = decoded.getChannelData(channel);
      for (let index = 0; index < samples.length; index += 1) mono[index] += samples[index] / decoded.numberOfChannels;
    }
    const samples = downsample(mono, decoded.sampleRate);
    const wav = new ArrayBuffer(44 + samples.length * 2), view = new DataView(wav);
    const write = (offset, value) => { for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i)); };
    write(0, "RIFF"); view.setUint32(4, 36 + samples.length * 2, true); write(8, "WAVE"); write(12, "fmt ");
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    write(36, "data"); view.setUint32(40, samples.length * 2, true);
    for (let index = 0; index < samples.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, samples[index]));
      view.setInt16(44 + index * 2, sample < 0 ? sample * 32768 : sample * 32767, true);
    }
    return new Blob([wav], { type: "audio/wav" });
  } finally { await context.close(); }
}

function stopAudio() {
  if (stream) { stream.getTracks().forEach((track) => track.stop()); stream = null; }
  clearInterval(timerInterval);
}

function startTimer() {
  const started = Date.now();
  $("timer").textContent = "00:00";
  timerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - started) / 1000);
    $("timer").textContent = `${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(elapsed % 60).padStart(2, "0")}`;
    if (elapsed >= 25) {
      $("hint").textContent = "25-second limit reached. Transcribing your capture now…";
      finishCapture();
    }
  }, 1000);
}

function connectRealtime() {
  return new Promise((resolve) => {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    let socket;
    try { socket = new WebSocket(`${protocol}//${location.host}/api/realtime`); }
    catch (_) { realtimeFailed = true; resolve(false); return; }
    realtimeSocket = socket;
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true; realtimeFailed = true; socket.close(); resolve(false);
    }, 10000);
    socket.addEventListener("message", (message) => {
      let event;
      try { event = JSON.parse(message.data); } catch (_) { return; }
      if (event.event === "ready") {
        realtimeReady = true; settled = true; clearTimeout(timeout); resolve(true); return;
      }
      if (event.event === "transcript.partial") {
        partial = event.text || ""; renderTranscript(); setTranscriptMode("Live · Sarvam", "live");
      } else if (event.event === "transcript.final") {
        if (event.text?.trim()) finalized.push(event.text.trim());
        partial = ""; renderTranscript(); setTranscriptMode("Live · Sarvam", "live");
      } else if (event.event === "session.end") {
        realtimeSessionEnded = true; resolveRealtimeEnd?.(true);
      } else if (event.event === "error") {
        realtimeFailed = true;
        $("hint").textContent = event.message || "Sarvam live transcription stopped. The saved audio will be sent after capture.";
        if (!settled) { settled = true; clearTimeout(timeout); resolve(false); }
        if (event.is_fatal) resolveRealtimeEnd?.(false);
      }
    });
    socket.addEventListener("error", () => {
      realtimeFailed = true;
      if (!settled) { settled = true; clearTimeout(timeout); resolve(false); }
    });
    socket.addEventListener("close", () => {
      realtimeReady = false;
      if (!realtimeSessionEnded) realtimeFailed = true;
      if (!settled) { settled = true; clearTimeout(timeout); resolve(false); }
      resolveRealtimeEnd?.(realtimeSessionEnded);
    });
  });
}

async function startRealtimeAudio(audioStream) {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass || !realtimeReady) { realtimeFailed = true; return false; }
  try {
    audioContext ||= new AudioContextClass();
    if (audioContext.state === "suspended") await audioContext.resume();
    const source = audioContext.createMediaStreamSource(audioStream);
    audioProcessor = audioContext.createScriptProcessor(4096, 1, 1);
    const mute = audioContext.createGain(); mute.gain.value = 0;
    audioProcessor.onaudioprocess = (event) => {
      if (!realtimeReady || realtimeFailed || realtimeSocket?.readyState !== WebSocket.OPEN) return;
      const pcm = downsample(event.inputBuffer.getChannelData(0), audioContext.sampleRate);
      const bytes = new ArrayBuffer(pcm.length * 2), view = new DataView(bytes);
      for (let index = 0; index < pcm.length; index += 1) {
        const sample = Math.max(-1, Math.min(1, pcm[index]));
        view.setInt16(index * 2, sample < 0 ? sample * 32768 : sample * 32767, true);
      }
      try { realtimeSocket.send(bytes); } catch (_) { realtimeFailed = true; }
    };
    source.connect(audioProcessor); audioProcessor.connect(mute); mute.connect(audioContext.destination);
    return true;
  } catch (_) { realtimeFailed = true; stopRealtimeAudio(); return false; }
}

function stopRealtimeAudio() {
  if (audioProcessor) { audioProcessor.onaudioprocess = null; audioProcessor.disconnect(); audioProcessor = null; }
  if (audioContext) { audioContext.close().catch(() => {}); audioContext = null; }
}

function stopRealtime() {
  stopRealtimeAudio();
  if (realtimeSocket?.readyState === WebSocket.OPEN && !realtimeFailed) {
    realtimeSocket.send(JSON.stringify({ event: "end" }));
  } else {
    resolveRealtimeEnd?.(false);
    realtimeSocket?.close();
  }
}

async function startCapture() {
  if (isStarting || isCapturing || isProcessing) return;
  isStarting = true; $("capture").disabled = true;
  try {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error("Audio capture needs a supported browser and a secure connection (HTTPS).");
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) {
      try { audioContext = new AudioContextClass(); audioContext.resume().catch(() => {}); } catch (_) { audioContext = null; }
    }
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    finalized = []; partial = ""; realtimeFailed = false; realtimeReady = false; realtimeSessionEnded = false; resolveRealtimeEnd = null;
    const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((type) => MediaRecorder.isTypeSupported(type));
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    audioChunks = [];
    recorder.addEventListener("dataavailable", (event) => { if (event.data.size) audioChunks.push(event.data); });
    recorder.addEventListener("stop", processRecording, { once: true });
    setStatus("Connecting to Sarvam…", "busy"); setTranscriptMode("Connecting", "busy");
    $("hint").textContent = "Opening a secure live transcription connection to Sarvam AI…";
    const connected = await connectRealtime();
    recorder.start();
    isStarting = false; $("capture").disabled = false;
    renderTranscript(); startTimer(); setCaptureButton(true); setStatus(connected ? "Listening · Sarvam realtime" : "Recording · Sarvam fallback", connected ? "live" : "warn");
    setTranscriptMode(connected ? "Sarvam live" : "Sarvam fallback", connected ? "live" : "warn");
    const streaming = connected && await startRealtimeAudio(stream);
    if (!streaming) realtimeFailed = true;
    $("hint").textContent = streaming
      ? "Live audio streams securely to Sarvam AI. Capture is capped at 25 seconds."
      : "Sarvam realtime is unavailable. The recording will be uploaded for transcription when you stop.";
  } catch (error) {
    isStarting = false; $("capture").disabled = false;
    stopRealtimeAudio(); realtimeSocket?.close(); stopAudio(); setCaptureButton(false); setStatus("Microphone unavailable", "warn"); $("hint").textContent = error.message || "Microphone permission is required.";
  }
}

function finishCapture() {
  setCaptureButton(false); stopRealtime(); stopAudio();
  if (recorder && recorder.state !== "inactive") {
    isProcessing = true; $("capture").disabled = true;
    setStatus(realtimeFailed ? "Sending capture to Sarvam…" : "Finalizing Sarvam transcript…", "busy"); setTranscriptMode("Processing", "busy"); recorder.stop();
  }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function processRecording() {
  const blob = new Blob(audioChunks, { type: recorder?.mimeType || "audio/webm" });
  recorder = null; audioChunks = [];
  try {
    if (realtimeReady && !realtimeFailed) {
      const ended = await new Promise((resolve) => {
        let timeout;
        const complete = (value) => { clearTimeout(timeout); resolveRealtimeEnd = null; resolve(value); };
        resolveRealtimeEnd = complete;
        if (realtimeSessionEnded) complete(true);
        else timeout = setTimeout(() => { realtimeFailed = true; complete(false); realtimeSocket?.close(); }, 7000);
      });
      if (!ended) realtimeFailed = true;
    }
    if (realtimeFailed || !finalized.length) {
      const wav = await recordingToWav(blob);
      const audioBase64 = await blobToBase64(wav);
      const transcriptResponse = await fetch("/api/transcribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ audioBase64, mimeType: "audio/wav" }) });
      const transcriptData = await transcriptResponse.json().catch(() => ({}));
      if (!transcriptResponse.ok) throw new Error(transcriptData.error || "Sarvam transcription failed.");
      if (!transcriptData.transcript) throw new Error("Sarvam did not detect any speech.");
      finalized = [transcriptData.transcript]; partial = ""; renderTranscript();
    }
    partial = "";
    const transcript = finalized.join(" ").trim();
    if (!transcript) throw new Error("Sarvam did not detect any speech.");
    renderTranscript();
    setStatus("Polishing with Groq…", "busy");
    const cleaned = await cleanAndSaveMemory(transcript);
    pendingMemory = "";
    $("retry-cleanup").hidden = true;
    finalized = [cleaned]; partial = ""; renderTranscript();
    setStatus("Saved on this device", ""); setTranscriptMode("Saved", "");
  } catch (error) {
    if (finalized.length && finalized.join(" ").trim()) {
      pendingMemory = finalized.join(" ").trim();
      $("retry-cleanup").hidden = false;
      setStatus("Not saved · cleanup needed", "warn");
      setTranscriptMode("Not saved · retry cleanup", "warn");
      $("hint").textContent = `${error.message || "Cleanup failed."} Your transcript is still shown here. Retry cleanup to save it.`;
    } else {
      setStatus(error.message || "Cloud transcription failed.", "warn");
      setTranscriptMode("Not transcribed", "warn");
    }
  } finally {
    isProcessing = false;
    $("capture").disabled = false;
  }
}

async function loadSummary() {
  const button = $("refresh-summary");
  button.disabled = true; button.textContent = "Refreshing…";
  const today = new Date().toLocaleDateString();
  const todaysMemories = demoMemories.filter((memory) => new Date(memory.created_at).toLocaleDateString() === today);
  $("summary-text").textContent = todaysMemories.length
    ? todaysMemories.map((memory) => `• ${memory.text}`).join("\n")
    : "No memories saved today. Add a voice or written memory and it will appear here.";
  button.disabled = false; button.textContent = "Refresh list ↗";
}

function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Saved earlier" : new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
}

function persistMemory(text) {
  const memory = { text, created_at: new Date().toISOString() };
  demoMemories.unshift(memory);
  try { localStorage.setItem(MEMORY_KEY, JSON.stringify(demoMemories)); }
  catch (_) { demoMemories.shift(); return false; }
  loadRecent(); return true;
}

function loadRecent() {
  const list = $("recent-list");
  $("memory-count").textContent = demoMemories.length ? `${demoMemories.length} saved` : "";
  list.replaceChildren();
  if (!demoMemories.length) { list.textContent = "Your saved memories will appear here."; return; }
  demoMemories.slice(0, 40).forEach((memory) => {
    const item = document.createElement("article"); item.className = "memory";
    const time = document.createElement("time"); time.textContent = formatTime(memory.created_at);
    const text = document.createElement("div"); text.textContent = memory.text;
    item.append(time, text); list.append(item);
  });
}

$("capture").addEventListener("click", () => isCapturing ? finishCapture() : startCapture());
$("refresh-summary").addEventListener("click", loadSummary);
$("chat-form").addEventListener("submit", (event) => {
  event.preventDefault(); const question = $("question").value.trim(); if (!question) return;
  const button = event.currentTarget.querySelector("button");
  button.disabled = true;
  $("answer").textContent = "Asking Groq…"; $("sources").replaceChildren();
  fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question, memories: demoMemories }) })
    .then(async (response) => { const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || "Groq chat failed."); return data; })
    .then((data) => { $("answer").textContent = data.answer; (data.sources || []).forEach((source) => { const chip = document.createElement("span"); chip.className = "source"; chip.textContent = `${formatTime(source.created_at)} · ${source.text}`; $("sources").append(chip); }); })
    .catch((error) => { $("answer").textContent = error.message || "Groq chat failed."; })
    .finally(() => { button.disabled = false; });
});
$("save-note").addEventListener("click", async () => {
  const input = $("note-text"), text = input.value.trim(); if (!text) return;
  const button = $("save-note"), status = $("note-status");
  button.disabled = true; button.textContent = "Cleaning with Groq…"; status.textContent = "";
  try {
    await cleanAndSaveMemory(text);
    input.value = ""; status.textContent = "Cleaned and saved on this device.";
  } catch (error) {
    status.textContent = `${error.message || "Cleanup failed."} Nothing was saved; retry when ready.`;
  } finally {
    button.disabled = false; button.textContent = "Clean & save";
  }
});

$("retry-cleanup").addEventListener("click", async () => {
  if (!pendingMemory || isCapturing || isProcessing) return;
  const button = $("retry-cleanup"), retryText = pendingMemory;
  button.disabled = true; button.textContent = "Cleaning with Groq…";
  setStatus("Retrying cleanup…", "busy");
  try {
    const cleaned = await cleanAndSaveMemory(retryText);
    if (pendingMemory === retryText) {
      pendingMemory = ""; button.hidden = true;
      finalized = [cleaned]; partial = ""; renderTranscript();
    }
    setStatus("Saved on this device", ""); setTranscriptMode("Saved", "");
    $("hint").textContent = "Groq cleaned the memory before it was saved on this device.";
  } catch (error) {
    setStatus("Not saved · cleanup needed", "warn"); setTranscriptMode("Not saved · retry cleanup", "warn");
    $("hint").textContent = `${error.message || "Cleanup failed."} Nothing was saved. Retry when ready.`;
  } finally {
    button.disabled = false; button.textContent = "Retry cleanup & save";
  }
});

async function loadStatus() {
  try {
    const data = await fetch("/api/status").then((response) => response.json());
    const configured = data.configured ?? (data.sarvam_configured && data.groq_configured);
    const missing = Array.isArray(data.missing) ? data.missing : [
      ...(!data.sarvam_configured ? ["SARVAM_API_KEY"] : []),
      ...(!data.groq_configured ? ["GROQ_API_KEY"] : []),
    ];
    const missingText = missing.length ? `Missing in this deployment: ${missing.join(", ")}.` : "";
    $("sarvam-key-status").textContent = configured
      ? "Cloud demo ready · Sarvam handles live transcription; Groq powers cleanup and chat. Memories stay in this browser."
      : missingText;
    setStatus(configured ? "Cloud demo ready" : "Demo needs setup", configured ? "" : "warn");
    $("hint").textContent = "Live audio streams securely to Sarvam. Groq answers questions about saved memories.";
  } catch (_) {
    setStatus("Demo API unavailable", "warn");
    $("sarvam-key-status").textContent = "The deployment could not reach /api/status. Check that this project is deployed from the repository root.";
  }
}

setStatus("Checking cloud demo…", "live");
$("hint").textContent = "Sarvam realtime transcription, local memories, and Groq chat.";
$("sarvam-key-status").textContent = "API keys are managed by the deployment owner and stay on the server.";
loadStatus();
loadRecent();

const landing = $("landing"), appScreen = $("app-screen");
const openApp = () => { landing.hidden = true; appScreen.hidden = false; window.scrollTo(0, 0); };
const showLanding = () => { appScreen.hidden = true; landing.hidden = false; closeMorePanel(); window.scrollTo(0, 0); };
document.querySelectorAll("[data-open-app]").forEach((button) => button.addEventListener("click", openApp));
document.querySelector("[data-show-landing]")?.addEventListener("click", (event) => { event.preventDefault(); showLanding(); });

const panel = $("more-panel"), backdrop = $("panel-backdrop");
function openMorePanel() { panel.classList.add("open"); panel.setAttribute("aria-hidden", "false"); backdrop.hidden = false; $("menu-toggle").setAttribute("aria-expanded", "true"); }
function closeMorePanel() { if (!panel) return; panel.classList.remove("open"); panel.setAttribute("aria-hidden", "true"); if (backdrop) backdrop.hidden = true; $("menu-toggle")?.setAttribute("aria-expanded", "false"); }
$("menu-toggle")?.addEventListener("click", openMorePanel); $("menu-close")?.addEventListener("click", closeMorePanel); backdrop?.addEventListener("click", closeMorePanel);
document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeMorePanel(); });

// ---------- ambient node network ----------
const cv = document.getElementById("mesh");
const ctx = cv.getContext("2d");
const INK = "#16171c", ACCENT = "#2b4eff", MUTED = "#8b877a";
const NAMES = ["natural", "speech", "hindi", "english", "40+ languages", "friends", "germam", "french", "spanish", "qwen"];
let W = 0, H = 0, DPR = 1, pts = [], pulses = [], rings = [];
const EXTRA = ["you", "friend1", "firend2", "dost", "dad", "mum", "song", "model", "ASR", "VAD"];
let mouse = { x: -1e4, y: -1e4 }, resizeT = null, avoid = { x: 0, y: 0, w: 0, h: 0 };
const LINK = () => (W < 860 ? 120 : 160);
const inCopy = (x, y) => x > avoid.x && x < avoid.x + avoid.w && y > avoid.y && y < avoid.y + avoid.h;
function resize() {
  DPR = Math.min(devicePixelRatio || 1, innerWidth < 860 ? 1.5 : 2); W = innerWidth; H = innerHeight; cv.width = W * DPR; cv.height = H * DPR; ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  const cr = document.querySelector(".copy h1").getBoundingClientRect(), pad = W < 860 ? 10 : 20; avoid = { x: cr.left - pad, y: cr.top - pad, w: cr.width + 2 * pad, h: cr.height + 2 * pad };
  const n = Math.round(W * H / (W < 860 ? 16000 : 17000)), nLit = Math.min(NAMES.length, W < 860 ? 6 : 9), names = NAMES.slice().sort(() => Math.random() - .5); pts = []; pulses = [];
  for (let i = 0; i < n; i++) { const lit = i < nLit; let x = Math.random() * W, y = Math.random() * H; for (let k = 0; lit && inCopy(x, y) && k < 30; k++) { x = Math.random() * W; y = Math.random() * H; } pts.push({ x, y, vx: (Math.random() - .5) * .12, vy: (Math.random() - .5) * .12, r: 1.2 + Math.random() * 1.6, lit, label: lit ? names[i] : null, ph: Math.random() * 6.28 }); }
  pts.sort(() => Math.random() - .5);
}
addEventListener("resize", () => { clearTimeout(resizeT); resizeT = setTimeout(resize, 120); });
function physics(now) {
  for (const p of pts) { if (p.lit && inCopy(p.x, p.y)) { const cx = avoid.x + avoid.w / 2, cy = avoid.y + avoid.h / 2; p.vx += (p.x - cx) * .0006; p.vy += (p.y - cy) * .0006; p.vx = Math.max(-.5, Math.min(.5, p.vx)); p.vy = Math.max(-.5, Math.min(.5, p.vy)); } p.x += p.vx; p.y += p.vy; if (p.x < -20) p.x = W + 20; if (p.x > W + 20) p.x = -20; if (p.y < -20) p.y = H + 20; if (p.y > H + 20) p.y = -20; }
  if (Math.random() < .035 && pulses.length < (W < 860 ? 4 : 7)) { const lit = pts.filter(p => p.lit); if (lit.length > 1) { const a = lit[Math.floor(Math.random() * lit.length)]; let b = lit[Math.floor(Math.random() * lit.length)]; if (b === a) b = lit[(lit.indexOf(a) + 1) % lit.length]; sendLight(a, b); } }
  for (let i = rings.length - 1; i >= 0; i--) { rings[i].t += .018; if (rings[i].t >= 1) rings.splice(i, 1); }
  for (let i = pulses.length - 1; i >= 0; i--) { const pu = pulses[i], a = pu.path[pu.i], b = pu.path[pu.i + 1], len = Math.max(20, Math.hypot(a.x - b.x, a.y - b.y)); pu.t += 2.6 / len; if (pu.t >= 1) { pu.t = 0; pu.i++; if (pu.i >= pu.path.length - 1) pulses.splice(i, 1); } }
}
function sendLight(a, b) { const path = [a]; let cur = a; const seen = new Set([a]); for (let hop = 0; hop < 14 && cur !== b; hop++) { let best = null, bd = Math.hypot(cur.x - b.x, cur.y - b.y); for (const q of pts) { if (seen.has(q) || (q !== b && inCopy(q.x, q.y))) continue; const d = Math.hypot(cur.x - q.x, cur.y - q.y); if (d > LINK() * 1.3) continue; const dt = Math.hypot(q.x - b.x, q.y - b.y); if (dt < bd) { bd = dt; best = q; } } if (!best) break; path.push(best); seen.add(best); cur = best; } if (path.length > 1) pulses.push({ path, i: 0, t: 0 }); }
document.addEventListener("pointerdown", (e) => { if (scrollY >= H || e.target.closest("a, button, input, .modal, #demo")) return; const used = new Set(pts.filter(p => p.label).map(p => p.label)); const label = [...NAMES, ...EXTRA].find(n => !used.has(n)) || "human " + (used.size + 1); const p = { x: e.clientX, y: e.clientY, vx: (Math.random() - .5) * .12, vy: (Math.random() - .5) * .12, r: 2.2, lit: true, label, ph: Math.random() * 6.28, born: performance.now() }; pts.push(p); rings.push({ x: p.x, y: p.y, t: 0 }); const near = pts.filter(q => q.lit && q !== p).sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y)).slice(0, 2); near.forEach((q, i) => setTimeout(() => sendLight(q, p), 250 + i * 500)); });
function draw(now) {
  ctx.clearRect(0, 0, W, H); const px = mouse.x - W / 2, py = mouse.y - H / 2, GS = W < 860 ? 27 : 19, gx0 = -((px * .016) % GS), gy0 = -((py * .016) % GS); ctx.fillStyle = INK;
  for (let gx = gx0 - GS; gx < W + GS; gx += GS) for (let gy = gy0 - GS; gy < H + GS; gy += GS) { const dx = gx - mouse.x, dy = gy - mouse.y, d = Math.hypot(dx, dy); let x = gx, y = gy, a = .14, r = .9; if (d < 200 && d > .1) { const f = 1 - d / 200; x += dx / d * f * f * 20; y += dy / d * f * f * 20; a = .14 + f * .22; r = .9 + f * .6; } ctx.globalAlpha = a; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill(); }
  ctx.globalAlpha = 1; const L = LINK(); ctx.lineWidth = 1;
  for (let i = 0; i < pts.length; i++) { const a = pts[i]; for (let j = i + 1; j < pts.length; j++) { const b = pts[j], d = Math.hypot(a.x - b.x, a.y - b.y); if (d > L) continue; const k = 1 - d / L; ctx.strokeStyle = a.lit && b.lit ? ACCENT : INK; ctx.globalAlpha = k * (a.lit && b.lit ? .22 : .09); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); } const dm = Math.hypot(a.x - mouse.x, a.y - mouse.y); if (dm < L * 1.1) { ctx.strokeStyle = ACCENT; ctx.globalAlpha = (1 - dm / (L * 1.1)) * .35; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(mouse.x, mouse.y); ctx.stroke(); } }
  ctx.globalAlpha = 1;
  for (const pu of pulses) { const a = pu.path[pu.i], b = pu.path[pu.i + 1], x = a.x + (b.x - a.x) * pu.t, y = a.y + (b.y - a.y) * pu.t; ctx.strokeStyle = ACCENT; ctx.lineWidth = 1.2; ctx.globalAlpha = .45; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(x, y); ctx.stroke(); ctx.globalAlpha = .14; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(b.x, b.y); ctx.stroke(); ctx.globalAlpha = 1; ctx.lineWidth = 1; const g = ctx.createRadialGradient(x, y, 0, x, y, 14); g.addColorStop(0, "rgba(43,78,255,.7)"); g.addColorStop(1, "rgba(43,78,255,0)"); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, 14, 0, 7); ctx.fill(); ctx.fillStyle = ACCENT; ctx.beginPath(); ctx.arc(x, y, 2.6, 0, 7); ctx.fill(); }
  for (const r of rings) { ctx.strokeStyle = ACCENT; ctx.globalAlpha = (1 - r.t) * .6; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.arc(r.x, r.y, 6 + r.t * 70, 0, 7); ctx.stroke(); }
  ctx.globalAlpha = 1; ctx.lineWidth = 1;
  for (const p of pts) { if (p.lit) { const glow = .55 + .45 * Math.sin(now / 900 + p.ph), g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 16); g.addColorStop(0, `rgba(43,78,255,${.28 * glow})`); g.addColorStop(1, "rgba(43,78,255,0)"); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p.x, p.y, 16, 0, 7); ctx.fill(); ctx.fillStyle = ACCENT; ctx.globalAlpha = .6 + .4 * glow; ctx.beginPath(); ctx.arc(p.x, p.y, p.r + .6, 0, 7); ctx.fill(); if (p.label && !inCopy(p.x, p.y)) { ctx.font = "10px JetBrains Mono, monospace"; ctx.textAlign = "left"; ctx.fillStyle = MUTED; ctx.globalAlpha = .55 + .35 * glow; ctx.fillText(p.label, p.x + 9, p.y + 3.5); } } else { ctx.fillStyle = INK; ctx.globalAlpha = .28; ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 7); ctx.fill(); } ctx.globalAlpha = 1; }
}
let running = true;
function loop(now) { if (running && !landing.hidden && scrollY < H) { physics(now); draw(now); } requestAnimationFrame(loop); }
document.addEventListener("visibilitychange", () => { running = !document.hidden; }); addEventListener("mousemove", (e) => { mouse = { x: e.clientX, y: e.clientY }; }); addEventListener("mouseleave", () => { mouse = { x: -1e4, y: -1e4 }; });
resize(); requestAnimationFrame(loop);
