import { methodNotAllowed, readJson, requireEnv } from "./_json.js";

export default async function handler(request, response) {
  if (request.method !== "POST") return methodNotAllowed(response);
  if (!requireEnv(response, "SARVAM_API_KEY")) return;
  try {
    const { audioBase64, mimeType = "audio/webm" } = await readJson(request);
    if (typeof audioBase64 !== "string" || !audioBase64) return response.status(400).json({ error: "Audio is required." });
    const audio = Buffer.from(audioBase64, "base64");
    if (!audio.length || audio.length > 4_000_000) return response.status(400).json({ error: "Audio is empty or too large for the demo." });

    const form = new FormData();
    form.append("file", new Blob([audio], { type: mimeType }), "capture.webm");
    form.append("model", "saaras:v3");
    const result = await fetch("https://api.sarvam.ai/speech-to-text", {
      method: "POST",
      headers: { "api-subscription-key": process.env.SARVAM_API_KEY },
      body: form,
    });
    const payload = await result.json().catch(() => ({}));
    if (!result.ok) throw new Error(payload?.error?.message || `Sarvam returned HTTP ${result.status}.`);
    const transcript = String(payload.transcript || payload.text || "").trim();
    return response.status(200).json({ transcript });
  } catch (error) {
    return response.status(502).json({ error: error.message || "Sarvam transcription failed." });
  }
}
