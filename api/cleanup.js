import { groqRequest, methodNotAllowed, readJson, requireEnv } from "./_json.js";

export default async function handler(request, response) {
  if (request.method !== "POST") return methodNotAllowed(response);
  if (!requireEnv(response, "GROQ_API_KEY")) return;
  try {
    const { text } = await readJson(request);
    const original = typeof text === "string" ? text.trim() : "";
    if (!original || original.length > 10_000) return response.status(400).json({ error: "Memory text is required." });
    const cleaned = await groqRequest([
      { role: "system", content: "Rewrite the speech or note as one polished, natural memory sentence or short paragraph. Fix spelling, punctuation, capitalization, grammar, and fragmented phrasing. Preserve every fact, name, date, time, number, place, and technical term exactly. Never invent, infer, summarize, or add facts. If the wording is already correct, return it with normal polished punctuation. Return only the rewritten memory, with no explanation or quotation marks." },
      { role: "user", content: `Raw memory:\n${original}\n\nPolished memory:` },
    ], 512);
    return response.status(200).json({ text: cleaned });
  } catch (error) {
    return response.status(502).json({ error: error.message || "Groq cleanup failed." });
  }
}
