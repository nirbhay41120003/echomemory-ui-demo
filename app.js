let stream, recorder, audioChunks = [], timerInterval, modelPoll, isCapturing = false;
let activeAsr = "sarvam_ai";
let activeLlm = "groq_gpt_oss_20b";
let finalized = [], partial = "", captureSaveFailed = false;
const demoMemories = JSON.parse(localStorage.getItem("echomemory-demo-memories") || "[]");
const $ = (id) => document.getElementById(id);

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

function downsample(input, inputRate, outputRate = 16000) {
  if (inputRate === outputRate) return input.slice();
  const ratio = inputRate / outputRate;
  const length = Math.round(input.length / ratio);
  const output = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.min(Math.floor((index + 1) * ratio), input.length);
    let sum = 0;
    for (let sample = start; sample < end; sample += 1) sum += input[sample];
    output[index] = sum / Math.max(1, end - start);
  }
  return output;
}

function rootMeanSquare(samples) {
  let total = 0;
  for (let index = 0; index < samples.length; index += 1) total += samples[index] * samples[index];
  return Math.sqrt(total / samples.length);
}

function stopAudio() {
  if (stream) { stream.getTracks().forEach((track) => track.stop()); stream = null; }
  clearInterval(timerInterval);
}

function startTimer() {
  const started = Date.now();
  $("timer").textContent = "00:00";
  timerInterval = setInterval(() => {
    $("timer").textContent = new Date(Date.now() - started).toISOString().slice(14, 19);
  }, 1000);
}

async function startCapture() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
    recorder = new MediaRecorder(stream, { mimeType });
    audioChunks = [];
    recorder.addEventListener("dataavailable", (event) => { if (event.data.size) audioChunks.push(event.data); });
    recorder.addEventListener("stop", processRecording, { once: true });
    recorder.start();
    finalized = []; partial = ""; captureSaveFailed = false;
    renderTranscript(); startTimer(); setCaptureButton(true); setStatus("Listening with Sarvam", "live"); setTranscriptMode("Listening", "live");
    $("hint").textContent = "Sarvam AI will transcribe this capture, then Groq will polish it.";
  } catch (error) {
    stopAudio(); setStatus("Microphone unavailable", "warn"); $("hint").textContent = error.message || "Microphone permission is required.";
  }
}

