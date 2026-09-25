# EchoMemory Cloud Demo

This Vercel demo uses cloud models only:

- Sarvam AI (`SARVAM_API_KEY`) transcribes microphone captures.
- Groq (`GROQ_API_KEY`) polishes memories and answers memory questions.

The browser never receives either key. Memories are demo data stored in the browser's local storage; the API keys must be configured as Vercel server-side environment variables.

## Vercel setup

1. Import this directory as a Vercel project.
2. Add `SARVAM_API_KEY` and `GROQ_API_KEY` under Project Settings > Environment Variables.
3. Redeploy after saving the variables.

Copy `.env.example` for local development. Never commit a real `.env` file.
