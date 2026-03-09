# AI Integration Guide — Building a Backend That Generates Songs with AI

> **Goal:** Connect your backend to `suno-api`, use an LLM to produce high-quality music generation prompts, poll results, and extend/refine songs automatically.

---

## Table of Contents

1. [Core Concept](#core-concept)
2. [Basic Backend Integration](#basic-backend-integration)
3. [AI Prompt Engineering for Music](#ai-prompt-engineering-for-music)
4. [Tags — The Most Important Parameter](#tags--the-most-important-parameter)
5. [Lyrics Structure Guide](#lyrics-structure-guide)
6. [End-to-End Python Example](#end-to-end-python-example)
7. [Extending and Refining Songs](#extending-and-refining-songs)
8. [Genre → Parameters Reference](#genre--parameters-reference)
9. [Production Patterns](#production-patterns)
10. [Parameter Tuning Guide](#parameter-tuning-guide)

---

## Core Concept

```
User Input (mood / topic / genre preference)
         │
         ▼
    Your Backend
         │
    LLM Call (GPT-4o / Claude / Gemini)
         │ writes: lyrics + tags + title
         ▼
POST /api/custom_generate
         │
         ▼ (60-120 seconds)
GET  /api/get  (poll every 5s)
         │
         ▼
Two audio clips returned → pick best → (optionally extend)
         │
         ▼
Serve audio_url to user
```

The quality of the final song depends almost entirely on:
1. **Tags string** — determines genre, mood, instruments, voice character
2. **Lyrics** — determines how the song actually sounds musically and emotionally

Everything else (weirdness, style_influence, model) is fine-tuning.

---

## Basic Backend Integration

### Python (httpx + asyncio)

```python
import asyncio
import httpx

SUNO_API_BASE = "http://localhost:3000"

async def generate_song(prompt: str, tags: str, title: str, **kwargs) -> list[dict]:
    """Submit a song generation request and poll until complete."""
    async with httpx.AsyncClient(timeout=120) as client:
        # Step 1: Submit generation
        response = await client.post(
            f"{SUNO_API_BASE}/api/custom_generate",
            json={
                "prompt": prompt,
                "tags": tags,
                "title": title,
                **kwargs
            }
        )
        response.raise_for_status()
        clips = response.json()

    # Step 2: Poll until complete
    ids = [c["id"] for c in clips]
    return await poll_until_complete(ids)


async def poll_until_complete(ids: list[str], timeout_seconds: int = 300) -> list[dict]:
    """Poll /api/get every 5s until all clips are complete or error."""
    ids_str = ",".join(ids)
    deadline = asyncio.get_event_loop().time() + timeout_seconds

    async with httpx.AsyncClient() as client:
        while asyncio.get_event_loop().time() < deadline:
            r = await client.get(f"{SUNO_API_BASE}/api/get?ids={ids_str}")
            clips = r.json()

            terminal_states = {"complete", "error"}
            all_done = all(c["status"] in terminal_states for c in clips)

            if all_done:
                errors = [c for c in clips if c["status"] == "error"]
                if errors:
                    print(f"WARNING: {len(errors)} clip(s) errored: {[c.get('error_message') for c in errors]}")
                return clips

            await asyncio.sleep(5)

    raise TimeoutError(f"Clips did not complete within {timeout_seconds}s")


async def get_credits() -> dict:
    async with httpx.AsyncClient() as client:
        r = await client.get(f"{SUNO_API_BASE}/api/get_limit")
        return r.json()
```

### Node.js (fetch)

```javascript
const SUNO_API_BASE = 'http://localhost:3000';

async function generateSong(prompt, tags, title, options = {}) {
  // Submit
  const submitRes = await fetch(`${SUNO_API_BASE}/api/custom_generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, tags, title, ...options }),
  });
  if (!submitRes.ok) throw new Error(`Submit failed: ${await submitRes.text()}`);
  const clips = await submitRes.json();

  // Poll
  const ids = clips.map(c => c.id);
  return pollUntilComplete(ids);
}

async function pollUntilComplete(ids, timeoutMs = 300000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await fetch(`${SUNO_API_BASE}/api/get?ids=${ids.join(',')}`);
    const clips = await r.json();
    if (clips.every(c => c.status === 'complete' || c.status === 'error')) {
      return clips;
    }
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  throw new Error('Song generation timed out');
}
```

---

## AI Prompt Engineering for Music

### System Prompt for Your LLM

Use this system prompt when asking an LLM (GPT-4o, Claude, Gemini) to write song content:

```
You are a professional songwriter and music producer with expertise in all genres.

When given a description of a song, you must produce:
1. Complete song lyrics with structural markers
2. Style tags string (comma-separated, 4-10 words)
3. A song title (3-6 words)
4. Vocal gender if relevant ("male", "female", or null)
5. weirdness (0-100): how experimental should it be
6. style_influence (0-100): how strictly should tags be followed

LYRICS FORMAT RULES:
- Always use section markers: [Verse 1], [Pre-Chorus], [Chorus], [Verse 2], [Bridge], [Outro]
- Each section should be 4-8 lines
- Keep verses distinct — Verse 2 should advance the story/feeling
- Chorus should be the emotional peak — short, memorable, singable
- Rhymes should feel natural, not forced
- Match the lyrical vocabulary and complexity to the genre

TAGS FORMAT RULES:
- Start with 2 genre words (e.g., "synthwave", "lo-fi jazz", "folk rock")
- Add 1-2 mood/texture words (e.g., "melancholic", "euphoric", "gritty")
- Add 1-2 instrument highlights if genre calls for it (e.g., "piano", "electric guitar")
- Add vocal style if important (e.g., "falsetto", "raspy", "operatic soprano")
- Keep total under 10 words
- Do NOT repeat words from the title or lyrics in the tags
- Separate all tags with ", " (comma-space)

OUTPUT FORMAT — respond with valid JSON only:
{
  "title": "My Song Title",
  "tags": "genre mood instrument vocal",
  "lyrics": "[Verse 1]\n...\n\n[Chorus]\n...",
  "vocal_gender": "female",
  "weirdness": 40,
  "style_influence": 65,
  "negative_tags": "country, heavy metal"
}
```

### User Prompt Template

```python
def build_user_prompt(description: str, genre: str = None, mood: str = None) -> str:
    parts = [f"Write a song about: {description}"]
    if genre:
        parts.append(f"Genre preference: {genre}")
    if mood:
        parts.append(f"Mood: {mood}")
    return "\n".join(parts)
```

### Complete Python Flow

```python
import json
import openai

client = openai.AsyncOpenAI()

SONGWRITER_SYSTEM_PROMPT = """...(paste system prompt above)..."""

async def ai_generate_song(description: str, genre: str = None, mood: str = None) -> list[dict]:
    # Step 1: AI writes the song content
    user_prompt = build_user_prompt(description, genre, mood)
    
    ai_response = await client.chat.completions.create(
        model="gpt-4o",
        messages=[
            {"role": "system", "content": SONGWRITER_SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt}
        ],
        response_format={"type": "json_object"},
        temperature=0.8
    )
    
    song_data = json.loads(ai_response.choices[0].message.content)
    
    # Step 2: Generate audio
    clips = await generate_song(
        prompt=song_data["lyrics"],
        tags=song_data["tags"],
        title=song_data["title"],
        vocal_gender=song_data.get("vocal_gender"),
        weirdness=song_data.get("weirdness", 50),
        style_influence=song_data.get("style_influence", 60),
        negative_tags=song_data.get("negative_tags"),
    )
    
    return clips
```

---

## Tags — The Most Important Parameter

**Tags control everything:** genre, feel, instruments, vocals, era, tempo, texture.

### Tag Anatomy

```
"[GENRE], [SUBGENRE], [MOOD], [INSTRUMENT], [VOCAL STYLE], [ERA/TEXTURE]"
```

### High-Quality Tag Examples by Genre

```
# ELECTRONIC
"synthwave, retrowave, nocturnal, pulsing bass, analog synths, 80s nostalgia"
"lo-fi hip hop, jazzy, chill study, vinyl crackle, piano keys, mellow"
"future bass, euphoric, drop, lush pads, bright vocals, festival energy"
"dark techno, industrial, relentless, bass-heavy, underground club"

# POP
"indie pop, bittersweet, jangly guitar, female vocalist, bedroom pop"
"pop punk, energetic, power chords, angsty, rebellious youth"
"dream pop, ethereal, swirling reverb, female vocals, shoegaze-adjacent"

# ROCK
"alt rock, grunge, distorted guitar, raw, emotional, Seattle 90s"
"classic rock, arena, stadium anthem, electric guitar solo, powerful male vocals"
"folk rock, acoustic, introspective, storytelling, fingerpicking"

# HIP HOP / R&B
"boom bap, golden era, sample-based, lyrical, underground NYC"
"trap, dark, hi-hats, heavy bass, melodic hook, Atlanta"
"neo soul, smooth, warm, soulful female vocals, live instrumentation"
"R&B, sensual, slow jam, falsetto, late night, contemporary"

# COUNTRY / AMERICANA
"Americana, heartland, acoustic guitar, honest male vocals, storytelling, Midwest"
"country pop, crossover, catchy, summer, upbeat, radio-friendly"

# CLASSICAL / CINEMATIC
"cinematic orchestral, epic, swelling strings, triumphant, blockbuster"  
"piano solo, minimalist, emotional, Satie-inspired, gentle melancholy"
"chamber music, intimate, string quartet, classical, European"
```

### What NOT to Write in Tags

```
❌ Too vague:     "good music, nice song, great vocals"
❌ Too specific:  "Exactly like Taylor Swift's 2016 album production"
❌ Contradictory: "heavy metal, acoustic gentle, quiet"
❌ Too long:      10+ comma-separated items (model gets confused)
❌ Repeated:      "sad, melancholy, sorrowful, depressing, grief"

✅ Right length:  4-8 distinct style descriptors
✅ Concrete:      "lo-fi, late night, piano, mellow, jazz-influenced"
✅ Coherent:      All tags should support the same overall sound
```

---

## Lyrics Structure Guide

### Standard Structure (works in every genre)

```
[Verse 1]   — 4-8 lines, set the scene / introduce conflict
[Pre-Chorus] — 2-4 lines, build tension toward chorus
[Chorus]    — 4-6 lines, emotional peak, hooky and repeatable
[Verse 2]   — 4-8 lines, DIFFERENT content from Verse 1, advance the story
[Pre-Chorus] — same or slight variation
[Chorus]    — repeat (can add ad-libs or extra line)
[Bridge]    — 4-6 lines, emotional shift or new perspective
[Outro]     — 2-4 lines, gradually fade/resolve
```

### Section-by-Section Tips

**[Verse 1]** — Establish the world. Who, what, where. Specific sensory details work best.
```
❌ "I feel sad because you left me"
✅ "Your coffee cup still on the shelf\nI haven't moved it, tell myself\nIt keeps your mornings here with mine"
```

**[Chorus]** — The emotional truth, distilled. Should be singable, memorable, use the title somewhere.
```
❌ "I really really miss you so much and I wish you were here"
✅ "Miss you in the morning light\nMiss you when the city sleeps\nMiss you like the sea misses high tide"
```

**[Bridge]** — New perspective, tempo shift, emotional contrast or resolution.
```
"Maybe I've been holding on to someone who let go\nMaybe what I call love is just the fear of being alone"
```

### Suno-Specific Formatting

```
✅ Use newlines between sections with blank line
✅ Put section names on their own line in brackets
✅ 8 lines max per section (Suno truncates longer sections)
❌ Don't use (Optional) or [SOLO] — Suno may render these as lyrics
❌ Don't write stage directions like (spoken) or (whispered)
✅ Use line breaks for melody flow — where you'd take a breath
```

---

## End-to-End Python Example

```python
import asyncio
import json
import httpx
import openai

SUNO_API_BASE = "http://localhost:3000"
openai_client = openai.AsyncOpenAI(api_key="YOUR_KEY")

SONGWRITER_PROMPT = """
You are a professional songwriter. Given a description, return JSON with:
{
  "title": "3-6 word title",
  "tags": "genre mood instrument (4-8 comma-sep words)",
  "lyrics": "[Verse 1]\\nline1\\nline2\\n\\n[Chorus]\\nline1\\nline2",
  "vocal_gender": "male" or "female" or null,
  "weirdness": 0-100,
  "style_influence": 0-100,
  "negative_tags": "what to avoid (optional)"
}
"""

async def write_song_with_ai(description: str) -> dict:
    response = await openai_client.chat.completions.create(
        model="gpt-4o",
        messages=[
            {"role": "system", "content": SONGWRITER_PROMPT},
            {"role": "user", "content": description}
        ],
        response_format={"type": "json_object"},
        temperature=0.8
    )
    return json.loads(response.choices[0].message.content)


async def submit_song(song_data: dict) -> list[dict]:
    async with httpx.AsyncClient(timeout=120) as client:
        payload = {
            "prompt": song_data["lyrics"],
            "tags": song_data["tags"],
            "title": song_data["title"],
        }
        if song_data.get("vocal_gender"):
            payload["vocal_gender"] = song_data["vocal_gender"]
        if song_data.get("weirdness") is not None:
            payload["weirdness"] = song_data["weirdness"]
        if song_data.get("style_influence") is not None:
            payload["style_influence"] = song_data["style_influence"]
        if song_data.get("negative_tags"):
            payload["negative_tags"] = song_data["negative_tags"]

        r = await client.post(f"{SUNO_API_BASE}/api/custom_generate", json=payload)
        r.raise_for_status()
        return r.json()


async def poll_done(ids: list[str], timeout: int = 300) -> list[dict]:
    async with httpx.AsyncClient() as client:
        for _ in range(timeout // 5):
            r = await client.get(f"{SUNO_API_BASE}/api/get?ids={','.join(ids)}")
            clips = r.json()
            if all(c["status"] in {"complete", "error"} for c in clips):
                return clips
            await asyncio.sleep(5)
    raise TimeoutError("Songs did not complete in time")


async def pick_best(clips: list[dict]) -> dict:
    """Pick the clip most likely to be good (no error, longer duration)."""
    complete = [c for c in clips if c["status"] == "complete"]
    if not complete:
        raise RuntimeError(f"All clips errored: {[c.get('error_message') for c in clips]}")
    return max(complete, key=lambda c: float(c.get("duration") or 0))


async def main():
    description = "A triumphant cinematic orchestral piece about a hero returning home after a long journey"
    
    print("Writing song with AI...")
    song_data = await write_song_with_ai(description)
    print(f"Title: {song_data['title']}")
    print(f"Tags: {song_data['tags']}")

    print("Submitting to Suno...")
    submitted = await submit_song(song_data)
    ids = [c["id"] for c in submitted]
    print(f"Clip IDs: {ids}")

    print("Waiting for generation...")
    completed = await poll_done(ids)
    
    best = await pick_best(completed)
    print(f"\nBest clip: {best['id']}")
    print(f"Audio URL: {best['audio_url']}")
    print(f"Video URL: {best['video_url']}")


if __name__ == "__main__":
    asyncio.run(main())
```

---

## Extending and Refining Songs

### Strategy: Generate → Select → Extend → Concat

Each `custom_generate` gives you 2 variants. Extend the good one for a full 3-5 minute song.

```python
async def build_full_song(description: str) -> dict:
    song_data = await write_song_with_ai(description)

    # Split lyrics into two halves for more natural generation
    lyrics_parts = split_lyrics(song_data["lyrics"])

    # Generate first half
    submitted = await submit_song({
        **song_data,
        "lyrics": lyrics_parts["first_half"]
    })
    first_clips = await poll_done([c["id"] for c in submitted])
    best_first = await pick_best(first_clips)

    # Extend with second half
    async with httpx.AsyncClient(timeout=120) as client:
        ext_r = await client.post(f"{SUNO_API_BASE}/api/extend_audio", json={
            "audio_id": best_first["id"],
            "prompt": lyrics_parts["second_half"],
            "tags": song_data["tags"],
            "title": song_data["title"],
        })
        ext_r.raise_for_status()
        ext_clips = ext_r.json()

    final_clips = await poll_done([c["id"] for c in ext_clips])
    best_extended = await pick_best(final_clips)

    # Optionally stitch into one file
    async with httpx.AsyncClient(timeout=60) as client:
        concat_r = await client.post(f"{SUNO_API_BASE}/api/concat", json={
            "clip_id": best_extended["id"]
        })
        return concat_r.json()


def split_lyrics(full_lyrics: str) -> dict:
    """Split lyrics at the Bridge section for a natural break point."""
    if "[Bridge]" in full_lyrics:
        idx = full_lyrics.index("[Bridge]")
        return {
            "first_half": full_lyrics[:idx].strip(),
            "second_half": full_lyrics[idx:].strip()
        }
    # Fallback: split in half by lines
    lines = full_lyrics.split("\n")
    mid = len(lines) // 2
    return {
        "first_half": "\n".join(lines[:mid]),
        "second_half": "\n".join(lines[mid:])
    }
```

### AI-Guided Variant Selection

Instead of picking by duration, use AI to choose the better variant:

```python
async def ai_pick_best(clips: list[dict], original_intent: str) -> dict:
    """Use AI to select the better clip based on metadata match."""
    complete = [c for c in clips if c["status"] == "complete"]
    if len(complete) == 1:
        return complete[0]

    # Ask AI which clip better matches the intent
    clip_summaries = [
        f"Clip {i+1}: title='{c.get('title')}', tags='{c.get('tags')}', model='{c.get('model_name')}'"
        for i, c in enumerate(complete)
    ]

    response = await openai_client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[{
            "role": "user",
            "content": f"""Original intent: {original_intent}

Generated clips:
{chr(10).join(clip_summaries)}

Which clip number (1 or {len(complete)}) is more likely to match the intent? 
Respond with just the number."""
        }]
    )

    choice = int(response.choices[0].message.content.strip()) - 1
    return complete[min(choice, len(complete) - 1)]
```

---

## Genre → Parameters Reference

Use this as a lookup table when building your LLM's parameter recommendations:

| Genre | Tags Example | `weirdness` | `style_influence` | `vocal_gender` | `negative_tags` |
|---|---|---|---|---|---|
| Pop Ballad | `"pop, ballad, piano, emotional, female vocalist"` | 20-40 | 60-75 | `"female"` | `"electronic, dance"` |
| Upbeat Pop | `"pop, upbeat, catchy, fun, summer vibes"` | 20-35 | 55-70 | either | — |
| Indie Folk | `"indie folk, acoustic, storytelling, introspective"` | 30-50 | 50-65 | `"male"` | `"electronic, autotune"` |
| Lo-Fi Hip Hop | `"lo-fi hip hop, mellow, study, piano, vinyl crackle"` | 25-45 | 45-60 | none | `"aggressive, lyrics"` |
| Synthwave | `"synthwave, retrowave, 80s nostalgia, pulsing synths"` | 35-55 | 55-70 | either | `"acoustic, country"` |
| Dark Techno | `"dark techno, minimal, industrial, hypnotic, bass"` | 50-75 | 40-55 | none | `"vocals, acoustic, pop"` |
| R&B | `"R&B, soul, smooth, groove, contemporary"` | 20-40 | 55-70 | either | `"rock, metal"` |
| Hip Hop | `"hip hop, boom bap, lyrical, beat, urban"` | 30-50 | 50-65 | `"male"` | — |
| Classic Rock | `"classic rock, guitar riff, powerful, stadium"` | 25-45 | 60-75 | `"male"` | `"electronic, pop"` |
| Metal | `"metal, heavy, distorted guitar, aggressive, intense"` | 40-65 | 55-70 | `"male"` | `"acoustic, soft, pop"` |
| Jazz | `"jazz, swing, piano, saxophone, smoky, classic"` | 35-55 | 45-60 | either | `"electronic, pop"` |
| Orchestral | `"cinematic orchestral, strings, epic, sweeping, film score"` | 30-50 | 65-80 | none | `"vocals, pop, electronic"` |
| Country | `"country, acoustic guitar, twang, heartland, storytelling"` | 15-35 | 60-75 | `"male"` | `"electronic, pop, city"` |
| Gospel | `"gospel, choir, uplifting, spiritual, piano, anthemic"` | 20-40 | 60-75 | either | `"secular, dark"` |
| Bossa Nova | `"bossa nova, Brazilian, nylon guitar, samba, smooth"` | 25-45 | 55-70 | `"female"` | `"heavy, aggressive"` |
| Experimental | `"avant-garde, experimental, atonal, abstract, noise pop"` | 75-100 | 25-40 | N/A | — |

---

## Production Patterns

### Pattern 1 — User-Driven (Chatbot Interface)

```
User: "Make me a sad song about losing a pet"
         ↓
AI Backend: calls songwriter LLM → gets song_data
         ↓
submit to /api/custom_generate
         ↓
return job IDs to user immediately (don't block the chat)
         ↓ (background worker)
poll every 10s → when complete → notify user
```

### Pattern 2 — Batch Generation (Content Pipeline)

```python
async def batch_generate(descriptions: list[str]) -> list[dict]:
    """Generate multiple songs concurrently (respects CONCURRENT_LIMIT=3)."""
    # Generate all in parallel — semaphore on suno-api server controls concurrency
    tasks = [ai_generate_song(desc) for desc in descriptions]
    results = await asyncio.gather(*tasks, return_exceptions=True)
    return [r for r in results if not isinstance(r, Exception)]
```

### Pattern 3 — Iterative Refinement Loop

```python
async def refine_until_good(description: str, max_iterations: int = 3) -> dict:
    """Generate, evaluate, and regenerate if quality is low."""
    for attempt in range(max_iterations):
        try:
            clips = await ai_generate_song(description)
            best = await pick_best(clips)

            # Basic quality check — if no error and has audio URL
            if best["status"] == "complete" and best.get("audio_url"):
                return best
        except Exception as e:
            print(f"Attempt {attempt + 1} failed: {e}")

    raise RuntimeError(f"Could not generate a good clip after {max_iterations} attempts")
```

### Pattern 4 — Genre-Specific AI Personas

Create specialized LLM personas for different music styles:

```python
GENRE_PERSONAS = {
    "hiphop": """You specialize in hip hop songwriting. You write tight rhyme schemes,
        use hooks that hit hard, and always include a distinct 16-bar verse structure.
        Your tags always include boom-bap or trap or lo-fi, plus BPM hint (e.g. "95 bpm").""",
    
    "cinematic": """You are a film score composer writing lyrics for epic orchestral pieces.
        You rarely use conventional chorus/verse—prefer through-composed structures.
        Tags always include "cinematic orchestral" and a thematic descriptor.""",
    
    "pop": """You write commercially accessible pop songs with sticky choruses,
        relatable metaphors, and perfect 3:30 structures. Tags lean mainstream.""",
}

async def genre_generate(description: str, genre: str) -> list[dict]:
    persona = GENRE_PERSONAS.get(genre, SONGWRITER_PROMPT)
    # Use genre-specific system prompt
    ...
```

---

## Parameter Tuning Guide

### When Songs Sound Off — What to Adjust

| Problem | Likely Cause | Fix |
|---|---|---|
| Wrong genre entirely | Tags too vague | Be more specific — add subgenre or era |
| Voice sounds wrong for mood | Missing vocal style in tags | Add `"raspy"`, `"breathy"`, `"operatic"`, etc. |
| Song sounds too generic | weirdness too low | Increase to 55-70 |
| Song sounds too chaotic | weirdness too high | Reduce to 20-40 |
| Instruments don't match tags | style_influence too low | Increase to 70+ |
| Gender sounds wrong | vocal_gender not set + no tag | Add `"male vocals"` or `"female vocals"` explicitly in tags |
| Song structure feels random | No section markers in lyrics | Always use `[Verse 1]`, `[Chorus]`, etc. |
| Chorus doesn't hit | Chorus lyrics too long | Keep chorus to 4-6 lines maximum |
| Too much repetition | Same rhyme scheme throughout | Vary verse rhyme patterns |
| Instruments missing | Tags have no instrument words | Add piano/guitar/synth/strings explicitly |

### Slider Sweet Spots by Use Case

| Use Case | `weirdness` | `style_influence` |
|---|---|---|
| Commercial release (radio-ready) | 15-30 | 65-80 |
| Artistic project (experimental) | 60-85 | 30-50 |
| Background music / ambient | 20-40 | 50-70 |
| Prototype / test generation | 40-60 | 50-65 |
| Genre study (very authentic) | 25-45 | 75-90 |

### Model Note

`chirp-crow` is Suno's v5 Pro model — the best available. Always use this (it's the default). Do not override unless you have a specific reason.

---

## Quick Start Checklist

When building your integration, verify each step:

```
[ ] suno-api server is running: npm run dev  (or pnpm dev)
[ ] .env has valid SUNO_COOKIE (test: GET /api/get_limit → credits > 0)
[ ] .env has valid TWOCAPTCHA_KEY (test: try one generate and watch logs)
[ ] /api/custom_generate returns 2 clip IDs (not errors)
[ ] /api/get?ids=... eventually shows status="complete"
[ ] audio_url plays in browser or wget
[ ] LLM system prompt generates valid JSON with all required fields
[ ] Your backend validates LLM JSON before sending to suno-api
[ ] Rate limiting: back off on 429 errors, honor CONCURRENT_LIMIT
[ ] Credit monitoring: check /api/get_limit before batch operations
```
