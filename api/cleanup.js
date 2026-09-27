import { groqRequest, methodNotAllowed, readJson, requireEnv } from "./_json.js";

export default async function handler(request, response) {
  if (request.method !== "POST") return methodNotAllowed(response);
  if (!requireEnv(response, "GROQ_API_KEY")) return;
  try {
    const { text } = await readJson(request);
    const original = typeof text === "string" ? text.trim() : "";
    if (!original || original.length > 10_000) return response.status(400).json({ error: "Memory text is required." });
    const cleaned = await groqRequest([
      { role: "system", content: "You edit short personal memories transcribed from speech or typed by a user. Produce one clear, natural memory while keeping the user's meaning and all supported details. Correct likely speech-recognition mistakes only when the intended word is clear; fix spelling, capitalization, punctuation, grammar, and fragments; remove filler words, repeated words, and abandoned false starts when they add no meaning. Preserve names, dates, times, numbers, places, technical terms, uncertainty, and intent. Do not summarize, infer, add facts, or answer questions contained in the text. If it is already clear, make only necessary corrections. Return a JSON object with exactly one string field named `text`. The field must contain only the finished memory, with no preface, explanation, or quotation marks." },
      { role: "user", content: `Clean this memory for saving:\n<raw_memory>\n${original}\n</raw_memory>\n\nReturn the cleaned memory in the required JSON format.` },
    ], 1024, { type: "json_object" });
    let parsed;
    try { parsed = JSON.parse(cleaned); }
    catch (_) { throw new Error("Groq returned an invalid cleanup response."); }
    if (!parsed || typeof parsed.text !== "string") throw new Error("Groq returned no cleaned memory text.");
    const cleanedText = parsed.text.trim();
    if (!cleanedText || cleanedText.length > 10_000) throw new Error("Groq did not return a usable cleaned memory.");
    return response.status(200).json({ text: cleanedText });
  } catch (error) {
    return response.status(502).json({ error: error.message || "Groq cleanup failed." });
  }
}
