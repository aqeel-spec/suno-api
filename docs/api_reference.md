# Suno-API — Full Endpoint Reference

> All endpoints are hosted at `http://localhost:3000` (default Next.js dev port).  
> Every endpoint includes CORS headers from `CORS_ALLOWED_ORIGINS` in `.env`.

---

## Quick Reference Table

| Method | Endpoint | Purpose | Credits |
|--------|----------|---------|---------|
| `POST` | `/api/custom_generate` | Full-control song generation (lyrics + style) | 10 / call |
| `POST` | `/api/generate` | Auto-mode song from plain description | 10 / call |
| `POST` | `/api/generate_lyrics` | Generate lyrics text only (no audio) | free |
| `POST` | `/api/extend_audio` | Extend/continue an existing clip | 10 / call |
| `POST` | `/api/concat` | Stitch two clip segments together | 5 / call |
| `POST` | `/api/generate_stems` | Extract vocals + instrumental tracks | varies |
| `GET` | `/api/get?ids=...` | Poll clip status + get audio URLs | free |
| `GET` | `/api/get?id=...` | Get single clip by ID (same endpoint) | free |
| `GET` | `/api/clip?id=...` | Get single clip detail | free |
| `GET` | `/api/get_limit` | Current account credits balance | free |
| `GET` | `/api/get_aligned_lyrics?song_id=...` | Time-stamped lyric alignment | free |
| `GET` | `/api/persona?id=...` | Get persona details | free |

---

## Common Response Shape — `AudioInfo`

All audio-returning endpoints use this shape:

```typescript
interface AudioInfo {
  id: string;              // clip UUID — use for polling and extending
  title?: string;          // song title
  lyric?: string;          // full lyrics text (may differ from input after Suno editing)
  audio_url?: string;      // MP3 CDN URL (empty string until status="complete")
  video_url?: string;      // MP4 CDN URL with waveform animation (empty until complete)
  image_url?: string;      // cover art URL
  created_at: string;      // ISO 8601 timestamp
  model_name: string;      // e.g. "chirp-crow"
  status: string;          // see Status Values below
  tags?: string;           // style tags (reflects what circled back from Suno)
  negative_tags?: string;  // negative style tags
  duration?: string;       // seconds as string (filled after completion)
  error_message?: string;  // non-null when status="error"
}
```

### Status Values

```
submitted → queued → streaming → complete
                              ↘ error
```

| Status | Meaning |
|---|---|
| `submitted` | Request accepted, queued for generation |
| `queued` | In Suno's generation queue |
| `streaming` | Audio is being generated (may have partial `audio_url` CDN link) |
| `complete` | Done — `audio_url`, `video_url`, `image_url` are all valid |
| `error` | Failed — check `error_message` |

---

## `POST /api/custom_generate`

**Full-control generation** — you provide lyrics, style tags, and title.  
Returns 2 clips. Costs 10 credits.

### Request Body

```typescript
{
  // REQUIRED
  prompt: string;          // lyrics (use [Verse 1], [Chorus], [Bridge] markers)
  tags: string;            // comma-separated style/genre words
  title: string;           // song title (3-6 words recommended)

  // OPTIONAL
  make_instrumental?: boolean;  // default: false. true = no vocals
  model?: string;               // default: "chirp-crow" (Suno v5 Pro)
  wait_audio?: boolean;         // default: false. true = block until audio ready
  negative_tags?: string;       // styles to avoid

  // ADVANCED OPTIONS
  vocal_gender?: "male" | "female";  // appended to tags automatically
  weirdness?: number;                // 0-100 (50 = default balanced)
  style_influence?: number;          // 0-100 (50 = default)
  persona_id?: string;               // UUID — for voice cloning
}
```

### Example

```bash
curl -X POST http://localhost:3000/api/custom_generate \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "[Verse 1]\nCity lights reflecting off the rain\nI trace your name in every windowpane\n\n[Chorus]\nLost in neon glow\nNowhere left to go\nJust the echoes of what we used to know",
    "tags": "synthwave 80s dreamy melancholic",
    "title": "Neon Echo",
    "vocal_gender": "female",
    "weirdness": 40,
    "style_influence": 65,
    "negative_tags": "country, acoustic"
  }'
```

### Returns

Array of 2 `AudioInfo` objects with `status: "submitted"`.  
Poll `/api/get?ids=<id1>,<id2>` until `status: "complete"`.

---

## `POST /api/generate`

**Auto-mode generation** — Suno's AI writes everything from your plain description.  
Returns 2 clips. Costs 10 credits.

### Request Body

```typescript
{
  prompt: string;               // plain English description of the song you want
  make_instrumental?: boolean;  // default: false
  model?: string;               // default: "chirp-crow"
  wait_audio?: boolean;         // default: false
}
```

