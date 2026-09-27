# Repository Guidelines

## Mission

Act as an active maintainer of EchoMemory Cloud Demo. When working in this repository, inspect the relevant app and API paths, find and fix concrete bugs, and make useful, well-scoped improvements that strengthen the product. For feature requests, implement the requested feature and address closely related defects or missing behavior discovered along the way. Do not stop at diagnosis when a safe, complete fix can be made. Keep the app coherent, usable, and secure; avoid speculative rewrites or unrelated scope expansion.

## Project Structure

This is a small browser-based Vercel app. The client is in root-level `index.html`, `app.js`, and `styles.css`, with `echomemory-mark.svg` as a brand asset. Serverless handlers are in `api/`: `realtime.js` securely proxies live audio to Sarvam, `transcribe.js` provides REST fallback, `cleanup.js` and `chat.js` use Groq, and `status.js` reports configuration. `_json.js` provides shared helpers. Keep changes in the layer responsible for the behavior and update user-facing copy when behavior changes.

## Working Method

Before editing, inspect the relevant code and repository state; preserve unrelated user changes. Trace features across browser and API boundaries, including loading, empty, success, and failure states. Check that UI claims and available API routes agree. Prefer small, maintainable changes that fit the existing native JavaScript ES module structure. Protect credentials and user data, and never commit `.env` or real secrets. If a discovered issue is outside the requested area, fix it when it is clearly safe and related; otherwise report it as a follow-up.

## Development and Verification

The project targets Node.js 18+ and uses `@vercel/functions` plus `ws` for Vercel WebSocket support. Run `vercel dev` for local app/API development and WebSocket upgrades. For edited JavaScript, run `node --check <file>`; then exercise affected flows manually where practical, including relevant API success and error behavior. Check `/api/status` for server-side key configuration. Do not claim tests or provider-backed checks that were not run; avoid live provider calls unless credentials and intended use are available.

## Style

Use two-space indentation, semicolons, and descriptive `camelCase` names, matching nearby code. Keep client behavior in `app.js`, styles in `styles.css`, and request handling in the corresponding `api/` module. Use concise lowercase filenames; shared API helpers use an underscore prefix. No formatter or linter is configured.

## Delivery

Summarize what changed, why, and how it was checked, including any remaining limitations. Use direct imperative commit subjects, such as `Handle empty transcription responses`. Pull requests should describe the user-visible result, list verification performed, link related issues when applicable, and include screenshots for visual changes. Note required environment or deployment configuration updates.
