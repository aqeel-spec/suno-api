# Suno-API Documentation

## What This Project Is

A local API server that bridges your backend to Suno's AI music generation platform. Suno has no public API — this project uses browser automation and session authentication to interact with Suno on your behalf.

---

## Documentation Index

### [HOW_IT_WORKS.md](HOW_IT_WORKS.md)
**Start here.** Full system architecture — request flow, authentication, CAPTCHA bypass pipeline, payload construction, browser automation internals, environment variables, and AI integration patterns.

### [custom_generate_api.md](custom_generate_api.md)
**The main endpoint.** Complete reference for `POST /api/custom_generate` — every parameter, cURL examples in all formats, response schemas, how advanced options map to Suno's payload, and troubleshooting.

### [api_reference.md](api_reference.md)
**All endpoints.** Every route this server exposes: generate, extend_audio, concat, generate_stems, get, get_limit, get_aligned_lyrics, persona, and more. Includes request/response shapes and usage examples.

### [ai_integration_guide.md](ai_integration_guide.md)
**Connect your AI backend.** Python and Node.js code for the full generate → poll → extend pipeline. LLM system prompts for song writing, tags engineering guide, genre parameter lookup table, and production patterns.

---

## Quick Start

```bash
# 1. Install and run
pnpm install
pnpm dev

# 2. Test connection
curl http://localhost:3000/api/get_limit

# 3. Generate your first song
curl -X POST http://localhost:3000/api/custom_generate \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "[Verse 1]\nYour lyrics here\n\n[Chorus]\nYour chorus here",
    "tags": "pop acoustic uplifting",
    "title": "My First Song"
  }'

# 4. Poll until complete (replace with real IDs from step 3)
curl "http://localhost:3000/api/get?ids=<id1>,<id2>"
```

---

## Key Facts

| Thing | Value |
|---|---|
| Default model | `chirp-crow` (Suno v5 Pro) |
| Credits per generation | 10 credits → 2 clips |
| Generation time | 60–120 seconds |
| Max concurrent requests | 3 (configurable via `CONCURRENT_LIMIT`) |
| CAPTCHA solver | 2Captcha (requires `TWOCAPTCHA_KEY`) |
| Auth | Clerk.com JWT via `SUNO_COOKIE` |
