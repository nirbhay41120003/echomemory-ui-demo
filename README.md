# EchoMemory Cloud Demo

This Vercel demo uses cloud services for saved voice transcription and memory chat:

- Sarvam AI (`SARVAM_API_KEY`) streams live transcription over a secure server-side WebSocket proxy; the key never reaches the browser.
- Groq (`GROQ_API_KEY`) polishes memories and answers memory questions.

The browser never receives either key. Memories are demo data stored in the browser's local storage. Audio streams as 16 kHz mono PCM, with a 25-second capture limit. If realtime streaming is unavailable, the recording is converted to WAV and sent through the REST transcription fallback. Configure the API keys as Vercel server-side environment variables.

## Vercel setup

1. Import this directory as a Vercel project.
2. Add `SARVAM_API_KEY` and `GROQ_API_KEY` under Project Settings > Environment Variables. Select the environment you are deploying (`Production`, `Preview`, or both); local `.env` values are not uploaded to Vercel.
3. Redeploy after saving the variables. Environment changes only apply to new deployments.
4. Open `/api/status` on the deployed URL. It must return `configured: true`; otherwise its `missing` array identifies the variable that is not attached to that deployment.

Live transcription uses Vercel Functions WebSocket support. Use Vercel CLI 54.14.2 or newer with `vercel dev` when testing the realtime route locally.

Copy `.env.example` for local development. Never commit a real `.env` file.
