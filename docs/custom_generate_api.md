# Custom Generate API — `/api/custom_generate`

Generate music with full control over lyrics, style, and advanced options.  
Each request creates **2 audio clips** and costs **10 credits**.

---

## Endpoint

```
POST http://localhost:3000/api/custom_generate
Content-Type: application/json
```

---

## Request Body Parameters

### Required Fields

| Parameter | Type     | Description                          | Example                        |
|-----------|----------|--------------------------------------|--------------------------------|
| `prompt`  | `string` | Lyrics or text prompt for the song   | `"[Verse 1]\nHello world..."` |
| `tags`    | `string` | Music style / genre descriptors      | `"pop electronic female vocals"` |
| `title`   | `string` | Song title                           | `"My Song"`                    |

### Optional Fields

| Parameter            | Type      | Default         | Description                                                 |
|----------------------|-----------|-----------------|-------------------------------------------------------------|
| `make_instrumental`  | `boolean` | `false`         | `true` = no vocals (instrumental only)                      |
| `model`              | `string`  | `"chirp-crow"`  | Suno model name (v5 Pro = `chirp-crow`)                     |
| `wait_audio`         | `boolean` | `false`         | `true` = wait up to 100s for audio URLs (sync mode)         |
| `negative_tags`      | `string`  | —               | Styles to exclude (e.g. `"autotune, heavy bass"`)           |

### Advanced Options (More Options panel on Suno UI)

| Parameter         | Type                    | Default    | Description                                                                                      |
|-------------------|-------------------------|------------|--------------------------------------------------------------------------------------------------|
| `vocal_gender`    | `"male"` or `"female"`  | *(auto)*   | Force vocal gender                                                                               |
| `weirdness`       | `number` (0–100)        | 50         | Creativity / weirdness slider. 0 = conventional, 100 = experimental. Auto-scaled to 0.0–1.0     |
| `style_influence` | `number` (0–100)        | 50         | How strongly the style tags affect output. 0 = loose, 100 = strict. Auto-scaled to 0.0–1.0      |
| `persona_id`      | `string` (UUID)         | —          | Suno Persona UUID for voice cloning                                                              |

> **Note:** `weirdness` and `style_influence` accept values 0–100 (like the Suno UI sliders).  
> The API automatically converts them to the 0.0–1.0 scale that Suno's backend expects.

---

## Examples

### 1. Basic — Just required fields

```json
{
  "prompt": "[Verse 1]\nWoke up to the golden morning light\nCoffee on the porch, everything feels right\nBirds are singing melodies I used to know\nBare feet in the grass, nowhere else to go\n\n[Chorus]\nThis is the life I was dreaming of\nSimple days painted with love\nNo rush, no race, just the sun above\nThis is the life I was dreaming of\n\n[Verse 2]\nWindows down on a backroad drive\nRadio playing our favorite line\nLaughing loud with the ones who stayed\nMaking memories that never fade\n\n[Chorus]\nThis is the life I was dreaming of\nSimple days painted with love\nNo rush, no race, just the sun above\nThis is the life I was dreaming of\n\n[Outro]\nDreaming of, dreaming of...",
  "tags": "pop acoustic happy uplifting",
  "title": "Dreaming Of"
}
```

### 2. With negative tags and instrumental

> For instrumental, leave `prompt` empty or set a mood description.

```json
{
  "prompt": "",
  "tags": "lo-fi jazz piano chill ambient smooth",
  "title": "Midnight Lounge",
  "make_instrumental": true,
  "negative_tags": "vocals, drums, heavy bass, aggressive"
}
```

### 3. With all advanced options

```json
{
  "prompt": "[Verse 1]\nNeon lights bleeding through the rain\nCity hums a haunted refrain\nI walk the streets where shadows play\nSearching for the words I could not say\n\n[Pre-Chorus]\nEvery signal turns to static\nEvery heartbeat feels erratic\n\n[Chorus]\nLost in the echo of your name\nNeon dreams that burn like flame\nI keep running but it's all the same\nLost in the echo of your name\n\n[Verse 2]\nMidnight taxis, blurring lights\nYour ghost is dancing through the night\nI left my heart on Avenue Nine\nStill tracing every faded sign\n\n[Chorus]\nLost in the echo of your name\nNeon dreams that burn like flame\nI keep running but it's all the same\nLost in the echo of your name\n\n[Bridge]\nMaybe someday the lights will fade\nAnd I'll forget the mess we made\nBut tonight I'm yours again\n\n[Outro]\nNeon dreams... neon dreams...",
  "tags": "synthwave dreamy ethereal retro 80s",
  "title": "Neon Dreams",
  "make_instrumental": false,
  "vocal_gender": "female",
  "weirdness": 70,
  "style_influence": 30,
  "negative_tags": "country, metal, acoustic"
}
```