function finishCapture() {
  setCaptureButton(false); stopAudio();
  if (recorder && recorder.state !== "inactive") {
    setStatus("Transcribing with Sarvam…", "busy"); setTranscriptMode("Processing", "busy"); recorder.stop();
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
    const audioBase64 = await blobToBase64(blob);
    const mimeType = blob.type.split(";", 1)[0] || "audio/webm";
    const transcriptResponse = await fetch("/api/transcribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ audioBase64, mimeType }) });
    const transcriptData = await transcriptResponse.json();
    if (!transcriptResponse.ok) throw new Error(transcriptData.error || "Sarvam transcription failed.");
    if (!transcriptData.transcript) throw new Error("Sarvam did not detect any speech.");
    finalized = [transcriptData.transcript]; partial = ""; renderTranscript();
    setStatus("Polishing with Groq…", "busy");
    const cleanupResponse = await fetch("/api/cleanup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: transcriptData.transcript }) });
    const cleanupData = await cleanupResponse.json();
    if (!cleanupResponse.ok) throw new Error(cleanupData.error || "Groq cleanup failed.");
    finalized = [cleanupData.text]; partial = ""; renderTranscript(); addDemoMemory(cleanupData.text);
    setStatus("Saved with Groq", ""); setTranscriptMode("Saved", "");
  } catch (error) {
    captureSaveFailed = true; setStatus(error.message || "Cloud capture failed.", "warn");
    setTranscriptMode(finalized.length ? "Transcribed" : "Not saved", "warn");
  }
}

async function loadSummary() {
  const button = $("refresh-summary");
  button.disabled = true; button.textContent = "Refreshing…";
  $("summary-text").textContent = demoMemories.length
    ? `You have ${demoMemories.length} saved demo memor${demoMemories.length === 1 ? "y" : "ies"}.`
    : "This UI preview keeps memories only in this browser.";
  button.disabled = false; button.textContent = "Refresh summary ↗";
}

function formatTime(value) {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function addDemoMemory(text) {
  demoMemories.unshift({ text, created_at: new Date().toISOString() });
  localStorage.setItem("echomemory-demo-memories", JSON.stringify(demoMemories));
  loadRecent();
}

function loadRecent() {
  const list = $("recent-list");
  $("memory-count").textContent = demoMemories.length ? `${demoMemories.length} saved` : "";
  list.replaceChildren();
  if (!demoMemories.length) { list.textContent = "Your saved memories will appear here."; return; }
  demoMemories.slice(0, 9).forEach((memory) => {
    const item = document.createElement("article"); item.className = "memory";
    const time = document.createElement("time"); time.textContent = formatTime(memory.created_at);
    const text = document.createElement("div"); text.textContent = memory.text;
    item.append(time, text); list.append(item);
  });
}

function formatBytes(bytes) {
  if (!bytes) return "Preparing…";
  const units = ["B", "KB", "MB", "GB"], power = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** power).toFixed(power ? 1 : 0)} ${units[power]}`;
}

async function beginModelDownload(model) {
  try {
    const response = await fetch("/api/models/download", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || "Download could not start.");
    await loadModels();
  } catch (error) {
    const target = model.startsWith("llm_") ? $("llm-list") : $("model-list");
    target.querySelector(`[data-model-error="${model}"]`)?.remove();
    const message = document.createElement("p"); message.className = "model-error"; message.dataset.modelError = model; message.textContent = error.message || "Download could not start."; target.prepend(message);
  }
}

async function activateModel(selected) {
  try {
    const response = await fetch("/api/models/select", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: selected }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || "This model runtime is not available.");
    activeAsr = data.active_asr;
    $("hint").textContent = selected === "asr_sarvam_ai" ? "Sarvam AI is ready for speech-to-text." : "Your selected local speech model is ready.";
    await Promise.all([loadStatus(), loadModels()]);
  } catch (error) { $("hint").textContent = error.message; setStatus("Model unavailable", "warn"); }
}

async function saveSarvamKey(event) {
  event.preventDefault();
  const input = $("sarvam-key"), button = event.currentTarget.querySelector("button"), key = input.value.trim();
  if (!key) return;
  button.disabled = true; button.textContent = "Demo configured";
  $("sarvam-key-status").textContent = "This demo uses the deployment's server-side Sarvam key. User keys are not accepted in the browser.";
  input.value = ""; setStatus("Cloud demo", "live");
  setTimeout(() => { button.disabled = false; button.textContent = "Save & use Sarvam"; }, 1200);
}

async function activateLlm(selected) {
  try {
    const response = await fetch("/api/models/select", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: selected }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || "This chat model could not be loaded.");
    activeLlm = data.active_llm;
    $("answer").textContent = "Groq chat is ready. Ask about your memories.";
    await Promise.all([loadStatus(), loadModels()]);
  } catch (error) {
    const message = document.createElement("p"); message.className = "model-error"; message.textContent = error.message || "This chat model could not be loaded.";
    $("llm-list").prepend(message); setStatus("Chat model unavailable", "warn");
  }
}

function modelButton(label, action, disabled = false) {
  const button = document.createElement("button"); button.className = "model-action"; button.type = "button"; button.textContent = label; button.disabled = disabled;
  button.addEventListener("click", action); return button;
}

async function loadModels() {
  try {
    const data = await fetch("/api/models").then((response) => response.json());
    const list = $("model-list"); list.replaceChildren();
    data.models.filter((model) => model.id.startsWith("asr_") && model.runtime !== "sarvam-api").forEach((model) => {
      const card = document.createElement("article"); card.className = `model${model.runtime === "sarvam-api" ? " sarvam-model" : ""}`;
      if (model.id === activeAsr) card.classList.add("active");
      const runtimeBlocked = model.status === "ready" && model.runtime !== "faster-whisper" && model.runtime !== "sarvam-api" && !model.runtime_ready;
      const top = document.createElement("div"); top.className = "model-top";
      const heading = document.createElement("div"); const title = document.createElement("h3"); title.textContent = model.label; const description = document.createElement("p"); description.textContent = `${model.description} ${model.size}`; heading.append(title, description);
      const status = document.createElement("span"); status.className = "model-status"; status.textContent = model.id === activeAsr ? "In use" : runtimeBlocked ? "Runtime needed" : model.runtime === "sarvam-api" && !model.configured ? "API key needed" : model.runtime === "sarvam-api" ? "Ready to use" : model.status === "ready" ? "Ready locally" : model.status.replace("_", " "); top.append(heading, status); card.append(top);
      if (model.status === "downloading" || model.status === "queued") {
        const progress = document.createElement("div"); progress.className = "model-progress"; const fill = document.createElement("i"); fill.style.width = model.total ? `${Math.min(100, model.received / model.total * 100)}%` : "8%"; progress.append(fill);
        const detail = document.createElement("div"); detail.className = "model-detail"; const file = document.createElement("span"); file.textContent = model.file || "Waiting…"; const bytes = document.createElement("span"); bytes.textContent = model.total ? `${formatBytes(model.received)} / ${formatBytes(model.total)}` : formatBytes(model.received); detail.append(file, bytes); card.append(progress, detail);
      } else if (model.status === "error" && !String(model.error || "").includes("disabled on Python 3.14")) { const error = document.createElement("p"); error.className = "model-error"; error.textContent = model.error; card.append(error); }
      if (model.runtime === "sarvam-api" && !model.configured) {
        const note = document.createElement("p"); note.className = "model-note"; note.textContent = "Save an API key above to enable this model."; card.append(note);
      } else if (model.runtime !== "faster-whisper") {
        const runtime = document.createElement("p"); runtime.className = "model-note";
        runtime.textContent = model.runtime_message || (model.runtime === "funasr-gguf" ? "Needs llama-funasr-cli from llama.cpp." : "Needs NVIDIA NeMo-Speech.cpp (nemo-speech).");
        card.append(runtime);
      }
      if (model.status === "ready" && !runtimeBlocked) card.append(modelButton(model.id === activeAsr ? "Currently using" : "Use this model", () => activateModel(model.id), model.id === activeAsr || data.running));
      else if (model.downloadable !== false) card.append(modelButton("Download model", () => beginModelDownload(model.id), data.running));
      else if (model.runtime !== "sarvam-api") { const setup = document.createElement("p"); setup.className = "model-note"; setup.textContent = "Place a converted .gguf file in this model folder to enable it."; card.append(setup); }
      list.append(card);
    });
    const llmList = $("llm-list"); llmList.replaceChildren();
    data.models.filter((model) => model.id.startsWith("llm_")).forEach((model) => {
      const card = document.createElement("article"); card.className = "model";
      if (model.id === activeLlm) card.classList.add("active");
      const top = document.createElement("div"); top.className = "model-top";
      const heading = document.createElement("div"); const title = document.createElement("h3"); title.textContent = model.label; const description = document.createElement("p"); description.textContent = `${model.description} ${model.size}`; heading.append(title, description);
      const runtimeBlocked = model.runtime_ready === false;
      const status = document.createElement("span"); status.className = "model-status"; status.textContent = model.id === activeLlm ? "In use" : runtimeBlocked ? "Runtime needed" : model.status === "ready" ? "Ready locally" : model.status.replace("_", " "); top.append(heading, status); card.append(top);
      if (model.status === "downloading" || model.status === "queued") {
        const progress = document.createElement("div"); progress.className = "model-progress"; const fill = document.createElement("i"); fill.style.width = model.total ? `${Math.min(100, model.received / model.total * 100)}%` : "8%"; progress.append(fill); card.append(progress);
        const detail = document.createElement("div"); detail.className = "model-detail"; detail.textContent = model.file || "Preparing download…"; card.append(detail);
      } else if (model.status === "error") { const error = document.createElement("p"); error.className = "model-error"; error.textContent = model.error; card.append(error); }
      if (runtimeBlocked) { const runtime = document.createElement("p"); runtime.className = "model-note"; runtime.textContent = "Runtime will be checked when you select this model. Extractive answers remain available as a fallback."; card.append(runtime); }
      const downloadedChat = model.runtime === "llama-cpp" && (model.downloaded || model.status === "error");
      if (model.status === "ready" || downloadedChat) card.append(modelButton(model.id === activeLlm ? "Currently using" : "Use this model", () => activateLlm(model.id), model.id === activeLlm || data.running));
      else if (!runtimeBlocked && model.status !== "ready") card.append(modelButton("Download model", () => beginModelDownload(model.id), data.running));
      llmList.append(card);
    });
    if (data.running && !modelPoll) modelPoll = setInterval(loadModels, 600);
    if (!data.running && modelPoll) { clearInterval(modelPoll); modelPoll = null; loadStatus(); }
  } catch (_) { $("model-list").textContent = "Model setup is unavailable while the local server is offline."; }
}

$("capture").addEventListener("click", () => isCapturing ? finishCapture() : startCapture());
$("refresh-summary").addEventListener("click", loadSummary);
$("chat-form").addEventListener("submit", (event) => {
  event.preventDefault(); const question = $("question").value.trim(); if (!question) return;
  $("answer").textContent = "Asking Groq…"; $("sources").replaceChildren();
  fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question, memories: demoMemories }) })
    .then(async (response) => { const data = await response.json(); if (!response.ok) throw new Error(data.error || "Groq chat failed."); return data; })
    .then((data) => { $("answer").textContent = data.answer; data.sources.forEach((source) => { const chip = document.createElement("span"); chip.className = "source"; chip.textContent = `${formatTime(source.created_at)} · ${source.text}`; $("sources").append(chip); }); })
    .catch((error) => { $("answer").textContent = error.message || "Groq chat failed."; });
});
$("save-note").addEventListener("click", async () => {
  const input = $("note-text"), text = input.value.trim(); if (!text) return;
  $("save-note").textContent = "Polishing with Groq…";
  try {
    const response = await fetch("/api/cleanup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || "Groq cleanup failed.");
    addDemoMemory(data.text); input.value = ""; $("save-note").textContent = "Saved with Groq";
  } catch (error) { $("save-note").textContent = error.message || "Could not save"; }
  setTimeout(() => { $("save-note").textContent = "Save locally"; }, 1600);
});

async function loadStatus() {
  try {
    const data = await fetch("/api/status").then((response) => response.json());
    activeAsr = data.active_asr || "sarvam_ai"; activeLlm = data.active_llm || "groq_gpt_oss_20b";
    const configured = data.configured ?? (data.sarvam_configured && data.groq_configured);
    const missing = Array.isArray(data.missing) ? data.missing : [
      ...(!data.sarvam_configured ? ["SARVAM_API_KEY"] : []),
      ...(!data.groq_configured ? ["GROQ_API_KEY"] : []),
    ];
    const missingText = missing.length ? `Missing in this deployment: ${missing.join(", ")}.` : "";
    $("sarvam-key-status").textContent = configured
      ? "Cloud demo ready · Sarvam AI speech + Groq AI memory and chat. Keys remain on the Vercel server."
      : missingText;
    setStatus(configured ? "Cloud demo ready" : "Demo needs setup", configured ? "" : "warn");
    $("hint").textContent = "Cloud demo: Sarvam AI transcribes, Groq polishes and answers.";
  } catch (_) {
    setStatus("Demo API unavailable", "warn");
    $("sarvam-key-status").textContent = "The deployment could not reach /api/status. Check that this project is deployed from the repository root.";
  }
}

function setSarvamState(configured, current) {
  const title = document.querySelector(".sarvam-title");
  if (!title) return;
  let badge = $("sarvam-current");
  if (!badge) { badge = document.createElement("span"); badge.id = "sarvam-current"; title.append(badge); }
  badge.textContent = current ? "Currently using (cloud model)" : "Saved (cloud model)";
  badge.className = `sarvam-current${current ? " current" : ""}`;
  badge.hidden = !configured;
  const form = $("sarvam-form");
  if (!form) return;
  let change = $("sarvam-change");
  if (!change) {
    change = document.createElement("button"); change.id = "sarvam-change"; change.type = "button"; change.className = "sarvam-change"; change.textContent = "Change key";
    change.addEventListener("click", () => { form.hidden = false; change.hidden = true; $("sarvam-key")?.focus(); });
    form.parentElement.append(change);
  }
  let use = $("sarvam-use");
  if (!use) {
    use = document.createElement("button"); use.id = "sarvam-use"; use.type = "button"; use.className = "sarvam-use"; use.textContent = "Use Sarvam AI";
    use.addEventListener("click", async () => { use.disabled = true; use.textContent = "Switching…"; await activateModel("asr_sarvam_ai"); use.disabled = false; use.textContent = "Use Sarvam AI"; });
    form.parentElement.append(use);
  }
  form.hidden = configured && !change.dataset.editing;
  change.hidden = !configured;
  use.hidden = !configured || current;
}
$('sarvam-form')?.addEventListener('submit', saveSarvamKey);
setStatus("Checking cloud demo…", "live");
$("hint").textContent = "Cloud demo: Sarvam AI transcribes, Groq polishes and answers.";
$("model-list").textContent = "Sarvam AI is the default speech model for this cloud demo.";
$("llm-list").textContent = "Groq GPT-OSS 20B is the default chat and memory model for this cloud demo.";
$("sarvam-form")?.remove();
$("sarvam-key-status") && ($("sarvam-key-status").textContent = "Configured by the Vercel deployment owner. API keys are never entered in the demo.");
$("model-setup")?.querySelector("h2") && ($("model-setup").querySelector("h2").textContent = "Cloud demo setup");
$("model-setup")?.querySelector(".panel-section-heading + p") && ($("model-setup").querySelector(".panel-section-heading + p").textContent = "This demo uses Sarvam AI for speech and Groq for memory cleanup and chat. API keys stay on Vercel and are never entered in this browser.");
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
