import { experimental_upgradeWebSocket } from "@vercel/functions";
import WebSocket from "ws";

const SARVAM_REALTIME_URL = "wss://api.sarvam.ai/speech-to-text-realtime/ws";

export default {
  async fetch(request) {
  const origin = request.headers.get("origin");
  const requestUrl = new URL(request.url);
  if (!origin || new URL(origin).host !== requestUrl.host) {
    return new Response("Same-origin WebSocket connection required.", { status: 403 });
  }
  const apiKey = String(process.env.SARVAM_API_KEY || "").trim();
  if (!apiKey) return new Response("Sarvam is not configured.", { status: 503 });

  return experimental_upgradeWebSocket((client) => {
    const upstreamUrl = new URL(SARVAM_REALTIME_URL);
    upstreamUrl.search = new URLSearchParams({
      model: "saaras:v3-realtime",
      language_code: "auto",
      stream_type: "balanced",
      mode: "transcribe",
      endpointing: "vad",
      encoding: "linear16",
      sample_rate: "16000",
    }).toString();
    const upstream = new WebSocket(upstreamUrl, {
      headers: { "api-subscription-key": apiKey },
      perMessageDeflate: false,
    });
    let upstreamReady = false;
    let sessionEnded = false;

    const sendClient = (message) => {
      if (client.readyState === WebSocket.OPEN) client.send(message);
    };
    const sendError = (message) => sendClient(JSON.stringify({ event: "error", is_fatal: true, message }));

    upstream.once("open", () => {
      upstreamReady = true;
      sendClient(JSON.stringify({ event: "ready" }));
    });
    upstream.on("message", (data) => {
      const message = data.toString();
      sendClient(message);
      try { if (JSON.parse(message).event === "session.end") sessionEnded = true; } catch (_) {}
    });
    upstream.on("error", () => sendError("Could not connect to Sarvam realtime transcription."));
    upstream.once("close", (code) => {
      if (!sessionEnded) sendError(code === 1003 ? "Sarvam rejected the API key or account quota." : "Sarvam realtime connection closed unexpectedly.");
      if (client.readyState === WebSocket.OPEN) client.close(1000, "Transcription session ended");
    });

    client.on("message", (data, isBinary) => {
      if (!upstreamReady || upstream.readyState !== WebSocket.OPEN) return;
      if (isBinary) {
        upstream.send(JSON.stringify({ event: "audio_input", audio: data.toString("base64") }));
        return;
      }
      try {
        const event = JSON.parse(data.toString());
        if (event.event === "end") upstream.send(JSON.stringify({ event: "end" }));
      } catch (_) { sendError("Invalid realtime transcription message."); }
    });

    const closeUpstream = () => {
      if (upstream.readyState === WebSocket.OPEN) upstream.close();
      else if (upstream.readyState === WebSocket.CONNECTING) upstream.terminate();
    };
    client.once("close", closeUpstream);
    client.once("error", closeUpstream);
  });
  },
};