### 4. With persona (voice clone)

```json
{
  "prompt": "[Verse 1]\nI've been walking down this lonely road\nCarrying the weight of a heavy load\nBut every time I hear your voice inside\nI find the strength I thought had died\n\n[Chorus]\nYou know me better than I know myself\nEvery scar, every story on the shelf\nWhen the world gets loud and I can't tell\nYou know me, you know me well\n\n[Verse 2]\nThrough the static and the noise of life\nYou cut through clean just like a knife\nNo pretending, no disguise to wear\nJust the truth hanging in the air\n\n[Chorus]\nYou know me better than I know myself\nEvery scar, every story on the shelf\nWhen the world gets loud and I can't tell\nYou know me, you know me well",
  "tags": "soul R&B smooth warm nostalgic",
  "title": "You Know Me Well",
  "persona_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "vocal_gender": "male",
  "style_influence": 80
}
```

### 5. Sync mode — wait for audio URLs

> With `wait_audio: true`, the API blocks until generation is complete (~60-100s) and returns clips with `audio_url` filled in.

```json
{
  "prompt": "[Verse 1]\nI keep my phone on silent now\nNothing left to talk about\nYou said forever but you meant for now\nAnd I believed it, every vow\n\n[Chorus]\nBut I'm still standing at the door\nWaiting for what isn't there anymore\nTell me why I'm keeping score\nWhen you already settled yours",
  "tags": "indie pop melancholy emotional",
  "title": "Keeping Score",
  "wait_audio": true,
  "weirdness": 20
}
```

---

## cURL Examples

### Basic request (async — returns immediately)

```bash
curl -X POST http://localhost:3000/api/custom_generate \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "[Verse 1]\nWoke up to the golden morning light\nCoffee on the porch everything feels right\n\n[Chorus]\nThis is the life I was dreaming of\nSimple days painted with love",
    "tags": "pop acoustic happy uplifting",
    "title": "Dreaming Of"
  }'
```

### Full request with all advanced options

```bash
curl -X POST http://localhost:3000/api/custom_generate \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "[Verse 1]\nNeon lights bleeding through the rain\nCity hums a haunted refrain\n\n[Chorus]\nLost in the echo of your name\nNeon dreams that burn like flame",
    "tags": "synthwave dreamy ethereal retro 80s",
    "title": "Neon Dreams",
    "make_instrumental": false,
    "vocal_gender": "female",
    "weirdness": 70,
    "style_influence": 30,
    "negative_tags": "country, metal, acoustic"
  }'
```

### PowerShell (Invoke-RestMethod)

```powershell
$body = @{
    prompt           = "[Verse 1]`nNeon lights bleeding through the rain`nCity hums a haunted refrain`n`n[Chorus]`nLost in the echo of your name`nNeon dreams that burn like flame"
    tags             = "synthwave dreamy ethereal retro 80s"
    title            = "Neon Dreams"
    vocal_gender     = "female"
    weirdness        = 70
    style_influence  = 30
    negative_tags    = "country, metal, acoustic"
} | ConvertTo-Json

Invoke-RestMethod -Uri "http://localhost:3000/api/custom_generate" `
  -Method POST -Body $body -ContentType "application/json"