### Example

```bash
curl -X POST http://localhost:3000/api/generate \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "An upbeat jazz song about coffee and early mornings in a New York diner",
    "wait_audio": false
  }'
```

### When to Use Auto vs Custom

| Use `generate` (auto) | Use `custom_generate` |
|---|---|
| You want AI to write lyrics + pick style | You have your own lyrics |
| Quick prototyping of a song concept | Production-quality with precise control |
| Simple descriptions from users | AI-crafted lyrics that need exact execution |

---

## `POST /api/generate_lyrics`

Generate **text lyrics only** — no audio, no credits consumed.  
Use this to preview what lyrics Suno's AI would write before paying for generation.

### Request Body

```typescript
{
  prompt: string;  // describe the lyrical theme / song concept
}
```

### Example

```bash
curl -X POST http://localhost:3000/api/generate_lyrics \
  -H "Content-Type: application/json" \
  -d '{"prompt": "A melancholy song about a lighthouse keeper who waits for someone who never comes back"}'
```

### Returns

```json
{
  "id": "abc123",
  "title": "Keeper of the Light",
  "text": "[Verse 1]\nI count the ships that never stop\nAbove the cliffs where seagulls drop\n\n[Chorus]\nStill waiting at the edge of night...",
  "status": "complete"
}
```

### AI Integration Tip

Use `generate_lyrics` first to get Suno's lyric style, then use the output as the `prompt` for `custom_generate`. This gives you AI-quality lyrics + your own style tags:

```python
lyrics = await generate_lyrics("lost love found again")
await custom_generate(
    prompt=lyrics["text"],
    tags="indie folk acoustic warm",
    title=lyrics["title"]
)
```

---

## `POST /api/extend_audio`

Extend or continue an existing clip from a specific timestamp.  
Costs 10 credits. Returns 2 new extended clip objects.

### Request Body

```typescript
{
  audio_id: string;         // REQUIRED — UUID of the clip to extend
  prompt?: string;          // new lyrics for the extension (empty = continue naturally)
  continue_at?: number;     // seconds — where to start the extension (default: end of clip)
  tags?: string;            // new style tags (can differ from original)
  negative_tags?: string;   // styles to avoid
  title?: string;           // new title for the extended clip
  model?: string;           // default: "chirp-crow"
  wait_audio?: boolean;     // default: false
}
```

### Example — Extend a song with a new outro

```bash
curl -X POST http://localhost:3000/api/extend_audio \
  -H "Content-Type: application/json" \
  -d '{
    "audio_id": "86eae5d0-b94b-4f19-a41a-dc2fa6cc6848",
    "prompt": "[Outro]\nFade into the city lights\nGone but never out of sight\nNeon dreams...",
    "continue_at": 85,
    "tags": "synthwave 80s dreamy melancholic"
  }'
```

### Example — Natural continuation (no new lyrics)

```bash
curl -X POST http://localhost:3000/api/extend_audio \
  -H "Content-Type: application/json" \
  -d '{
    "audio_id": "86eae5d0-b94b-4f19-a41a-dc2fa6cc6848",
    "continue_at": 60
  }'
```

### AI Integration Pattern — Build Full Songs

Suno v5 clips are ~90-120 seconds max per generation. Use extend_audio to build longer songs:

```python
async def build_full_song(lyrics_verses: list[str], tags: str, title: str):
    # Step 1: Generate first 2 verses
    initial = await custom_generate(
        prompt=f"{lyrics_verses[0]}\n\n{lyrics_verses[1]}",
        tags=tags, title=title
    )
    best_initial = await pick_best(initial)  # poll + choose

    # Step 2: Extend with bridge + chorus
    extended = await extend_audio(
        audio_id=best_initial["id"],
        prompt=f"{lyrics_verses[2]}\n\n{lyrics_verses[3]}",
        tags=tags
    )
    return await pick_best(extended)
```

---

## `POST /api/concat`

Stitch a clip and its "continuation" together into one seamless clip.  
This is for clips generated via `extend_audio` — Suno stores them as paired clips.

### Request Body

```typescript
{
  clip_id: string;  // REQUIRED — UUID of the extended clip (not the original)
}
```

### Example

```bash
curl -X POST http://localhost:3000/api/concat \
  -H "Content-Type: application/json" \
  -d '{"clip_id": "c3f71a02-4e88-4d5a-b1c0-9af237ee6d4f"}'
```

### Returns

A single `AudioInfo` object for the concatenated clip with a new UUID.

---

## `POST /api/generate_stems`

Extract **vocal** and **instrumental** stem tracks from a completed clip.  
Useful for remixing, karaoke versions, or audio processing.

### Request Body

