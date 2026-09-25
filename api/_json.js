export async function readJson(request) {
  if (request.body && typeof request.body === "object") return request.body;
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

export function methodNotAllowed(response, allowed = "POST") {
  response.setHeader("Allow", allowed);
  return response.status(405).json({ error: "Method not allowed" });
}

export function requireEnv(response, name) {
  if (!String(process.env[name] || "").trim()) {
    response.status(503).json({ error: `The demo is not configured: ${name} is missing.` });
    return false;
  }
  return true;
}

export async function groqRequest(messages, maxCompletionTokens = 700) {
  const result = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      model: "openai/gpt-oss-20b",
      messages,
      max_completion_tokens: maxCompletionTokens,
      temperature: 0.1,
      reasoning_effort: "low",
      include_reasoning: false,
    }),
  });
  const payload = await result.json().catch(() => ({}));
  if (!result.ok) {
    const detail = payload?.error?.message || "Groq returned an error.";
    throw new Error(`Groq request failed (${result.status}): ${detail}`);
  }
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw new Error("Groq returned an empty response.");
  return content.trim();
}
