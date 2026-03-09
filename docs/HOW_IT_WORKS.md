# How Suno-API Works — Full System Architecture

> **Purpose:** This document explains every layer of the system — from your HTTP request to the actual song being generated on Suno's servers — so you can connect your backend cleanly and extend it with AI.

---

## Table of Contents

1. [Overview](#overview)
2. [System Architecture Diagram](#system-architecture-diagram)
3. [Authentication Layer](#authentication-layer)
4. [CAPTCHA Bypass Pipeline](#captcha-bypass-pipeline)
5. [Custom Song Generation — Complete Flow](#custom-song-generation--complete-flow)
6. [Payload Construction Deep Dive](#payload-construction-deep-dive)
7. [How Vocal Gender Works](#how-vocal-gender-works)
8. [Advanced Options — What They Do](#advanced-options--what-they-do)
9. [Concurrency & Session Management](#concurrency--session-management)
10. [Environment Variables Reference](#environment-variables-reference)
11. [All API Endpoints](#all-api-endpoints)
12. [Polling & Async Flow](#polling--async-flow)
13. [Error Handling Guide](#error-handling-guide)
14. [AI Integration Patterns](#ai-integration-patterns)

---

## Overview

`suno-api` is a **Next.js reverse-proxy bridge** between your backend and Suno's private API. Suno does not provide a public API — their web app makes internal REST calls that are protected by:

1. **Clerk.com session tokens** (JWT, auto-refreshed)
2. **CAPTCHA challenges** (Cloudflare Turnstile + hCaptcha) on every generation request

This project automates Suno's browser-based flow using **Playwright** to solve CAPTCHAs and intercept CAPTCHA tokens, then re-uses those tokens when calling Suno's internal API directly from your server.

**Result:** You call `POST /api/custom_generate` on your local server → get back song clip IDs and metadata → poll `/api/get?ids=...` until complete.

---

## System Architecture Diagram

```
YOUR BACKEND
     │
     │  POST /api/custom_generate  (JSON body)
     ▼
┌─────────────────────────────────────────────┐
│           Next.js  (suno-api)               │
│                                             │
│  route.ts  ──►  SunoApi.custom_generate()  │
│                        │                   │
│                         ▼                  │
│              generateSongs()               │
│             ┌─────────────────┐            │
│             │  keepAlive()    │            │  ← refresh Clerk JWT every 30s
│             │  getCaptcha()   │            │  ← launch browser, solve CAPTCHA
│             │  buildPayload() │            │  ← construct Suno POST body
│             │  POST to Suno   │            │  ← call Suno's internal API
│             └─────────────────┘            │
└─────────────────────────────────────────────┘
     │
     │  CAPTCHA branch (runs in parallel)
     ▼
┌───────────────────────────────────────────────────┐
│     Playwright Browser  (Chromium / Firefox)      │
│                                                   │
│  1. Navigate → https://suno.com/create            │
│  2. Click Advanced tab                            │
│  3. Click style chips (to enable Create btn)      │
│  4. Intercept POST /api/generate/v2-web/          │
│     → extract: JWT token, CAPTCHA token,          │
│                model name, endpoint path          │
│  5. Close browser (or keep open for reuse)        │
└───────────────────────────────────────────────────┘
     │
     │  CAPTCHA token  ───────────────────────────►
     ▼
┌─────────────────────────────────────────────┐
│           2Captcha Service                  │
│  (only used if CAPTCHA iframe appears)      │
│  • hCaptcha  → solver.coordinates()        │
│  • Turnstile → solver.cloudflareTurnstile() │
└─────────────────────────────────────────────┘
     │
     │  token resolved
     ▼
┌─────────────────────────────────────────────┐
│     Suno Internal API                       │
│  POST https://studio-api.prod.suno.com      │
│       /api/generate/v2-web/                 │
│                                             │
│  ← Returns: clip IDs, status="submitted"   │
└─────────────────────────────────────────────┘
     │
     │  Response returned to YOUR BACKEND
     ▼
Poll GET /api/get?ids=<clip1>,<clip2>
     until status == "complete"
     then use audio_url + video_url
```

---

## Authentication Layer

### How Suno Authenticates Requests

Every request to `studio-api.prod.suno.com` requires two things:

| Header / Field | Source | Description |
|---|---|---|
| `Authorization: Bearer <JWT>` | Clerk session | Short-lived JWT (expires every ~1hr) |
| `token` (POST body field) | CAPTCHA solve | Cloudflare Turnstile / hCaptcha token |

### How `suno-api` Gets the JWT

The JWT comes from **Clerk.com** (Suno's auth provider). The flow:

1. On startup, `init()` calls `getAuthToken()` → posts to `clerk.suno.com/v1/client` with the `__client` cookie to get the `last_active_session_id`
2. `keepAlive()` posts to `clerk.suno.com/v1/client/sessions/<sid>/tokens` → gets a fresh JWT
3. `keepAlive()` is called with a **30-second cooldown** — it auto-skips if called again within 30s to avoid Clerk rate limits
4. The JWT is stored in `this.currentToken` and auto-injected into every `axios` request via an interceptor

### Cookie Setup

Your `SUNO_COOKIE` in `.env` must contain ALL active Suno cookies from a logged-in browser session. Critical cookies:

| Cookie | Purpose |
|---|---|
| `__client` | Clerk refresh token — used to get session ID |
| `__session` | Current JWT session |
| `__client_uat` | Clerk client update token |
| `ajs_anonymous_id` | Used as Device-ID |

**Cookie lifetime:** Cookies last until the session expires (typically days to weeks). When expired, you must update `SUNO_COOKIE` with fresh cookies from your browser.

---

## CAPTCHA Bypass Pipeline

This is the most complex part of the system. Here is the complete decision tree:

```
getCaptcha(force=true/false)
│
├─► if !force: check /api/c/check — does Suno want CAPTCHA?
│     NO → return null (no token needed)
│     YES → fall through
│
└─► _solveCaptcha()
      │
      ├─► reuse existing browser? (BROWSER_KEEP_OPEN=true)
      │     YES → reuse page, unregister old route handlers
      │     NO  → launchBrowser() → new Chromium/Firefox context
      │           inject all cookies from SUNO_COOKIE
      │
      ├─► navigate to https://suno.com/create
      │
      ├─► close any popups / modals
      │
      ├─► click "Advanced" tab (or "Custom" — old label)
      │
      ├─► FORM SEEDING (enables Create button without typing in React)
      │   ├─► click Instrumental toggle (avoids broken lyrics textarea)
      │   └─► click up to 3 style chip buttons (aria-label="Add style: X")
      │         ↑ This is the KEY bypass — React style chips update state
      │           and enable the Create button without typing in inputs
      │
      ├─► register page.route() intercept on **/api/generate/**
      │   (captures: JWT, CAPTCHA token, model name, endpoint path)
      │
      ├─► wait for Create button to become enabled naturally
      │   (Turnstile invisible challenge completes in background)
      │
      ├─► click Create button
      │
      ├─► ROUTE INTERCEPT FIRES:
      │   ├─► token in POST body?
      │   │     YES → extract token, abort request, close browser → DONE ✅
      │   │
      │   │     NO (token=null) + BROWSER_FORCE_CAPTCHA=true + sitekey available
      │   │         → 2Captcha Turnstile direct solve → DONE ✅
      │   │
      │   │     NO + BROWSER_FORCE_CAPTCHA=false
      │   │         → trust session, return null → DONE ✅ (no CAPTCHA needed)
      │   │
      │   │     NO + sitekey missing → fall through to iframe detection
      │   │
      │   └─► detect CAPTCHA type from iframes:
      │         hCaptcha  → solve via 2Captcha coordinates API
      │         Turnstile → solve via 2Captcha cloudflareTurnstile API
      │
      └─► return captcha token (or null if no CAPTCHA required)
```

### Why Style Chips Instead of Typing?

Suno's Create button is controlled by React state. The form is a **controlled component** — React ignores direct DOM writes to `textarea.value`. Multiple approaches were tried:

| Approach | Result |
|---|---|
| `element.value = text` → `dispatchEvent('input')` | React's batched state update timing varies |
| `ClipboardEvent` paste simulation | Works sometimes, not reliably |
| React fiber `useState` dispatch | Works in most cases |
| **Click style chip buttons** | **Always works** ✅ — they directly update React state |

The style buttons have `aria-label="Add style: <genre>"` and update the internal tags state, which enables the Create button without touching the lyrics/prompt textarea.

---

## Custom Song Generation — Complete Flow

When you call `POST /api/custom_generate`:

```
1. route.ts receives JSON body
   └─► validates: prompt (required), tags (required), title (required)
   └─► extracts: vocal_gender, weirdness, style_influence, persona_id
   └─► builds AdvancedOptions object

2. sunoApi().custom_generate(prompt, tags, title, ...)
   └─► calls generateSongs(prompt, isCustom=true, tags, title, ...)

3. generateSongs():
   a. acquire requestSemaphore slot (respects CONCURRENT_LIMIT=3)
   b. keepAlive() → refresh JWT if >30s since last refresh
   c. build payload object (see Payload Construction below)
   d. apply AdvancedOptions to payload (see Advanced Options below)
   e. getCaptcha() → launch browser, solve CAPTCHA, get token
   f. add token to payload (if non-null)
   g. keepAlive() again (JWT may have staled during CAPTCHA)
   h. resolve model: caller arg → browser-captured → DEFAULT_MODEL
   i. resolve endpoint: browser-captured → '/api/generate/v2-web/'
   j. POST to studio-api.prod.suno.com/<endpoint>
   k. handle response: return AudioInfo[]

4. If wait_audio=true:
   └─► polls Suno's status endpoint every 2s up to 100s
   └─► returns when status="complete" (has audio_url)
   
5. If wait_audio=false (default):
   └─► returns immediately with status="submitted", audio_url=""
   └─► caller must poll GET /api/get?ids=...
```

---

## Payload Construction Deep Dive

This is the exact JSON body sent to `studio-api.prod.suno.com/api/generate/v2-web/`:

### Custom Mode (isCustom=true) — used by `/api/custom_generate`

```json
{
  "make_instrumental": false,
  "mv": "chirp-crow",
  "prompt": "[Verse 1]\nYour lyrics here...",
  "generation_type": "TEXT",
  "tags": "synthwave dreamy 80s, female vocals",
  "title": "Neon Dreams",
  "negative_tags": "country, metal, acoustic",
  "token": "0.AbCdEf...",
  "persona_id": "uuid-if-provided",
  "metadata": {
    "vocal_gender": "female",
    "control_sliders": {
      "weirdness_constraint": 0.70,
      "style_weight": 0.30
    }
  }
}
```

### Auto Mode (isCustom=false) — used by `/api/generate`

```json
{
  "make_instrumental": false,
  "mv": "chirp-crow",
  "prompt": "",
  "gpt_description_prompt": "A dreamy synthwave song about neon lights",
  "generation_type": "TEXT",
  "token": "0.AbCdEf..."
}
```

### Key Field Explanations

| Field | Type | Notes |
|---|---|---|
| `mv` | string | Model version. Captured from browser during CAPTCHA. Default: `chirp-crow` (v5 Pro) |
| `prompt` | string | Raw lyrics (for custom mode) OR empty string (for auto mode) |
| `gpt_description_prompt` | string | Plain-English description (auto mode only) |
| `tags` | string | Comma-separated style words. **This field determines vocal gender, genre, feel** |
| `negative_tags` | string | Styles to avoid. Added at top level |
| `token` | string | CAPTCHA token. Omitted entirely if null |
| `make_instrumental` | boolean | `true` = no vocals |
| `persona_id` | string | UUID of a Suno Persona for voice cloning |
| `metadata.vocal_gender` | `"male"` / `"female"` | Sent for informational purposes; Suno's model reads `tags` for actual decision |
| `metadata.control_sliders.weirdness_constraint` | 0.0–1.0 | Creativity level (0=conventional, 1=experimental) |
| `metadata.control_sliders.style_weight` | 0.0–1.0 | How strictly tags are followed |

---

## How Vocal Gender Works

**Critical insight:** Suno's AI model does **not** reliably use `metadata.vocal_gender` to choose the voice. The model reads the **`tags` field** text content to determine vocal style.

### What This API Does

When you pass `"vocal_gender": "male"`, the API automatically:

1. Appends `, male vocals` to the `tags` string
   - Input: `tags = "synthwave dreamy 80s"`
   - Output in payload: `tags = "synthwave dreamy 80s, male vocals"`
2. Also sets `metadata.vocal_gender = "male"` (for any future Suno use)

```typescript
// From SunoApi.ts — how vocal_gender is applied
if (advanced.vocal_gender) {
  if (isCustom && typeof payload.tags === 'string') {
    if (!payload.tags.toLowerCase().includes(advanced.vocal_gender)) {
      payload.tags = `${payload.tags}, ${advanced.vocal_gender} vocals`;
    }
  }
  payload.metadata.vocal_gender = advanced.vocal_gender;
}
```

### Best Practice for Reliable Vocal Gender

Include gender in `tags` directly:
```json
{
  "tags": "pop acoustic happy, male vocals",
  "vocal_gender": "male"
}
```

Even better — be specific in tags:
```json
{
  "tags": "indie pop, deep male baritone vocals, storytelling"
}
```

---

## Advanced Options — What They Do

### `weirdness` (0–100)

Controls how experimental/creative the generation is.

| Value | Effect |
|---|---|
| 0–20 | Very conventional, predictable structure |
| 30–50 | Balanced, mainstream sound |
| 60–80 | More unique, unexpected elements |
| 90–100 | Highly experimental, may break conventions |

**API sends:** `metadata.control_sliders.weirdness_constraint = value / 100`

### `style_influence` (0–100)

Controls how strictly the `tags` style words are followed vs. letting the AI interpret freely.

| Value | Effect |
|---|---|
| 0–20 | AI ignores tags mostly, generates freely |
| 40–60 | Balanced — tags guide but don't constrain |
| 70–100 | Tags are followed very strictly |

**API sends:** `metadata.control_sliders.style_weight = value / 100`

### `persona_id` (UUID string)

Uses a Suno Persona for consistent voice characteristics. A Persona is a voice style trained from existing Suno clips.

- Get persona UUIDs from `GET /api/persona`
- The persona overrides some tag-based vocal characteristics
- Compatible with `vocal_gender` — both can be set together

### `negative_tags` (string)

Styles the AI should actively avoid. Examples: `"autotune, heavy bass, screaming"`.

---

## Concurrency & Session Management

### Request Semaphore

All generation requests go through `AsyncSemaphore` with limit = `CONCURRENT_LIMIT` (default: 3):

```
Request 1 → acquires slot → generates
Request 2 → acquires slot → generates  
Request 3 → acquires slot → generates
Request 4 → WAITS until one slot frees
```

### CAPTCHA Mutex

Only ONE browser session runs at a time (enforced by `AsyncMutex`):

```
Request 1 & 2 fire at same time →
  Request 1 gets mutex → launches browser → solves CAPTCHA → returns token
  Request 2 waits → after Request 1 finishes mutex, checks if CAPTCHA still needed
    → if not needed (session still valid) → skips browser launch → saves time
```

### Browser Reuse (BROWSER_KEEP_OPEN=true)

When `BROWSER_KEEP_OPEN=true` AND `BROWSER_HEADLESS=false`:
- Browser stays open after CAPTCHA is solved
- Next request reuses the same page/context
- Saves ~5-10 seconds per request (no browser launch overhead)
- If browser crashes or is closed manually → auto-launches fresh

### JWT Keep-Alive (30-second Cooldown)

`keepAlive()` refreshes the Clerk JWT. It's called:
1. Before building the payload
2. After CAPTCHA solving (in case the browser took >1hr)

But it skips the refresh if called < 30 seconds since last refresh. This prevents Clerk rate-limiting when multiple requests fire quickly.

---

## Environment Variables Reference

```bash
# ── REQUIRED ─────────────────────────────────────────────────────────────────
SUNO_COOKIE=<paste all cookies from your logged-in suno.com session>
TWOCAPTCHA_KEY=<your 2captcha.com API key>

# ── BROWSER ──────────────────────────────────────────────────────────────────
BROWSER=chromium                  # or: firefox
BROWSER_HEADLESS=false            # true = no window (for servers), false = visible (for debugging)
BROWSER_KEEP_OPEN=true            # reuse browser across requests (only works if HEADLESS=false)
BROWSER_GHOST_CURSOR=false        # simulate natural mouse movement (slows things down)
BROWSER_LOCALE=en                 # browser locale (affects hCaptcha language)
BROWSER_FORCE_CAPTCHA=true        # always launch browser regardless of CAPTCHA check endpoint

# ── TIMEOUTS ─────────────────────────────────────────────────────────────────
SUNO_CAPTCHA_UI_TIMEOUT_MS=180000   # max wait for browser Create button to enable (ms)
SUNO_CAPTCHA_TOKEN_TIMEOUT_MS=180000 # max wait for CAPTCHA token from 2Captcha (ms)

# ── CONCURRENCY ──────────────────────────────────────────────────────────────
CONCURRENT_LIMIT=3               # max simultaneous generate requests

# ── CORS ─────────────────────────────────────────────────────────────────────
CORS_ALLOWED_ORIGINS=http://localhost:8000,http://localhost:3000

# ── DEBUGGING ────────────────────────────────────────────────────────────────
# SUNO_DEBUG_ARTIFACTS=true       # saves PNG + HTML on CAPTCHA failures to .suno-debug/
# SUNO_DEBUG_CAPTCHA_LOGS=true    # logs browser console + network errors during CAPTCHA
```

### When to Change Each Setting

| Setting | When to Change |
|---|---|
| `BROWSER_HEADLESS=false` | Debugging: see what the browser is doing |
| `BROWSER_HEADLESS=true` | Production / Docker deployments |
| `BROWSER_KEEP_OPEN=true` | Faster requests when running locally |
| `BROWSER_KEEP_OPEN=false` | Docker/server (headless must be true anyway) |
| `BROWSER_FORCE_CAPTCHA=true` | When generation fails without CAPTCHA (most cases) |
| `BROWSER_FORCE_CAPTCHA=false` | If Suno whitelists your IP / session |
| `CONCURRENT_LIMIT=1` | Single-user setups to avoid rate limits |
| `CONCURRENT_LIMIT=5` | Multi-user setups with Pro subscription |

---

## All API Endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/api/custom_generate` | Generate song with full control (lyrics + style) |
| `POST` | `/api/generate` | Generate song from AI description (simple mode) |
| `POST` | `/api/generate_lyrics` | Generate lyrics only (no audio) |
| `POST` | `/api/extend_audio` | Extend an existing clip |
| `POST` | `/api/concat` | Stitch clips together |
| `GET` | `/api/get?ids=<id1,id2>` | Poll clip status + get audio URLs |
| `GET` | `/api/get_limit` | Get remaining credits on the account |
| `POST` | `/api/generate_stems` | Extract vocals/instrumentals from a clip |
| `GET` | `/api/get_aligned_lyrics` | Get time-aligned lyrics for a clip |
| `GET` | `/api/clip?id=<id>` | Get single clip details |
| `GET` | `/api/persona` | List personas for voice cloning |

### Response Shape — `AudioInfo`

```typescript
interface AudioInfo {
  id: string;           // clip UUID — use this to poll
  title?: string;       // song title
  lyric?: string;       // full lyrics text
  audio_url?: string;   // MP3 stream URL (empty until complete)
  video_url?: string;   // MP4 video URL (empty until complete)
  image_url?: string;   // cover art URL
  created_at: string;   // ISO timestamp
  model_name: string;   // e.g. "chirp-crow"
  status: string;       // "submitted" | "queued" | "streaming" | "complete" | "error"
  tags?: string;        // style tags (reflects what was sent)
  negative_tags?: string;
  duration?: string;    // seconds (filled after completion)
  error_message?: string; // set when status="error"
}
```

---

## Polling & Async Flow

Generation takes **60–120 seconds**. The API returns immediately with `status="submitted"`. You must poll until `status="complete"`.

### Recommended Polling Strategy

```javascript
async function waitForSong(ids, maxWaitMs = 300000) {
  const start = Date.now();
  const interval = 5000; // poll every 5 seconds

  while (Date.now() - start < maxWaitMs) {
    const res = await fetch(`http://localhost:3000/api/get?ids=${ids.join(',')}`);
    const clips = await res.json();

    const allDone = clips.every(c => c.status === 'complete' || c.status === 'error');
    if (allDone) return clips;

    await new Promise(r => setTimeout(r, interval));
  }
  throw new Error('Timeout waiting for song generation');
}

// Usage:
const submitted = await fetch('http://localhost:3000/api/custom_generate', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ prompt: '...', tags: '...', title: '...' })
}).then(r => r.json());

const ids = submitted.map(c => c.id);
const completed = await waitForSong(ids);
console.log(completed[0].audio_url); // playable MP3
```

### Status Progression

```
submitted → queued → streaming → complete
                               ↘ error (check error_message)
```

### `wait_audio: true` Mode

If you pass `"wait_audio": true`, the API itself polls internally for up to ~100s and returns clips with `audio_url` filled. Good for low-traffic setups. Not recommended for production (ties up your HTTP connection).

---

## Error Handling Guide

| HTTP Status | Meaning | Fix |
|---|---|---|
| `400 Bad Request` | Missing required field | Add `prompt`, `tags`, or `title` |
| `500` — "CAPTCHA token could not be obtained" | Browser failed to solve CAPTCHA | Check `debug/` folder for screenshots |
| `500` — "Create button stayed disabled" | Style chips not found / form seeding failed | Suno UI may have changed — check `debug/05-after-create-click.html` |
| `500` — "Could not find Create/Generate button" | Suno redesigned their UI | Update button selectors in `SunoApi.ts` |
| `500` — Suno returns `402` | Insufficient credits | Top up your Suno account |
| `500` — Suno returns `422` | Invalid payload | Usually a stale cookie — refresh `SUNO_COOKIE` |
| `500` — Suno returns `429` | Rate limited | Reduce `CONCURRENT_LIMIT`, add delays |
| `405 Method Not Allowed` | Wrong HTTP method | Use POST for generate endpoints |

### Debug Artifacts

When CAPTCHA fails, the browser saves snapshots in `debug/`:

| File | What It Shows |
|---|---|
| `01-page-loaded.html` | Suno page after initial load |
| `03-after-advanced-tab.html` | After clicking Advanced tab |
| `05-after-create-click.html` | After clicking Create button |
| `07-no-captcha-final.html` | Final state when all methods failed |
| `*-requests.log` | All network requests made by the browser |
| `*-frames.log` | All iframe URLs (reveals CAPTCHA type) |

---

## AI Integration Patterns

This is what you're likely building toward — using AI to generate richer, more musical prompts.

### Pattern 1 — AI Generates Lyrics + Tags

Your backend uses an LLM to write lyrics and choose style tags, then calls this API:

```python
import httpx
import openai

def generate_song(user_description: str) -> dict:
    # Step 1: AI writes lyrics and picks style
    ai_response = openai.chat.completions.create(
        model="gpt-4o",
        messages=[{
            "role": "system",
            "content": """You are a professional songwriter and music producer.
Given a description, generate:
1. Full song lyrics with [Verse 1], [Chorus], [Bridge], [Outro] markers
2. Style tags (comma-separated genre/mood/instrument words, 3-8 tags)
3. A short title (3-6 words)
4. Vocal gender (male/female)

Respond as JSON: {"lyrics": "...", "tags": "...", "title": "...", "vocal_gender": "..."}"""
        }, {
            "role": "user",
            "content": f"Write a song about: {user_description}"
        }],
        response_format={"type": "json_object"}
    )
    song_data = json.loads(ai_response.choices[0].message.content)

    # Step 2: Generate the song
    response = httpx.post(
        "http://localhost:3000/api/custom_generate",
        json={
            "prompt": song_data["lyrics"],
            "tags": song_data["tags"],
            "title": song_data["title"],
            "vocal_gender": song_data["vocal_gender"],
            "weirdness": 40,
            "style_influence": 70,
        },
        timeout=120
    )
    return response.json()
```

### Pattern 2 — AI Selects Best Parameters for Mood

Use an LLM to map user mood → optimal music parameters:

```python
MUSIC_STYLE_PROMPT = """
Map the following mood/scene description to music generation parameters.

Rules for tags:
- Include 2-3 genre words (e.g., "synthwave", "lo-fi jazz", "orchestral")  
- Include 1-2 mood words (e.g., "melancholic", "triumphant", "peaceful")
- Include 1 vocal descriptor if needed (e.g., "female vocalist", "male baritone")
- Include 1-2 instrument highlights if relevant (e.g., "piano", "guitar", "strings")

Rules for weirdness: 0-30 for commercial/mainstream, 40-60 for balanced, 70-100 for experimental
Rules for style_influence: Low (20-40) = tags loosely followed, High (60-80) = strict adherence

Return JSON: {
  "tags": "...",
  "weirdness": 0-100,
  "style_influence": 0-100,
  "vocal_gender": "male"|"female"|null,
  "negative_tags": "..."
}
"""
```

### Pattern 3 — AI-Enhanced Lyrics from Minimal Input

Let users give a one-liner and have AI expand it into a full production-ready prompt:

```python
def expand_to_full_song(one_liner: str, genre: str, mood: str) -> dict:
    """
    Input:  "a song about missing someone on a rainy night"
    Output: Full verse/chorus structure + style tags optimized for Suno
    """
    # Key: give the AI examples of Suno-compatible lyrics format
    # with proper [Section] markers and emotional arc
    ...
```

### Pattern 4 — Generate Variants and Select Best

Generate 2 clips (Suno always returns 2), evaluate with AI, extend the best one:

```python
async def generate_and_select_best(params: dict) -> dict:
    # 1. Generate (always returns 2 clips)
    clips = await custom_generate(params)
    ids = [c["id"] for c in clips]

    # 2. Wait for audio URLs
    completed = await poll_until_done(ids)

    # 3. AI rates both clips based on metadata
    # (In practice: use a separate audio analysis service or user vote)
    best = max(completed, key=lambda c: score_clip(c))

    # 4. Extend the best one
    extended = await extend_audio(best["id"], extend_by=60)
    return extended
```

### What Parameters Matter Most for Quality

Based on testing with Suno v5 (chirp-crow):

```
MOST IMPACT:
  tags        → determines genre, feel, voice character completely
  prompt      → lyrics quality directly = song quality

MEDIUM IMPACT:
  style_influence (70+) → keeps output on-genre
  vocal_gender           → adds explicit voice keyword to tags

LOWER IMPACT:
  weirdness              → subtle variation
  model (chirp-crow)     → already the best available

TIP: A great 8-word tags string beats a 20-word mediocre one.
Examples of high-quality tags:
  "cinematic orchestral epic, soaring female soprano, strings, choir"
  "lo-fi hip hop, mellow, vinyl crackle, piano, night vibes"
  "dark synthwave, gritty male vocals, pulsing bass, neon city"
```

---

## Quick Reference — Full Request Shape

```json
POST http://localhost:3000/api/custom_generate
Content-Type: application/json

{
  // ── REQUIRED ──────────────────────────────────────────
  "prompt":  "[Verse 1]\nYour lyrics...\n\n[Chorus]\nYour chorus...",
  "tags":    "genre mood instrument vocal-type",
  "title":   "Song Title",

  // ── OPTIONAL ──────────────────────────────────────────
  "make_instrumental": false,         // true = no vocals, ignore prompt
  "model":             "chirp-crow",  // Suno model (default + best: chirp-crow)
  "wait_audio":        false,         // true = block until audio ready (~60-100s)
  "negative_tags":     "autotune, country, ska",

  // ── ADVANCED (More Options) ──────────────────────────
  "vocal_gender":    "male",   // "male" | "female" — injects into tags automatically
  "weirdness":       50,       // 0-100 (50 = balanced)
  "style_influence": 60,       // 0-100 (60 = fairly strict to tags)
  "persona_id":      "uuid"    // Suno Persona for voice cloning
}
```