```typescript
{
  audio_id: string;  // REQUIRED — UUID of a completed clip (status must be "complete")
}
```

### Example

```bash
curl -X POST http://localhost:3000/api/generate_stems \
  -H "Content-Type: application/json" \
  -d '{"audio_id": "86eae5d0-b94b-4f19-a41a-dc2fa6cc6848"}'
```

### Returns

An object with separate MP3 URLs for:
- `vocal_url` — isolated vocals
- `instrumental_url` — music without vocals

---

## `GET /api/get`

Poll the status of one or more clips by ID. Free — no credits.

### Query Parameters

| Parameter | Required | Description |
|---|---|---|
| `ids` | One of the two | Comma-separated list of clip UUIDs |
| `id` | One of the two | Single clip UUID |

### Examples

```bash
# Single clip
curl "http://localhost:3000/api/get?id=86eae5d0-b94b-4f19-a41a-dc2fa6cc6848"

# Multiple clips (standard after custom_generate)
curl "http://localhost:3000/api/get?ids=86eae5d0-b94b-4f19-a41a-dc2fa6cc6848,64165e5c-b6a5-4f3e-84bf-8a8da6225f20"
```

### Returns

Array of `AudioInfo` objects with current status and URLs.

### Polling Strategy

```javascript
async function pollUntilComplete(ids, timeoutMs = 300000) {
  const deadline = Date.now() + timeoutMs;
  
  while (Date.now() < deadline) {
    const r = await fetch(`http://localhost:3000/api/get?ids=${ids.join(',')}`);
    const clips = await r.json();
    
    const done = clips.filter(c => c.status === 'complete' || c.status === 'error');
    if (done.length === clips.length) return clips;
    
    await sleep(5000); // check every 5 seconds
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}
```

---

## `GET /api/clip`

Get a single clip's full detail. Similar to `/api/get` but for one clip.

### Query Parameters

| Parameter | Required | Description |
|---|---|---|
| `id` | Yes | Clip UUID |

### Example

```bash
curl "http://localhost:3000/api/clip?id=86eae5d0-b94b-4f19-a41a-dc2fa6cc6848"
```

---

## `GET /api/get_limit`

Get the current account's remaining credits and subscription info.

### Example

```bash
curl "http://localhost:3000/api/get_limit"
```

### Returns

```json
{
  "credits_left": 400,
  "period": "monthly",
  "monthly_limit": 500,
  "monthly_usage": 100
}
```

---

## `GET /api/get_aligned_lyrics`

Get time-stamped lyric alignment for a completed clip.  
Useful for building karaoke-style UIs or syncing lyrics to audio playback.

### Query Parameters

| Parameter | Required | Description |
|---|---|---|
| `song_id` | Yes | Clip UUID (must have `status: "complete"`) |

### Example

```bash
curl "http://localhost:3000/api/get_aligned_lyrics?song_id=86eae5d0-b94b-4f19-a41a-dc2fa6cc6848"
```

### Returns

```json
{
  "aligned_lyrics": {
    "lines": [
      { "text": "City lights reflecting off the rain",  "start": 2.1, "end": 5.4 },
      { "text": "I trace your name in every windowpane", "start": 5.6, "end": 9.0 }
    ]
  }
}
```

---

## `GET /api/persona`

Get persona details for voice cloning. A Persona is a consistent vocal style derived from Suno clip collections.

### Query Parameters

| Parameter | Required | Default | Description |
|---|---|---|---|
| `id` | Yes | — | Persona UUID |
| `page` | No | `1` | Page number for paginated results |

### Example

```bash
curl "http://localhost:3000/api/persona?id=a1b2c3d4-e5f6-7890-abcd-ef1234567890"
```

---

## Error Responses

All endpoints return errors in this format:

```json
{ "error": "Human-readable error message" }
```

### Common HTTP Status Codes

| Code | Meaning | Action |
|---|---|---|
| `400` | Missing or invalid parameter | Fix request body |
| `402` | Insufficient Suno credits | Top up account |
| `405` | Wrong HTTP method | Use correct method |
| `422` | Invalid payload (Suno rejected) | Usually stale cookie — refresh `SUNO_COOKIE` |
| `429` | Rate limited by Suno | Reduce `CONCURRENT_LIMIT`, add delays |
| `500` | Internal server error | Check server logs, check `.env` config |

---

## V1 OpenAI-Compatible Endpoint

There is also an OpenAI-compatible chat completions endpoint:

```
POST /v1/chat/completions
```

This allows any OpenAI SDK client to use suno-api as if it were an LLM service — pass your song request as a message content and get the audio URL back in the response. See [src/app/v1/chat/completions/route.ts](../src/app/v1/chat/completions/route.ts) for details.