```

---

## Response

### Async mode (`wait_audio: false` — default)

Returns immediately with clip metadata. Note `status: "submitted"` and empty `audio_url` — the song is still generating:

```json
[
  {
    "id": "86eae5d0-b94b-4f19-a41a-dc2fa6cc6848",
    "title": "Neon Dreams",
    "lyric": "[Verse 1]\nNeon lights bleeding through the rain\nCity hums a haunted refrain...",
    "audio_url": "",
    "video_url": "",
    "created_at": "2026-03-08T19:57:05.211Z",
    "model_name": "chirp-crow",
    "status": "submitted",
    "tags": "synthwave dreamy ethereal retro 80s"
  },
  {
    "id": "64165e5c-b6a5-4f3e-84bf-8a8da6225f20",
    "title": "Neon Dreams",
    "lyric": "[Verse 1]\nNeon lights bleeding through the rain\nCity hums a haunted refrain...",
    "audio_url": "",
    "video_url": "",
    "created_at": "2026-03-08T19:57:05.211Z",
    "model_name": "chirp-crow",
    "status": "submitted",
    "tags": "synthwave dreamy ethereal retro 80s"
  }
]
```

**Next step:** Poll until complete:

```
GET /api/get?ids=86eae5d0-b94b-4f19-a41a-dc2fa6cc6848,64165e5c-b6a5-4f3e-84bf-8a8da6225f20
```

Once `status` changes to `"complete"`, the response will include real URLs:

```json
[
  {
    "id": "86eae5d0-b94b-4f19-a41a-dc2fa6cc6848",
    "title": "Neon Dreams",
    "lyric": "[Verse 1]\nNeon lights bleeding through the rain\nCity hums a haunted refrain...",
    "audio_url": "https://cdn1.suno.ai/86eae5d0-b94b-4f19-a41a-dc2fa6cc6848.mp3",
    "video_url": "https://cdn1.suno.ai/86eae5d0-b94b-4f19-a41a-dc2fa6cc6848.mp4",
    "created_at": "2026-03-08T19:57:05.211Z",
    "model_name": "chirp-crow",
    "status": "complete",
    "tags": "synthwave dreamy ethereal retro 80s"
  }
]
```

### Sync mode (`wait_audio: true`)

Waits up to ~100s and returns clips with `audio_url` and `video_url` already filled in (if generation completes in time). No polling needed.

```json
[
  {
    "id": "c3f71a02-4e88-4d5a-b1c0-9af237ee6d4f",
    "title": "Keeping Score",
    "lyric": "[Verse 1]\nI keep my phone on silent now\nNothing left to talk about...",
    "audio_url": "https://cdn1.suno.ai/c3f71a02-4e88-4d5a-b1c0-9af237ee6d4f.mp3",
    "video_url": "https://cdn1.suno.ai/c3f71a02-4e88-4d5a-b1c0-9af237ee6d4f.mp4",
    "created_at": "2026-03-08T20:10:32.450Z",
    "model_name": "chirp-crow",
    "status": "complete",
    "tags": "indie pop melancholy emotional"
  }
]
```

---

## Error Responses

| Status | Cause                             | Example Response                                                  |
|--------|-----------------------------------|-------------------------------------------------------------------|
| `400`  | Missing required field            | `{"error": "Missing required field: prompt (string)"}`            |
| `400`  | Missing tags                      | `{"error": "Missing required field: tags (string) — describe..."}`|
| `400`  | Missing title                     | `{"error": "Missing required field: title (string)"}`             |
| `500`  | Suno API error / CAPTCHA failure  | `{"error": "Error generating audio: ..."}`                        |

---

## How Advanced Options Map to Suno's API

| Your Parameter    | Suno Payload Location                          | Suno Field Name          | Value Range |
|-------------------|------------------------------------------------|--------------------------|-------------|
| `vocal_gender`    | **appended to `tags` string** + `metadata.vocal_gender` | `vocal_gender` / `tags` | `"male"` / `"female"` |
| `weirdness`       | `metadata.control_sliders.weirdness_constraint`| `weirdness_constraint`   | 0.0 – 1.0  |
| `style_influence` | `metadata.control_sliders.style_weight`        | `style_weight`           | 0.0 – 1.0  |
| `persona_id`      | top-level field                                | `persona_id`             | UUID string |
| `negative_tags`   | top-level field                                | `negative_tags`          | free text   |

> **Important — How `vocal_gender` Works:**  
> Suno's AI model determines vocal style from the `tags` text, **not** from the `metadata.vocal_gender` field.  
> When you set `"vocal_gender": "female"`, the API automatically appends `, female vocals` to your tags string:
> ```
> Input tags:   "synthwave dreamy 80s"
> Sent to Suno: "synthwave dreamy 80s, female vocals"
> ```
> The `metadata.vocal_gender` field is also set for completeness, but the tags append is what actually controls the voice.  
> You can also skip the parameter entirely and write the vocal style directly in `tags` — e.g. `"tags": "pop, deep male baritone"`.

---

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---|---|---|
| Request hangs for >3 minutes | CAPTCHA browser is waiting for 2Captcha | Check `TWOCAPTCHA_KEY` is valid and has credits |
| `500` — "Could not solve CAPTCHA" | 2Captcha timed out or wrong sitekey | Check `debug/` folder for browser screenshot |
| `500` — "Create button stayed disabled" | Suno UI changed, style chip selector broken | Update `button[aria-label^="Add style:"]` selector in `SunoApi.ts` |
| `500` — Suno returns 422 | Stale session cookie | Replace `SUNO_COOKIE` in `.env` with fresh cookies from your browser |
| `500` — Suno returns 402 | No Suno credits left | Top up your Suno account (10 credits per generation) |
| `500` — Suno returns 429 | Too many requests | Reduce `CONCURRENT_LIMIT` in `.env` and add delays between requests |
| Wrong voice gender despite setting it | Tags didn't include gender word | Explicitly include `"male vocals"` or `"female vocals"` in your `tags` string |
| `audio_url` is empty after polling | Song still generating | Wait longer — some clips take 90–120s; keep polling |
| Only 1 clip returned instead of 2 | One clip errored during generation | Check `error_message` on the clips; retry the request |
