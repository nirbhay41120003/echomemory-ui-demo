export default function handler(request, response) {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return response.status(405).json({ error: "Method not allowed" });
  }
  return response.status(200).json({
    demo: true,
    cloud_only: true,
    active_asr: "sarvam_ai",
    active_llm: "groq_gpt_oss_20b",
    sarvam_configured: Boolean(process.env.SARVAM_API_KEY),
    groq_configured: Boolean(process.env.GROQ_API_KEY),
  });
}
