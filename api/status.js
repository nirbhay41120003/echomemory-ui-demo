export default function handler(request, response) {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return response.status(405).json({ error: "Method not allowed" });
  }
  const required = ["SARVAM_API_KEY", "GROQ_API_KEY"];
  const missing = required.filter((name) => !String(process.env[name] || "").trim());
  return response.status(200).json({
    demo: true,
    cloud_only: true,
    active_asr: "sarvam_ai",
    active_llm: "groq_gpt_oss_20b",
    configured: missing.length === 0,
    missing,
    sarvam_configured: !missing.includes("SARVAM_API_KEY"),
    groq_configured: !missing.includes("GROQ_API_KEY"),
  });
}
