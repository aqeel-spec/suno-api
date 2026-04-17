import * as mm from 'music-metadata';

export interface AudioAnalysis {
  bpm?: number;
  bpm_label: 'slow' | 'medium' | 'fast' | 'very fast';
  key?: string;
  genre: string[];
  duration?: number;
  format?: string;
  artist?: string;
  title?: string;
  suggested_tags: string;
  suggested_prompt: string;
}

// ─── Tempo label ───────────────────────────────────────────────────────────────

function bpmLabel(bpm: number): AudioAnalysis['bpm_label'] {
  if (bpm < 70)  return 'slow';
  if (bpm < 110) return 'medium';
  if (bpm < 150) return 'fast';
  return 'very fast';
}

// ─── Audio decoding ────────────────────────────────────────────────────────────

const TARGET_SR = 22050; // downsample to 22 kHz — enough for BPM + key detection

async function decodeToMono(buffer: Buffer): Promise<Float32Array> {
  // Dynamic import avoids bundler issues with native Node addon
  const { AudioContext } = await import('node-web-audio-api' as any);
  const ctx = new AudioContext({ sampleRate: TARGET_SR });
  try {
    // Buffer → ArrayBuffer (must be a plain ArrayBuffer, not a slice)
    const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    const decoded = await ctx.decodeAudioData(ab);

    const len = decoded.length;
    const mono = new Float32Array(len);
    for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
      const channel = decoded.getChannelData(ch);
      for (let i = 0; i < len; i++) mono[i] += channel[i] / decoded.numberOfChannels;
    }
    return mono;
  } finally {
    await ctx.close();
  }
}

// ─── BPM detection (energy onset + autocorrelation) ───────────────────────────

function detectBpm(samples: Float32Array, sampleRate: number): number | undefined {
  const FRAME = 1024;
  const HOP   = 512;

  // Compute RMS energy per frame
  const energy: number[] = [];
  for (let i = 0; i + FRAME <= samples.length; i += HOP) {
    let e = 0;
    for (let j = 0; j < FRAME; j++) e += samples[i + j] ** 2;
    energy.push(e / FRAME);
  }

  // Onset strength = positive first difference of energy envelope
  const onset = energy.map((v, i) => i === 0 ? 0 : Math.max(0, v - energy[i - 1]));

  // Autocorrelation over lag range covering 60–200 BPM
  const fps    = sampleRate / HOP;
  const lagMin = Math.max(1, Math.floor(fps * 60 / 200));
  const lagMax = Math.ceil(fps * 60 / 60);

  let bestLag = lagMin, bestCorr = -Infinity;
  for (let lag = lagMin; lag <= lagMax; lag++) {
    let corr = 0;
    const limit = onset.length - lag;
    for (let i = 0; i < limit; i++) corr += onset[i] * onset[i + lag];
    if (corr > bestCorr) { bestCorr = corr; bestLag = lag; }
  }

  const bpm = (fps * 60) / bestLag;
  if (bpm < 58 || bpm > 205) return undefined;
  return Math.round(bpm);
}

// ─── Key detection (Goertzel chroma + Krumhansl-Schmuckler) ───────────────────

const NOTE_NAMES   = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
// Krumhansl major and minor key profiles (correlation templates)
const MAJOR_PROFILE = [6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88];
const MINOR_PROFILE = [6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17];

/** Goertzel algorithm: power of signal at a single frequency. O(N) per freq. */
function goertzelPower(frame: Float32Array, freq: number, sampleRate: number): number {
  const N     = frame.length;
  const omega = (2 * Math.PI * freq) / sampleRate;
  const coeff = 2 * Math.cos(omega);
  let s1 = 0, s2 = 0;
  for (let n = 0; n < N; n++) {
    const s0 = frame[n] + coeff * s1 - s2;
    s2 = s1; s1 = s0;
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

function pearson(a: Float32Array, b: number[]): number {
  const n = a.length;
  let sumA = 0, sumB = 0;
  for (let i = 0; i < n; i++) { sumA += a[i]; sumB += b[i]; }
  const mA = sumA / n, mB = sumB / n;
  let num = 0, dA = 0, dB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - mA, db = b[i] - mB;
    num += da * db; dA += da * da; dB += db * db;
  }
  return num / (Math.sqrt(dA * dB) + 1e-10);
}

function detectKey(samples: Float32Array, sampleRate: number): string | undefined {
  const WINDOW    = 8192;
  const HOP       = 8192; // no overlap — speed matters more than precision here
  const MAX_SAMPS = Math.min(samples.length, sampleRate * 30); // first 30 s is enough

  const chroma = new Float32Array(12);

  for (let start = 0; start + WINDOW <= MAX_SAMPS; start += HOP) {
    // Hann window to reduce spectral leakage
    const frame = new Float32Array(WINDOW);
    for (let i = 0; i < WINDOW; i++) {
      frame[i] = samples[start + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (WINDOW - 1)));
    }

    // Accumulate Goertzel power across octaves 3–6 for each pitch class
    for (let p = 0; p < 12; p++) {
      let power = 0;
      for (let octave = 3; octave <= 6; octave++) {
        const midi = 12 * octave + p;
        const freq = 440 * Math.pow(2, (midi - 69) / 12);
        if (freq < sampleRate / 2) power += goertzelPower(frame, freq, sampleRate);
      }
      chroma[p] += power;
    }
  }

  // Normalize chroma to [0, 1]
  const maxVal = Math.max(...chroma);
  if (maxVal === 0) return undefined;
  for (let i = 0; i < 12; i++) chroma[i] /= maxVal;

  // Correlate against all 24 key templates (12 major + 12 minor)
  let bestKey = 'C major', bestCorr = -Infinity;
  for (let root = 0; root < 12; root++) {
    const rotMaj = [...MAJOR_PROFILE.slice(root), ...MAJOR_PROFILE.slice(0, root)];
    const rotMin = [...MINOR_PROFILE.slice(root), ...MINOR_PROFILE.slice(0, root)];
    const cMaj = pearson(chroma, rotMaj);
    const cMin = pearson(chroma, rotMin);
    if (cMaj > bestCorr) { bestCorr = cMaj; bestKey = `${NOTE_NAMES[root]} major`; }
    if (cMin > bestCorr) { bestCorr = cMin; bestKey = `${NOTE_NAMES[root]} minor`; }
  }
  return bestKey;
}

