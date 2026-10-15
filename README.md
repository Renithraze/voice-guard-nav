# Voice Key

Project Prompt: Voice Guard — AI Voice Authentication & Navigation Assistant

Build an advanced web-based "Voice Guard" system that combines speaker verification (voice biometrics) with a conversational AI assistant to authenticate a user and navigate them to the next page/section of a website or app.

Core Requirements

1. Voice Enrollment & Authentication (Speaker Verification)

Allow a user to enroll their voice by recording 2–3 short passphrase samples.

Extract voice embeddings (e.g., using MFCC features or a pretrained speaker-embedding model like Resemblyzer / SpeechBrain ECAPA-TDNN).

On login attempt, compare the live voice sample's embedding against the stored enrollment embedding using cosine similarity, with a configurable confidence threshold.

Reject spoofed/replayed audio using basic liveness checks (e.g., random challenge phrase instead of a fixed one).

2. Wake Word / Activation

Implement a lightweight wake-word detector ("Hey Guard" or similar) so the assistant only starts listening actively when triggered, rather than continuously streaming audio.

3. Conversational AI Assistant Layer

Once authenticated, route the user's spoken command through an NLP/intent-recognition layer (rule-based or LLM-powered) to understand navigation intents like "open dashboard," "go to next page," "take me to settings."

Use a Large Language Model (e.g., via API) to handle open-ended or ambiguous phrasing and map it to the closest valid navigation intent.

4. Voice-to-Navigation Action

On successful authentication + valid intent recognition, trigger the actual page navigation (e.g., window.location, React Router navigate(), or a backend redirect).

Provide audio + visual feedback ("Access granted, opening dashboard...") before navigating.

5. Security Considerations (Advanced Level)

Store voice embeddings, not raw audio, and encrypt them at rest.

Add rate-limiting / lockout after repeated failed voice-auth attempts.

Log authentication attempts with timestamps for audit purposes.

Consider multi-factor fallback (PIN/password) if voice confidence is borderline.

6. Tech Stack Suggestions

Frontend: React/HTML + Web Speech API or MediaRecorder API for capturing audio.

Backend: Python (FastAPI/Flask) for speaker verification model inference.

Speaker verification model: SpeechBrain, Resemblyzer, or pyannote-audio.

NLP/Assistant: Whisper for speech-to-text + an LLM API for intent parsing.

Database: Store embeddings + user metadata (e.g., PostgreSQL/MongoDB).

7. Deliverables

Working demo: enroll voice → speak wake word → speak command → authenticate → auto-navigate to next page.

Architecture diagram showing audio capture → STT → speaker verification → intent parsing → navigation trigger.

Report covering accuracy/false-acceptance-rate tradeoffs and security limitations of voice biometrics.

This project was built with [Lovable](https://lovable.dev).

**Live app**: https://voice-guard-nav.lovable.app

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/6734ac5f-6a1c-4d5c-80aa-80de5b8f5f2b).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
