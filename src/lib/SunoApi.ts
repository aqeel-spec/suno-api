import axios, { AxiosInstance } from 'axios';
import UserAgent from 'user-agents';
import pino from 'pino';
import yn from 'yn';
import { isPage, sleep, waitForRequests, AsyncMutex, AsyncSemaphore } from '@/lib/utils';
import * as cookie from 'cookie';
import { randomUUID } from 'node:crypto';
import { Solver } from '@2captcha/captcha-solver';
import { paramsCoordinates } from '@2captcha/captcha-solver/dist/structs/2captcha';
import { BrowserContext, Page, Locator, chromium, firefox } from 'rebrowser-playwright-core';
import { createCursor, Cursor } from 'ghost-cursor-playwright';
import { promises as fs } from 'fs';
import path from 'node:path';

// sunoApi instance caching
const globalForSunoApi = global as unknown as {
  sunoApiCache?: Map<string, SunoApi>;
  generatedAssetsStore?: GeneratedAsset[];
};
const cache = globalForSunoApi.sunoApiCache || new Map<string, SunoApi>();
globalForSunoApi.sunoApiCache = cache;

const logger = pino();
export const FALLBACK_MODEL = 'chirp-crow'; // v5 Pro — hardcoded fallback if API detection fails
export let DEFAULT_MODEL = FALLBACK_MODEL;
const WINDOWS_BROWSER_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];

/**
 * Tracks every asset produced by a generation call so consumers can look up
 * the Suno-provided thumbnail (`image_url`) instead of re-generating one.
 */
export interface GeneratedAsset {
  id: string;
  title?: string;
  image_url?: string;
  audio_url?: string;
  video_url?: string;
  model_name?: string;
  tags?: string;
  duration?: string;
  status: string;
  source: 'generate' | 'custom_generate' | 'generate_sounds' | 'extend_audio' | 'generate_stems' | 'concatenate';
  created_at: string;
  recorded_at: string;
}

const generatedAssets: GeneratedAsset[] = globalForSunoApi.generatedAssetsStore || [];
globalForSunoApi.generatedAssetsStore = generatedAssets;

function recordAssets(audios: AudioInfo[], source: GeneratedAsset['source']): void {
  const now = new Date().toISOString();
  for (const a of audios) {
    const existing = generatedAssets.find(r => r.id === a.id);
    if (existing) {
      Object.assign(existing, {
        title: a.title ?? existing.title,
        image_url: a.image_url ?? existing.image_url,
        audio_url: a.audio_url ?? existing.audio_url,
        video_url: a.video_url ?? existing.video_url,
        model_name: a.model_name ?? existing.model_name,
        tags: a.tags ?? existing.tags,
        duration: a.duration ?? existing.duration,
        status: a.status,
        recorded_at: now,
      });
    } else {
      generatedAssets.unshift({
        id: a.id,
        title: a.title,
        image_url: a.image_url,
        audio_url: a.audio_url,
        video_url: a.video_url,
        model_name: a.model_name,
        tags: a.tags,
        duration: a.duration,
        status: a.status,
        source,
        created_at: a.created_at,
        recorded_at: now,
      });
    }
  }
}

async function findSystemBrowserExecutable(): Promise<string | undefined> {
  if (process.platform !== 'win32') {
    return undefined;
  }

  for (const candidate of WINDOWS_BROWSER_CANDIDATES) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }

  return undefined;
}

export function getGeneratedAssets(): GeneratedAsset[] {
  return generatedAssets;
}

export function getGeneratedAssetById(id: string): GeneratedAsset | undefined {
  return generatedAssets.find(a => a.id === id);
}

export interface AlignedWord {
  word: string;
  start_s: number;
  end_s: number;
  success?: boolean;
  p_align?: number;
}

export interface AudioInfo {
  id: string;
  title?: string;
  image_url?: string;
  lyric?: string;
  audio_url?: string;
  video_url?: string;
  created_at: string;
  model_name: string;
  gpt_description_prompt?: string;
  prompt?: string;
  status: string;
  type?: string;
  tags?: string;
  negative_tags?: string;
  duration?: string;
  error_message?: string;
  aligned_lyrics?: AlignedWord[];
}