// ─── Tag / prompt builders ─────────────────────────────────────────────────────

function buildTags(a: Omit<AudioAnalysis, 'suggested_tags' | 'suggested_prompt'>): string {
  const parts: string[] = [];
  if (a.genre.length) parts.push(...a.genre);
  if (a.bpm)          parts.push(`${a.bpm} bpm`);
  if (a.key)          parts.push(a.key);
  if (a.bpm)          parts.push(a.bpm_label);
  return parts.join(', ');
}

function buildPrompt(a: Omit<AudioAnalysis, 'suggested_tags' | 'suggested_prompt'>): string {
  const parts: string[] = [];
  if (a.genre.length) parts.push(a.genre.join(', ') + ' style');
  if (a.bpm)          parts.push(`${a.bpm} BPM`);
  if (a.key)          parts.push(`key of ${a.key}`);
  return parts.join(', ') || 'instrumental music';
}

// ─── Public API ───────────────────────────────────────────────────────────────

async function analyzeCore(buffer: Buffer, mimeType?: string): Promise<AudioAnalysis> {
  // Step 1 — extract embedded metadata (BPM/key from ID3 tags if present)
  const meta = await mm.parseBuffer(buffer, mimeType ? { mimeType } : undefined);
  let bpm  = meta.common.bpm  ? Math.round(meta.common.bpm) : undefined;
  let key  = meta.common.key  || undefined;
  const genre    = meta.common.genre ?? [];
  const duration = meta.format.duration ? Math.round(meta.format.duration) : undefined;

  // Step 2 — fill in missing values by analyzing the audio waveform
  if (!bpm || !key) {
    try {
      const mono = await decodeToMono(buffer);
      if (!bpm) bpm = detectBpm(mono, TARGET_SR);
      if (!key) key = detectKey(mono, TARGET_SR);
    } catch (err) {
      console.warn('[audioAnalyzer] Waveform analysis failed:', (err as Error).message);
    }
  }

  const base = {
    bpm,
    bpm_label: bpm ? bpmLabel(bpm) : ('medium' as const),
    key,
    genre,
    duration,
    format: meta.format.container?.toLowerCase(),
    artist: meta.common.artist,
    title:  meta.common.title,
  };

  return { ...base, suggested_tags: buildTags(base), suggested_prompt: buildPrompt(base) };
}

/** Analyze an audio buffer (e.g. from a file upload). */
export async function analyzeBuffer(buffer: Buffer, mimeType?: string): Promise<AudioAnalysis> {
  return analyzeCore(buffer, mimeType);
}

/** Analyze audio from a remote URL (fetches the file). */
export async function analyzeUrl(url: string): Promise<AudioAnalysis> {
  const res = await fetch(url, { headers: { 'User-Agent': 'suno-api-analyzer/1.0' } });
  if (!res.ok) throw new Error(`Failed to fetch audio: ${res.status} ${res.statusText}`);
  const mimeType = res.headers.get('content-type') ?? undefined;
  const buf = Buffer.from(await res.arrayBuffer());
  return analyzeCore(buf, mimeType);
}

/**
 * Merge detected tags with user-provided overrides.
 * - tags_override fully replaces detected tags
 * - extra_tags are appended to detected tags
 */
export function buildFinalTags(analysis: AudioAnalysis, opts: {
  extra_tags?: string;
  tags_override?: string;
}): string {
  if (opts.tags_override) return opts.tags_override;
  const base = analysis.suggested_tags;
  if (opts.extra_tags) return base ? `${base}, ${opts.extra_tags}` : opts.extra_tags;
  return base;
}
