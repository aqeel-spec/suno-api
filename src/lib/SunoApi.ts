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
const globalForSunoApi = global as unknown as { sunoApiCache?: Map<string, SunoApi> };
const cache = globalForSunoApi.sunoApiCache || new Map<string, SunoApi>();
globalForSunoApi.sunoApiCache = cache;

const logger = pino();
export const DEFAULT_MODEL = 'chirp-crow'; // v5 Pro

export interface AudioInfo {
  id: string; // Unique identifier for the audio
  title?: string; // Title of the audio
  image_url?: string; // URL of the image associated with the audio
  lyric?: string; // Lyrics of the audio
  audio_url?: string; // URL of the audio file
  video_url?: string; // URL of the video associated with the audio
  created_at: string; // Date and time when the audio was created
  model_name: string; // Name of the model used for audio generation
  gpt_description_prompt?: string; // Prompt for GPT description
  prompt?: string; // Prompt for audio generation
  status: string; // Status
  type?: string;
  tags?: string; // Genre of music.
  negative_tags?: string; // Negative tags of music.
  duration?: string; // Duration of the audio
  error_message?: string; // Error message if any
}

/**
 * Advanced generation options matching Suno's "More Options" panel.
 */
export interface AdvancedOptions {
  /** Vocal gender preference: "male" or "female". Omit for no preference. */
  vocal_gender?: 'male' | 'female';
  /** Weirdness / creativity constraint (0.0 to 1.0, default ~0.5). */
  weirdness?: number;
  /** Style influence / weight (0.0 to 1.0, default ~0.5). */
  style_influence?: number;
  /** Persona UUID to use for voice cloning. */
  persona_id?: string;
}

interface PersonaResponse {
  persona: {
    id: string;
    name: string;
    description: string;
    image_s3_id: string;
    root_clip_id: string;
    clip: any; // You can define a more specific type if needed
    user_display_name: string;
    user_handle: string;
    user_image_url: string;
    persona_clips: Array<{
      clip: any; // You can define a more specific type if needed
    }>;
    is_suno_persona: boolean;
    is_trashed: boolean;
    is_owned: boolean;
    is_public: boolean;
    is_public_approved: boolean;
    is_loved: boolean;
    upvote_count: number;
    clip_count: number;
  };
  total_results: number;
  current_page: number;
  is_following: boolean;
}

class SunoApi {
  private static BASE_URL: string = 'https://studio-api.prod.suno.com';
  private static CLERK_BASE_URL: string = 'https://clerk.suno.com';
  private static CLERK_VERSION = '5.15.0';

  private readonly client: AxiosInstance;
  private sid?: string;
  private currentToken?: string;
  private deviceId?: string;
  private userAgent?: string;
  private cookies: Record<string, string | undefined>;
  private solver = new Solver(process.env.TWOCAPTCHA_KEY + '');
  private ghostCursorEnabled = yn(process.env.BROWSER_GHOST_CURSOR, { default: false });
  private keepBrowserOpen = yn(process.env.BROWSER_KEEP_OPEN, {
    default: !yn(process.env.BROWSER_HEADLESS, { default: true })
  });
  private cursor?: Cursor;

  // Persistent browser for reuse across requests (when BROWSER_KEEP_OPEN=true)
  private _browserContext: BrowserContext | null = null;
  private _browserPage: Page | null = null;

  // Concurrency control
  private keepAliveMutex = new AsyncMutex();
  private captchaMutex = new AsyncMutex();
  private requestSemaphore = new AsyncSemaphore(
    parseInt(process.env.CONCURRENT_LIMIT || '3', 10)
  );
  private lastKeepAliveTime = 0;
  private static readonly KEEPALIVE_COOLDOWN_MS = 30_000; // skip refresh if < 30s ago
  private requestCounter = 0;
  private capturedBrowserModel: string | null = null; // mv field captured from the browser's intercepted generate request
  private capturedBrowserEndpoint: string | null = null; // generate endpoint path captured from the browser's intercepted request
  private capturedSoundsEndpoint: string | null = null; // sounds endpoint path captured from the browser's intercepted request
  private capturedTurnstileSitekey: string | null = null; // Turnstile sitekey captured from network requests

  private isHeadlessBrowser(): boolean {
    return yn(process.env.BROWSER_HEADLESS, { default: true });
  }

  private shouldKeepBrowserOpen(): boolean {
    return this.keepBrowserOpen && !this.isHeadlessBrowser();
  }

  constructor(cookies: string) {
    this.userAgent = new UserAgent(/Macintosh/).random().toString(); // Usually Mac systems get less amount of CAPTCHAs
    this.cookies = cookie.parse(cookies);
    this.deviceId = this.cookies.ajs_anonymous_id || randomUUID();
    this.client = axios.create({
      withCredentials: true,
      headers: {
        'Affiliate-Id': 'undefined',
        'Device-Id': `"${this.deviceId}"`,
        'sec-ch-ua': '"Google Chrome";v="130", "Chromium";v="130", "Not?A_Brand";v="99"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"macOS"',
        'User-Agent': this.userAgent
      }
    });
    this.client.interceptors.request.use(config => {
      if (this.currentToken && !config.headers.Authorization)
        config.headers.Authorization = `Bearer ${this.currentToken}`;
      const cookiesArray = Object.entries(this.cookies).map(([key, value]) => 
        cookie.serialize(key, value as string)
      );
      config.headers.Cookie = cookiesArray.join('; ');
      return config;
    });
    this.client.interceptors.response.use(resp => {
      const setCookieHeader = resp.headers['set-cookie'];
      if (Array.isArray(setCookieHeader)) {
        const newCookies = cookie.parse(setCookieHeader.join('; '));
        for (const [key, value] of Object.entries(newCookies)) {
          this.cookies[key] = value;
        }
      }
      return resp;
    })
  }

  public async init(): Promise<SunoApi> {
    //await this.getClerkLatestVersion();
    await this.getAuthToken();
    await this.keepAlive();
    await this.logStartupInfo();
    return this;
  }

  /**
   * Fetches available Suno models and logs a full startup summary.
   */
  private async logStartupInfo(): Promise<void> {
    // Try to fetch available models from Suno
    let modelsBlock = '  (could not fetch — models endpoint unavailable)';
    try {
      const res = await this.client.get(`${SunoApi.BASE_URL}/api/model_overview/`, { timeout: 8000 });
      const data = res.data;
      // Suno returns either an array or an object with a list property
      const list: any[] = Array.isArray(data) ? data
        : Array.isArray(data?.models) ? data.models
        : Array.isArray(data?.data)   ? data.data
        : [];
      if (list.length > 0) {
        modelsBlock = list.map((m: any) => {
          const id      = m.id ?? m.name ?? m.model_id ?? m.mv ?? JSON.stringify(m);
          const label   = m.display_name ?? m.title ?? m.label ?? '';
          const status  = m.status ?? m.state ?? '';
          const isDefault = id === DEFAULT_MODEL;
          return `  ${isDefault ? '👉' : '  '} ${id}${label ? ` — ${label}` : ''}${status ? ` [${status}]` : ''}${isDefault ? '  ← DEFAULT' : ''}`;
        }).join('\n');
      } else {
        modelsBlock = `  (endpoint returned no model list — raw: ${JSON.stringify(data).slice(0, 120)})`;
      }
    } catch {
      // Silently fall back — the block stays as the error string above
    }

    const sep = '═'.repeat(55);
    const thin = '─'.repeat(55);
    logger.info(
      `\n${sep}\n` +
      `🚀  SUNO-API  —  STARTUP\n` +
      `${sep}\n` +
      `⚙️   CONFIGURATION\n` +
      `${thin}\n` +
      `🌐  Browser             : ${(process.env.BROWSER ?? 'chromium').toUpperCase()}\n` +
      `🖥️   Headless            : ${this.isHeadlessBrowser() ? '✅ Yes (hidden)' : '❌ No (visible window)'}\n` +
      `🪟  Keep browser open   : ${this.shouldKeepBrowserOpen() ? '✅ Yes' : '❌ No'}\n` +
      `🔒  Force CAPTCHA       : ${yn(process.env.BROWSER_FORCE_CAPTCHA, { default: false }) ? '✅ Always solve' : '❌ Auto (check endpoint)'}\n` +
      `👻  Ghost cursor        : ${yn(process.env.BROWSER_GHOST_CURSOR, { default: false }) ? '✅ Yes' : '❌ No'}\n` +
      `🌍  Browser locale      : ${process.env.BROWSER_LOCALE ?? 'en'}\n` +
      `🔀  Concurrent limit    : ${process.env.CONCURRENT_LIMIT ?? '3'} request(s)\n` +
      `⏱️   CAPTCHA UI timeout  : ${process.env.SUNO_CAPTCHA_UI_TIMEOUT_MS ?? '180000'} ms\n` +
      `⏱️   CAPTCHA token timeout: ${process.env.SUNO_CAPTCHA_TOKEN_TIMEOUT_MS ?? '180000'} ms\n` +
      `🔑  2Captcha key        : ${process.env.TWOCAPTCHA_KEY ? process.env.TWOCAPTCHA_KEY.slice(0, 6) + '…' + process.env.TWOCAPTCHA_KEY.slice(-4) : '❌ NOT SET'}\n` +
      `🍪  Cookie present      : ${process.env.SUNO_COOKIE ? '✅' : '❌'} (${process.env.SUNO_COOKIE?.length ?? 0} chars)\n` +
      `${thin}\n` +
      `🤖  AVAILABLE MODELS    (default: ${DEFAULT_MODEL})\n` +
      `${thin}\n` +
      `${modelsBlock}\n` +
      `${sep}`
    );
  }

  /**
   * Get the clerk package latest version id.
   * This method is commented because we are now using a hard-coded Clerk version, hence this method is not needed.
   
  private async getClerkLatestVersion() {
    // URL to get clerk version ID
    const getClerkVersionUrl = `${SunoApi.JSDELIVR_BASE_URL}/v1/package/npm/@clerk/clerk-js`;
    // Get clerk version ID
    const versionListResponse = await this.client.get(getClerkVersionUrl);
    if (!versionListResponse?.data?.['tags']['latest']) {
      throw new Error(
        'Failed to get clerk version info, Please try again later'
      );
    }
    // Save clerk version ID for auth
    SunoApi.clerkVersion = versionListResponse?.data?.['tags']['latest'];
  }
  */

  /**
   * Get the session ID and save it for later use.
   */
  private async getAuthToken() {
    logger.info('Getting the session ID');
    // URL to get session ID
    const getSessionUrl = `${SunoApi.CLERK_BASE_URL}/v1/client?_is_native=true&_clerk_js_version=${SunoApi.CLERK_VERSION}`;
    // Get session ID
    const sessionResponse = await this.client.get(getSessionUrl, {
      headers: { Authorization: this.cookies.__client }
    });
    if (!sessionResponse?.data?.response?.last_active_session_id) {
      throw new Error(
        'Failed to get session id, you may need to update the SUNO_COOKIE'
      );
    }
    // Save session ID for later use
    this.sid = sessionResponse.data.response.last_active_session_id;
  }

  /**
   * Keep the session alive.
   * Uses a mutex to prevent concurrent token refreshes, and a cooldown
   * so rapid back-to-back calls skip redundant refreshes.
   * @param isWait Indicates if the method should wait for the session to be fully renewed before returning.
   */
  public async keepAlive(isWait?: boolean): Promise<void> {
    if (!this.sid) {
      throw new Error('Session ID is not set. Cannot renew token.');
    }

    // Fast path: skip if recently refreshed (avoids mutex contention)
    const now = Date.now();
    if (this.currentToken && now - this.lastKeepAliveTime < SunoApi.KEEPALIVE_COOLDOWN_MS) {
      return;
    }

    const release = await this.keepAliveMutex.acquire();
    try {
      // Double-check after acquiring lock (another caller may have refreshed while we waited)
      if (this.currentToken && Date.now() - this.lastKeepAliveTime < SunoApi.KEEPALIVE_COOLDOWN_MS) {
        return;
      }

      // URL to renew session token
      const renewUrl = `${SunoApi.CLERK_BASE_URL}/v1/client/sessions/${this.sid}/tokens?_is_native=true&_clerk_js_version=${SunoApi.CLERK_VERSION}`;
      // Renew session token
      logger.info('KeepAlive...\n');
      const renewResponse = await this.client.post(renewUrl, {}, {
        headers: { Authorization: this.cookies.__client }
      });
      if (isWait) {
        await sleep(1, 2);
      }
      const newToken = renewResponse.data.jwt;
      // Update Authorization field in request header with the new JWT token
      this.currentToken = newToken;
      this.lastKeepAliveTime = Date.now();
    } finally {
      release();
    }
  }

  /**
   * Get the session token (not to be confused with session ID) and save it for later use.
   */
  private async getSessionToken() {
    const tokenResponse = await this.client.post(
      `${SunoApi.BASE_URL}/api/user/create_session_id/`,
      {
        session_properties: JSON.stringify({ deviceId: this.deviceId }),
        session_type: 1
      }
    );
    return tokenResponse.data.session_id;
  }

  private async captchaRequired(): Promise<boolean> {
    const resp = await this.client.post(`${SunoApi.BASE_URL}/api/c/check`, {
      ctype: 'generation'
    });
    logger.info(resp.data);
    return resp.data.required;
  }

  /**
   * Clicks on a locator or XY vector. This method is made because of the difference between ghost-cursor-playwright and Playwright methods
   */
  private async click(target: Locator|Page, position?: { x: number, y: number }): Promise<void> {
    if (this.ghostCursorEnabled) {
      let pos: any = isPage(target) ? { x: 0, y: 0 } : await target.boundingBox();
      if (position) 
        pos = {
          ...pos,
          x: pos.x + position.x,
          y: pos.y + position.y,
          width: null,
          height: null,
        };
      return this.cursor?.actions.click({
        target: pos
      });
    } else {
      if (isPage(target))
        return target.mouse.click(position?.x ?? 0, position?.y ?? 0);
      else
        return target.click({ force: true, position });
    }
  }

  /**
   * Fill a React controlled input/textarea reliably.
   *
   * The core problem: React installs an instance-level `value` property
   * descriptor on controlled inputs. When onChange fires, React reads
   * `e.target.value` through this instance getter, which returns React's
   * internal tracked value (the OLD state), not the DOM value we just set.
   * So `setState(e.target.value)` sets state to "" and the textarea stays empty.
   *
   * Approach 1 — Override instance getter + native setter + _valueTracker reset.
   * We temporarily override React's instance `value` getter to return our
   * new value, then dispatch events. When React's onChange reads
   * `e.target.value`, it gets OUR value, and setState works correctly.
   *
   * Approach 2 — ClipboardEvent paste with synthetic clipboardData.
   * Suno's textarea may handle paste events by reading clipboardData
   * rather than target.value, bypassing the instance getter issue.
   *
   * Approach 3 — Direct React fiber state setter dispatch.
   * Walk the fiber tree to find the useState hook managing this textarea
   * and call the dispatch function directly to set React state.
   *
   * NOTE: keyboard.type() is NOT used — it sends individual keydown/keyup
   * events that trigger Suno's keyboard shortcuts. keyboard.insertText() is
   * preferred (used in the caller) because it uses the browser's native text
   * input pipeline without firing key events. This reactFill method serves as
   * a fallback when insertText doesn't work.
   */
  private async reactFill(locator: Locator, value: string): Promise<void> {
    // --- Approach 1: Override instance value getter + native setter + _valueTracker ---
    await locator.focus();
    await new Promise(r => setTimeout(r, 100));
    const diag1 = await locator.evaluate((el: Element, v: string) => {
      const textarea = el as HTMLTextAreaElement;
      const proto = el.tagName === 'TEXTAREA'
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      const nativeGetter = Object.getOwnPropertyDescriptor(proto, 'value')?.get;
      const hasTracker = '_valueTracker' in el;
      const hasInstanceValue = el.hasOwnProperty('value');
      const isFocused = document.activeElement === el;
      const reactKeys = Object.keys(el).filter(k => k.startsWith('__react'));

      textarea.focus();

      // Step 1: Set the DOM value via native prototype setter
      if (nativeSetter) nativeSetter.call(el, v);
      else textarea.value = v;

      // Step 2: Read DOM value via native getter to verify it was set
      const domValue = nativeGetter ? nativeGetter.call(el) : '';

      // Step 3: If React has an instance-level value descriptor, temporarily
      // override its getter to return our new value. This is critical because
      // React's onChange handler reads `e.target.value` through this getter.
      const instanceDesc = Object.getOwnPropertyDescriptor(el, 'value');
      let overrodeGetter = false;
      if (instanceDesc && instanceDesc.configurable) {
        Object.defineProperty(el, 'value', {
          get: function() { return v; },
          set: instanceDesc.set || function(val: string) {
            if (nativeSetter) nativeSetter.call(el, val);
          },
          configurable: true,
          enumerable: instanceDesc.enumerable ?? true,
        });
        overrodeGetter = true;
      } else if (hasInstanceValue) {
        // Instance property but not configurable — try deleting it
        try {
          delete (el as any).value;
          if (nativeSetter) nativeSetter.call(el, v);
          overrodeGetter = true;
        } catch {}
      }

      // Step 4: Reset React's internal value tracker
      if (hasTracker) {
        (el as any)._valueTracker.setValue('');
      }

      // Step 5: Dispatch InputEvent — React's event delegation handles this
      // React's onChange handler fires synchronously during dispatchEvent and reads
      // e.target.value through our overridden getter, getting our value.
      el.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        cancelable: false,
        inputType: 'insertText',
        data: v,
      }));
      el.dispatchEvent(new Event('change', { bubbles: true }));

      // Step 6: Restore the original descriptor so React can manage the element again.
      // React's onChange already ran synchronously during dispatchEvent above and
      // captured our value. Now let React reinstall its own descriptor on re-render.
      if (overrodeGetter && instanceDesc) {
        try {
          Object.defineProperty(el, 'value', instanceDesc);
        } catch {
          // If we can't restore, at least delete our override
          try { delete (el as any).value; } catch {}
        }
      }

      // Read what el.value returns now (through whatever getter is active)
      const readbackValue = textarea.value;

      return {
        hasNativeSetter: !!nativeSetter,
        hasTracker,
        hasInstanceValue,
        isFocused,
        overrodeGetter,
        domValue: domValue?.substring(0, 40) || '',
        readbackValue: readbackValue?.substring(0, 40) || '',
        reactKeys: reactKeys.join(','),
      };
    }, value);
    logger.info(
      `reactFill[1] diag: setter=${diag1.hasNativeSetter}, tracker=${diag1.hasTracker}, ` +
      `instanceValue=${diag1.hasInstanceValue}, overrodeGetter=${diag1.overrodeGetter}, ` +
      `focused=${diag1.isFocused}, domValue="${diag1.domValue}", ` +
      `readback="${diag1.readbackValue}", keys=[${diag1.reactKeys}]`
    );

    // Wait for React to process the event and re-render
    await new Promise(r => setTimeout(r, 500));
    const val1 = await locator.evaluate((el: Element, v: string) => {
      // Read via native getter to check DOM value
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const nativeGetter = Object.getOwnPropertyDescriptor(proto, 'value')?.get;
      const domValue = nativeGetter ? nativeGetter.call(el) : '';
      const instanceValue = (el as HTMLTextAreaElement).value || '';

      // Also check React fiber state directly — this is the ground truth
      let fiberValue: string | null = null;
      const fiberKey = Object.keys(el).find(k => k.startsWith('__reactFiber$'));
      if (fiberKey) {
        let fiber = (el as any)[fiberKey];
        // Walk up the fiber tree to find the component that owns this textarea
        for (let i = 0; i < 15 && fiber; i++) {
          if (fiber.memoizedState) {
            let hook = fiber.memoizedState;
            while (hook) {
              if (hook.queue && typeof hook.memoizedState === 'string') {
                if (hook.memoizedState === v) {
                  fiberValue = hook.memoizedState;
                  break;
                }
              }
              hook = hook.next;
            }
            if (fiberValue) break;
          }
          fiber = fiber.return;
        }
      }

      return { domValue, instanceValue, fiberValue };
    }, value).catch(() => ({ domValue: '', instanceValue: '', fiberValue: null as string | null }));

    if (val1.fiberValue === value || val1.instanceValue === value || val1.domValue === value) {
      logger.info(
        `reactFill: approach 1 succeeded (dom="${val1.domValue?.substring(0, 20)}", ` +
        `instance="${val1.instanceValue?.substring(0, 20)}", ` +
        `fiber=${val1.fiberValue ? 'matched' : 'null'})`
      );
      return;
    }
    logger.warn(
      `reactFill[1] after render: dom="${(val1.domValue || '').substring(0, 30)}", ` +
      `instance="${(val1.instanceValue || '').substring(0, 30)}", ` +
      `fiber=${val1.fiberValue ? 'matched' : 'null'} — trying paste`
    );

    // --- Approach 2: ClipboardEvent paste ---
    await locator.focus();
    await new Promise(r => setTimeout(r, 100));
    const diag2 = await locator.evaluate((el: Element, v: string) => {
      const textarea = el as HTMLTextAreaElement;
      textarea.focus();
      textarea.select();

      // Create a DataTransfer with our text
      const dt = new DataTransfer();
      dt.setData('text/plain', v);
      const pasteEvent = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: dt,
      });
      const dispatched = el.dispatchEvent(pasteEvent);

      // If paste was not prevented, the browser should insert the text.
      // For React controlled components, the paste handler likely reads
      // clipboardData and calls setState.
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const nativeGetter = Object.getOwnPropertyDescriptor(proto, 'value')?.get;
      return {
        dispatched,
        domValue: (nativeGetter ? nativeGetter.call(el) : '')?.substring(0, 40) || '',
        instanceValue: textarea.value?.substring(0, 40) || '',
      };
    }, value);
    logger.info(
      `reactFill[2] paste: dispatched=${diag2.dispatched}, ` +
      `dom="${diag2.domValue}", instance="${diag2.instanceValue}"`
    );

    await new Promise(r => setTimeout(r, 500));
    const val2 = await locator.evaluate((el: Element) => {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const nativeGetter = Object.getOwnPropertyDescriptor(proto, 'value')?.get;
      return {
        domValue: nativeGetter ? nativeGetter.call(el) : '',
        instanceValue: (el as HTMLTextAreaElement).value || '',
      };
    }).catch(() => ({ domValue: '', instanceValue: '' }));
    if (val2.instanceValue === value || val2.domValue === value) {
      logger.info('reactFill: paste approach succeeded');
      return;
    }
    logger.warn(
      `reactFill[2] after delay: dom="${(val2.domValue || '').substring(0, 30)}", ` +
      `instance="${(val2.instanceValue || '').substring(0, 30)}" — trying fiber setState`
    );

    // --- Approach 3: Direct React fiber state setter ---
    const diag3 = await locator.evaluate((el: Element, v: string) => {
      // Walk the fiber tree to find all useState hooks and try setting the value
      const fiberKey = Object.keys(el).find(
        k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
      );
      if (!fiberKey) return { found: false, reason: 'no fiber key' };

      let dispatched = false;
      let fiber = (el as any)[fiberKey];
      // Walk up the tree to find the component managing this textarea's state
      for (let depth = 0; depth < 20 && fiber; depth++) {
        // Function components (tag=0) have hooks in memoizedState
        if (fiber.tag === 0 && fiber.memoizedState) {
          // Walk the linked list of hooks
          let hook = fiber.memoizedState;
          let hookIndex = 0;
          while (hook) {
            // useState/useReducer hooks have a queue with dispatch
            if (hook.queue && typeof hook.queue.dispatch === 'function') {
              // Check if this hook's state looks like it could be the textarea value
              // (it's a string, and either empty or matches current value pattern)
              const currentVal = hook.memoizedState;
              if (typeof currentVal === 'string') {
                hook.queue.dispatch(v);
                dispatched = true;
              }
            }
            hook = hook.next;
            hookIndex++;
          }
        }

        // Also try calling onChange on __reactProps$ with a proper mock event
        const propsKey = Object.keys(fiber.stateNode || {}).find?.(
          k => k.startsWith('__reactProps$')
        );
        if (propsKey && fiber.stateNode) {
          const props = (fiber.stateNode as any)[propsKey];
          if (typeof props?.onChange === 'function') {
            // Create a mock event where target.value returns our value
            const mockTarget = Object.create(el, {
              value: { get: () => v, configurable: true },
            });
            props.onChange({
              target: mockTarget,
              currentTarget: mockTarget,
              type: 'change',
              preventDefault: () => {},
              stopPropagation: () => {},
            });
            dispatched = true;
          }
        }

        fiber = fiber.return;
      }
      return { found: true, dispatched };
    }, value);
    logger.info(`reactFill[3] fiber setState: ${JSON.stringify(diag3)}`);

    await new Promise(r => setTimeout(r, 500));
    const val3 = await locator.evaluate((el: Element) => {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const nativeGetter = Object.getOwnPropertyDescriptor(proto, 'value')?.get;
      return {
        domValue: nativeGetter ? nativeGetter.call(el) : '',
        instanceValue: (el as HTMLTextAreaElement).value || '',
      };
    }).catch(() => ({ domValue: '', instanceValue: '' }));
    if (val3.instanceValue === value || val3.domValue === value) {
      logger.info('reactFill: fiber setState succeeded');
    } else {
      logger.warn(
        `reactFill: ALL approaches failed — dom="${(val3.domValue || '').substring(0, 30)}", ` +
        `instance="${(val3.instanceValue || '').substring(0, 30)}"`
      );
    }
  }

  /**
   * Get the BrowserType from the `BROWSER` environment variable.
   * @returns {BrowserType} chromium, firefox or webkit. Default is chromium
   */
  private getBrowserType() {
    const browser = process.env.BROWSER?.toLowerCase();
    switch (browser) {
      case 'firefox':
        return firefox;
      /*case 'webkit': ** doesn't work with rebrowser-patches
      case 'safari':
        return webkit;*/
      default:
        return chromium;
    }
  }

  /**
   * Launches a browser with the necessary cookies
   * @returns {BrowserContext}
   */
  private async launchBrowser(): Promise<BrowserContext> {
    const args = [
      '--disable-blink-features=AutomationControlled',
      '--disable-web-security',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-features=site-per-process',
      '--disable-features=IsolateOrigins',
      '--disable-extensions',
      '--disable-infobars'
    ];
    // Check for GPU acceleration, as it is recommended to turn it off for Docker
    if (yn(process.env.BROWSER_DISABLE_GPU, { default: false }))
      args.push('--enable-unsafe-swiftshader',
        '--disable-gpu',
        '--disable-setuid-sandbox');
    const browser = await this.getBrowserType().launch({
      args,
      headless: yn(process.env.BROWSER_HEADLESS, { default: true })
    });
    const context = await browser.newContext({ userAgent: this.userAgent, locale: process.env.BROWSER_LOCALE, viewport: null });

    // Chrome CDP is very strict: cookie names/values must be RFC 6265 safe.
    // Sanitize names (no controls, no separators) and values (no controls, no ";").
    const INVALID_NAME_RE  = /[\x00-\x1F\x7F\s"',;\\()\[\]{}@:<>/?=]/;
    const sanitizeCookieValue = (v: unknown): string | null => {
      if (v == null || v === '' || v === 'undefined' || v === 'null') return null;
      const s = String(v).replace(/[\x00-\x1F\x7F]/g, '').replace(/;/g, '');
      return s.length > 0 ? s : null;
    };

    const lax: 'Lax' | 'Strict' | 'None' = 'Lax';
    const candidates: any[] = [];

    const sessionVal = sanitizeCookieValue(this.currentToken);
    if (sessionVal)
      candidates.push({ name: '__session', value: sessionVal, domain: '.suno.com', path: '/', sameSite: lax });

    for (const key in this.cookies) {
      if (!key || INVALID_NAME_RE.test(key)) continue;       // skip invalid names
      const val = sanitizeCookieValue(this.cookies[key]);
      if (!val) continue;
      candidates.push({ name: key, value: val, domain: '.suno.com', path: '/', sameSite: lax });
    }

    // Add cookies one-by-one; skip any that Chrome still rejects so the browser always opens.
    let added = 0, skipped = 0;
    for (const c of candidates) {
      try {
        await context.addCookies([c]);
        added++;
      } catch {
        logger.warn(`launchBrowser: skipped invalid cookie "${c.name}" (value len=${c.value.length})`);
        skipped++;
      }
    }
    logger.info(`launchBrowser: ${added} cookies added, ${skipped} skipped`);
    return context;
  }

  private async fetchPersonaWithBrowser(personaId: string, page: number): Promise<PersonaResponse> {
    const shouldReuse = this.shouldKeepBrowserOpen();
    let context = this._browserContext;
    let browserPage = this._browserPage;

    try {
      if (!context || !browserPage || browserPage.isClosed()) {
        context = await this.launchBrowser();
        browserPage = await context.newPage();
      }

      if (!browserPage.url().startsWith('https://suno.com/')) {
        await browserPage.goto('https://suno.com/create', {
          waitUntil: 'domcontentloaded',
          timeout: 60000
        });
      }

      const result = await browserPage.evaluate(
        async ({ personaId, page }) => {
          const response = await fetch(`/api/persona/get-persona-paginated/${personaId}/?page=${page}`, {
            credentials: 'include',
            headers: {
              accept: 'application/json, text/plain, */*'
            }
          });

          const text = await response.text();

          try {
            return {
              ok: response.ok,
              status: response.status,
              data: JSON.parse(text),
              text
            };
          } catch {
            return {
              ok: response.ok,
              status: response.status,
              data: null,
              text
            };
          }
        },
        { personaId, page }
      );

      if (!result.ok || !result.data?.persona) {
        throw new Error(
          `Browser persona fetch failed with status ${result.status}: ${result.text.slice(0, 300)}`
        );
      }

      if (shouldReuse) {
        this._browserContext = context;
        this._browserPage = browserPage;
      } else {
        this._browserContext = null;
        this._browserPage = null;
        await context.browser()?.close();
      }

      return result.data as PersonaResponse;
    } catch (error) {
      if (!shouldReuse) {
        this._browserContext = null;
        this._browserPage = null;
        await context?.browser()?.close().catch(() => undefined);
      }

      throw error;
    }
  }

  /**
   * Returns the first visible locator from a list of selectors.
   * Uses a raw delay to avoid log spam from the sleep() helper.
   */
  private async waitForAnyVisibleLocator(page: Page, selectors: string[], timeout = 30000): Promise<Locator | null> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      for (const selector of selectors) {
        const locator = page.locator(selector).first();
        const visible = await locator.isVisible().catch(() => false);
        if (visible)
          return locator;
      }
      await new Promise(r => setTimeout(r, 500));
    }
    return null;
  }

  /**
   * Saves full-page HTML, screenshot, and request log into the debug/ folder.
   */
  private async saveDebugSnapshot(page: Page, label: string, requestLog?: string[]): Promise<void> {
    const debugDir = path.join(process.cwd(), 'debug');
    try {
      await fs.mkdir(debugDir, { recursive: true });
      await fs.writeFile(path.join(debugDir, `${label}.html`), await page.content());
      await page.screenshot({ path: path.join(debugDir, `${label}.png`), fullPage: true });
      if (requestLog) {
        await fs.writeFile(path.join(debugDir, `${label}-requests.log`), requestLog.join('\n'));
      }
      // List all frames
      const frameUrls = page.frames().map(f => f.url());
      await fs.writeFile(path.join(debugDir, `${label}-frames.log`), frameUrls.join('\n'));
      logger.info(`Debug snapshot saved: debug/${label}.*`);
    } catch (e: any) {
      logger.warn(`Failed to save debug snapshot "${label}": ${e.message}`);
    }
  }

  /**
   * Wait for any CAPTCHA iframe to appear on the page.
   * Detects hCaptcha, reCAPTCHA, Cloudflare Turnstile, Arkose/FunCaptcha.
   * @returns The detected captcha type or null if none found.
   */
  private async waitForCaptchaFrame(page: Page, timeout = 30000): Promise<'hcaptcha' | 'recaptcha' | 'turnstile' | 'arkose' | null> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const frames = page.frames();
      for (const frame of frames) {
        const url = frame.url().toLowerCase();
        if (url.includes('hcaptcha.com') || url.includes('hcaptcha-endpoint-prod.suno.com') || url.includes('hcaptcha-assets-prod.suno.com')) return 'hcaptcha';
        if (url.includes('google.com/recaptcha') || url.includes('recaptcha')) return 'recaptcha';
        if (url.includes('challenges.cloudflare.com') || url.includes('turnstile')) return 'turnstile';
        if (url.includes('arkoselabs.com') || url.includes('funcaptcha')) return 'arkose';
      }
      // Also check for captcha iframes by title attribute
      for (const selector of [
        'iframe[title*="hCaptcha" i]',
        'iframe[title*="recaptcha" i]',
        'iframe[title*="Cloudflare" i]',
        'iframe[title*="challenge" i]',
        'iframe[src*="hcaptcha" i]',
        'iframe[src*="recaptcha" i]',
        'iframe[src*="turnstile" i]',
        'iframe[src*="arkoselabs" i]',
      ]) {
        const exists = await page.locator(selector).first().isVisible().catch(() => false);
        if (exists) {
          if (selector.includes('hCaptcha') || selector.includes('hcaptcha')) return 'hcaptcha';
          if (selector.includes('recaptcha')) return 'recaptcha';
          if (selector.includes('Cloudflare') || selector.includes('turnstile')) return 'turnstile';
          if (selector.includes('arkoselabs')) return 'arkose';
        }
      }
      await new Promise(r => setTimeout(r, 500));
    }
    return null;
  }

  /**
   * Checks for CAPTCHA verification and solves the CAPTCHA if needed.
   * v2: Saves debug snapshots (HTML, screenshots, request & frame logs) into debug/ folder
   * at every important step so you can inspect the actual page state.
   * Serialized via captchaMutex so only one browser session runs at a time.
   * @returns {string|null} hCaptcha token. If no verification is required, returns null
   */
  public async getCaptcha(force = false, tabMode: 'advanced' | 'sounds' = 'advanced'): Promise<string|null> {
    const isForced = force;
    if (!isForced && !await this.captchaRequired())
      return null;

    // Serialize CAPTCHA solving — only one browser session at a time
    const releaseCaptcha = await this.captchaMutex.acquire();
    if (this.captchaMutex.queueLength > 0)
      logger.info(`CAPTCHA mutex: ${this.captchaMutex.queueLength} request(s) waiting`);

    try {
      // Re-check after acquiring the lock — a previous caller may have solved it
      if (!force && !await this.captchaRequired())
        return null;

      // Always use the browser flow — externally-solved Turnstile tokens (via 2Captcha)
      // are rejected by Suno because they lack the proper Cloudflare session binding.
      // The browser's own invisible Turnstile produces tokens that Suno's backend accepts.
      return await this._solveCaptcha(tabMode);
    } finally {
      releaseCaptcha();
    }
  }

  /**
   * Internal CAPTCHA-solving logic (called under captchaMutex).
   */
  private async _solveCaptcha(tabMode: 'advanced' | 'sounds' = 'advanced'): Promise<string|null> {

    let browser!: BrowserContext;
    let page!: Page;
    let reused = false;

    // Try to reuse an existing browser from a previous BROWSER_KEEP_OPEN session
    if (this._browserContext && this._browserPage) {
      try {
        // Quick check: is the browser still alive?
        await this._browserPage.evaluate(() => document.title);
        browser = this._browserContext;
        page = this._browserPage;
        reused = true;
        logger.info('Reusing existing browser from previous request');
      } catch {
        // Browser was closed or crashed — clean up and launch fresh
        logger.info('Previous browser is no longer available — launching new one');
        try { await this._browserContext.browser()?.close(); } catch {}
        this._browserContext = null;
        this._browserPage = null;
      }
    }

    if (!reused) {
      logger.info('CAPTCHA required. Launching browser...');
      browser = await this.launchBrowser();
      page = await browser.newPage();
    }

    // Collect ALL network requests for debugging
    const requestLog: string[] = [];
    // On reuse, remove old route handlers to avoid stale callbacks
    if (reused) {
      await page.unroute('**/api/generate/**').catch(() => {});
    }
    page.on('request', (req: any) => {
      const url: string = req.url();
      if (!url.startsWith('data:') && !url.endsWith('.woff2') && !url.endsWith('.woff'))
        requestLog.push(`[${new Date().toISOString()}] ${req.method()} ${url}`);
      // Capture Turnstile sitekey from Cloudflare challenge-platform URLs
      if (url.includes('challenges.cloudflare.com') && !this.capturedTurnstileSitekey) {
        const m = url.match(/\/(0x[0-9a-zA-Z_-]{10,})\//);
        if (m) {
          this.capturedTurnstileSitekey = m[1];
          logger.info(`Captured Turnstile sitekey from network request: ${m[1]}`);
        }
      }
    });

    await page.goto('https://suno.com/create', {
      referer: 'https://www.google.com/',
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    logger.info('Waiting for Suno interface to load');
    // Wait for the page to actually settle
    try {
      await page.waitForLoadState('networkidle', { timeout: 30000 });
    } catch {
      logger.warn('Network did not reach idle state within 30s; continuing');
    }

    // --- Debug snapshot: page loaded ---
    await this.saveDebugSnapshot(page, '01-page-loaded', requestLog);

    if (this.ghostCursorEnabled)
      this.cursor = await createCursor(page);

    // Close any popups / modals / banners
    for (const closeSelector of [
      'button[aria-label="Close"]',
      '[aria-label="close"]',
      '[aria-label="Dismiss"]',
      'button:has-text("Got it")',
      'button:has-text("Accept")',
      'button:has-text("OK")',
    ]) {
      try {
        const closeBtn = page.locator(closeSelector).first();
        if (await closeBtn.isVisible({ timeout: 500 }).catch(() => false)) {
          await closeBtn.click({ timeout: 1000 });
          logger.info(`Closed popup via ${closeSelector}`);
        }
      } catch {}
    }

    // --- Discover the actual page structure ---
    // Log all interactive elements on the page for debugging
    try {
      const interactiveElements = await page.evaluate(() => {
        const elements: string[] = [];
        document.querySelectorAll('button, textarea, input, [contenteditable], [role="textbox"], [role="button"]').forEach((el) => {
          const tag = el.tagName.toLowerCase();
          const attrs = Array.from(el.attributes).map(a => `${a.name}="${a.value}"`).join(' ');
          const text = (el as HTMLElement).innerText?.slice(0, 50) || '';
          elements.push(`<${tag} ${attrs}> ${text}`);
        });
        return elements;
      });
      const debugDir = path.join(process.cwd(), 'debug');
      await fs.mkdir(debugDir, { recursive: true });
      await fs.writeFile(path.join(debugDir, '02-interactive-elements.log'), interactiveElements.join('\n'));
      logger.info(`Found ${interactiveElements.length} interactive elements (see debug/02-interactive-elements.log)`);
    } catch (e: any) {
      logger.warn(`Failed to enumerate interactive elements: ${e.message}`);
    }

    // --- Step 1: Switch to the correct mode tab ---
    // tabMode='advanced' → click Advanced (was labelled 'Custom' before Suno renamed it)
    // tabMode='sounds'   → click Sounds tab for sound effects generation
    const tabLabel = tabMode === 'sounds' ? 'Sounds' : 'Advanced';
    logger.info(`Looking for ${tabLabel} mode tab`);
    const tabSelectors = tabMode === 'sounds'
      ? [
          'button:has-text("Sounds")',
          '[role="button"]:has-text("Sounds")',
          'button:has-text("Sound")',
        ]
      : [
          'button:has-text("Advanced")',
          '[role="button"]:has-text("Advanced")',
          'button:has-text("Custom")',        // fallback: old label
          '[role="button"]:has-text("Custom")',
        ];
    let tabClicked = false;
    for (const sel of tabSelectors) {
      try {
        const tab = page.locator(sel).first();
        if (await tab.isVisible({ timeout: 2000 }).catch(() => false)) {
          const tabText = await tab.evaluate((el: Element) => (el as HTMLElement).innerText?.trim()).catch(() => sel);
          await this.click(tab);
          await new Promise(r => setTimeout(r, 600)); // let panel animate in
          logger.info(`Switched to ${tabLabel} mode via "${tabText}" tab`);
          tabClicked = true;
          break;
        }
      } catch {}
    }
    if (!tabClicked) {
      logger.warn(`${tabLabel} tab not found — continuing in default (Auto) mode`);
    }
    await this.saveDebugSnapshot(page, '03-after-advanced-tab', requestLog);

    // --- Step 2: Seed the form just enough to enable Create ---
    // We only need a valid browser-side submission path to obtain a CAPTCHA token.
    // For Advanced mode, avoid the brittle lyrics textarea entirely: use
    // Instrumental mode plus clickable style chips. For Sounds mode, keep a
    // simple prompt fill path because that tab requires a description.
    let fillSucceeded = false;
    try {
      if (tabMode === 'sounds') {
        logger.info('Looking for sound prompt input');
        const promptSelectors = [
          'textarea[placeholder*="sound" i]',
          'textarea[placeholder*="describe" i]',
          'textarea',
        ];
        const promptInput = await this.waitForAnyVisibleLocator(page, promptSelectors, 15000);
        if (promptInput) {
          const desc = await promptInput.evaluate((el: Element) =>
            `${el.tagName}.${el.className} placeholder="${el.getAttribute('placeholder') || ''}"`
          ).catch(() => 'unknown');
          logger.info(`Found sound prompt input: ${desc}`);
          await promptInput.click({ force: true });
          await promptInput.fill('soft cinematic whoosh riser');
          await new Promise(r => setTimeout(r, 500));
          const promptValue = await promptInput.inputValue().catch(() => '');
          fillSucceeded = promptValue.length > 0;
          logger.info(`Sounds prompt seeded (length=${promptValue.length})`);
        } else {
          logger.warn('No sound prompt input found anywhere on page');
          await this.saveDebugSnapshot(page, '04-no-prompt-input', requestLog);
        }
      } else {
        logger.info('Advanced mode detected — using Instrumental + style chips instead of lyrics typing');

        const instrumentalToggle = page.locator('button[aria-label*="instrumental" i]').first();
        if (await instrumentalToggle.isVisible({ timeout: 2000 }).catch(() => false)) {
          await this.click(instrumentalToggle);
          await new Promise(r => setTimeout(r, 500));
          logger.info('Enabled Instrumental mode for CAPTCHA token acquisition');
        } else {
          logger.warn('Instrumental toggle not found — continuing with style chips only');
        }

        const styleButtons = page.locator('button[aria-label^="Add style:"]');
        const styleCount = await styleButtons.count().catch(() => 0);
        if (styleCount > 0) {
          const clickedLabels: string[] = [];
          const clickLimit = Math.min(styleCount, 3);
          for (let index = 0; index < clickLimit; index++) {
            const styleButton = styleButtons.nth(index);
            if (!(await styleButton.isVisible().catch(() => false)))
              continue;
            const label = await styleButton.getAttribute('aria-label').catch(() => null);
            await this.click(styleButton);
            await new Promise(r => setTimeout(r, 300));
            if (label)
              clickedLabels.push(label.replace(/^Add style:\s*/i, ''));
          }
          fillSucceeded = clickedLabels.length > 0;
          logger.info(`Clicked style suggestion chips: ${clickedLabels.join(', ') || 'none'}`);
        } else {
          logger.warn('No style suggestion chips found — Create button may stay disabled');
        }
      }
    } catch (fillErr: any) {
      logger.warn(
        `Form seeding failed: ${fillErr.message?.substring(0, 120)}. ` +
        'Continuing with the current browser state.'
      );
    }

    // --- Step 3: Find and click the Create / Generate button ---
    logger.info('Looking for Create/Generate button');
    const buttonSelectors = [
      'button[aria-label="Create"]',
      'button:has-text("Create")',
      '[role="button"]:has-text("Create")',
      'button[type="submit"]',
      'button:has-text("Generate")',
      '[role="button"]:has-text("Generate")',
      'button:has-text("Make a song")',
      'button:has-text("Submit")',
    ];
    const button = await this.waitForAnyVisibleLocator(page, buttonSelectors, 15000);
    if (!button) {
      logger.error('Could not find any Create/Generate button');
      await this.saveDebugSnapshot(page, '04-no-create-button', requestLog);
      this._browserContext = null;
      this._browserPage = null;
      await browser.browser()?.close();
      throw new Error(
        'Could not find a Create/Generate button on the page. '
        + 'The Suno UI may have changed. Check the debug/ folder for HTML snapshots and screenshots.'
      );
    }

    const buttonInfo = await button.evaluate((el: Element) =>
      `<${el.tagName} class="${el.className}" aria-label="${el.getAttribute('aria-label') || ''}">${(el as HTMLElement).innerText?.slice(0, 40)}`
    ).catch(() => 'unknown');
    logger.info(`Found button: ${buttonInfo}`);

    // --- Wait for the Create button to become enabled ---
    // Suno loads invisible Turnstile + hCaptcha challenges on page load. The Create
    // button stays disabled until these challenges complete. Clicking a disabled
    // button does nothing — the browser's JS ignores it and no generate POST fires.
    //
    // CRITICAL: Do NOT force-enable and click prematurely. Force-enabling the DOM
    // button while React's internal state still has disabled=true means React's
    // synthetic event system blocks the onClick handler. Clicking in this state
    // corrupts Suno's form state, preventing subsequent natural clicks from working.
    // Instead, wait patiently for the button to become enabled naturally.
    const isDisabled = await button.evaluate((el: Element) => (el as HTMLButtonElement).disabled).catch(() => false);
    if (isDisabled) {
      logger.info('Create button is disabled — waiting for it to become enabled...');
      const enableStart = Date.now();
      // Use CAPTCHA UI timeout + buffer. Turnstile can take 2-3 minutes to complete.
      const ENABLE_TIMEOUT = parseInt(process.env.SUNO_CAPTCHA_UI_TIMEOUT_MS || '180000', 10) + 60000;
      while (Date.now() - enableStart < ENABLE_TIMEOUT) {
        const stillDisabled = await button.evaluate((el: Element) => (el as HTMLButtonElement).disabled).catch(() => true);
        if (!stillDisabled) {
          logger.info(`Create button enabled after ${((Date.now() - enableStart) / 1000).toFixed(1)}s`);
          break;
        }
        await new Promise(r => setTimeout(r, 500));
      }
      const finalDisabled = await button.evaluate((el: Element) => (el as HTMLButtonElement).disabled).catch(() => true);
      if (finalDisabled) {
        logger.warn('Create button still disabled after extended timeout — will try force-enable after CAPTCHA detection');
        await this.saveDebugSnapshot(page, '04-button-still-disabled', requestLog);
      }
    } else {
      logger.info('Create button is already enabled');
    }

    // Set up route interception BEFORE clicking Create so we don't miss the generate call
    const controller = new AbortController();
    let rejectOuter: (err: any) => void = () => {};
    let resolveOuter: (token: string | null) => void = () => {};
    let tokenCaptured = false; // set to true the moment the route intercept fires

    const tokenPromise = new Promise<string | null>((resolve, reject) => {
      resolveOuter = resolve;
      rejectOuter = reject;

      // Intercept the generate API call to extract the captcha token.
      // Match any generate endpoint: v2/, v2-web/, v3/, sound-effects/, etc.
      // Note: this also matches non-generation URLs like /api/generate/concurrent-status
      // (a GET-only status endpoint), so we filter by method below.
      page.route('**/api/generate/**', async (route: any) => {
        try {
          const request = route.request();

          // Only intercept POST requests — GET endpoints like /concurrent-status are
          // status-polling endpoints and must NOT be captured as the generation URL.
          if (request.method() !== 'POST') {
            return route.continue();
          }

          logger.info('Generate API call intercepted! Extracting token and closing browser');
          this.currentToken = request.headers().authorization?.split('Bearer ').pop();
          const postData = request.postDataJSON();
          // Capture the model the browser sent so we can mirror it in our API call
          if (postData?.mv) {
            this.capturedBrowserModel = postData.mv;
            logger.info(`Browser model captured: ${postData.mv}`);
          }
          // Capture the actual generate endpoint path (e.g. /api/generate/v3-web/) so we
          // don't rely on a hardcoded fallback that may drift as Suno evolves their API.
          // Store in the appropriate property based on which tab mode was selected.
          // Skip non-generation paths like /concurrent-status, /status, etc.
          try {
            const urlObj = new URL(request.url());
            const pathname = urlObj.pathname;
            if (/\/(concurrent-status|status|queue)\b/.test(pathname)) {
              logger.info(`Skipping non-generation endpoint: ${pathname}`);
              return route.abort();
            }
            if (tabMode === 'sounds') {
              this.capturedSoundsEndpoint = pathname;
              logger.info(`Browser sounds endpoint captured: ${pathname}`);
            } else {
              this.capturedBrowserEndpoint = pathname;
              logger.info(`Browser generate endpoint captured: ${pathname}`);
            }
          } catch {
            logger.warn(`Could not parse generate request URL: ${request.url()}`);
          }
          const extractedToken = postData?.token || null;
          logger.info(`Intercepted POST data keys: ${JSON.stringify(Object.keys(postData || {}))}`);
          logger.info(`Intercepted POST data FULL: ${JSON.stringify(postData, null, 2)}`);
          route.abort();

          if (extractedToken) {
            // Valid CAPTCHA token found — resolve and close
            controller.abort();
            tokenCaptured = true;
            const isHeadless = yn(process.env.BROWSER_HEADLESS, { default: true });
            if (this.keepBrowserOpen && !isHeadless) {
              logger.info('[BROWSER_KEEP_OPEN] Browser staying open for reuse by next request.');
              this._browserContext = browser;
              this._browserPage = page;
              // If user manually closes the window, clean up references
              page.once('close', () => {
                this._browserContext = null;
                this._browserPage = null;
                browser.browser()?.close().catch(() => {});
              });
            } else {
              this._browserContext = null;
              this._browserPage = null;
              browser.browser()?.close();
            }
            resolve(extractedToken);
          } else {
            // No CAPTCHA token in the intercepted request.
            const forceEnv = yn(process.env.BROWSER_FORCE_CAPTCHA, { default: false });
            if (forceEnv && this.capturedTurnstileSitekey) {
               logger.info('No token in request, but BROWSER_FORCE_CAPTCHA is true. Forcing Turnstile solve...');
               try {
                 controller.abort();
                 tokenCaptured = true;
                 const result = await this.solver.cloudflareTurnstile({
                   pageurl: 'https://suno.com/create',
                   sitekey: this.capturedTurnstileSitekey,
                 });
                 logger.info(`Forced Turnstile CAPTCHA solved by 2Captcha (token: ${result.data.slice(0, 20)}…)`);
                 
                 const isHeadless = yn(process.env.BROWSER_HEADLESS, { default: true });
                 if (this.keepBrowserOpen && !isHeadless) {
                   logger.info('[BROWSER_KEEP_OPEN] Browser staying open for reuse by next request.');
                   this._browserContext = browser;
                   this._browserPage = page;
                   page.once('close', () => {
                     this._browserContext = null;
                     this._browserPage = null;
                     browser.browser()?.close().catch(() => {});
                   });
                 } else {
                   this._browserContext = null;
                   this._browserPage = null;
                   browser.browser()?.close();
                 }
                 resolve(result.data);
               } catch (e: any) {
                 logger.error(`Forced Turnstile solving failed: ${e.message}`);
                 // Let the fallback mechanics try to find a CAPTCHA frame
                 logger.warn('No CAPTCHA token in intercepted request — continuing CAPTCHA detection flow');
                 tokenCaptured = false;
               }
            } else if (!forceEnv) {
               logger.info('No CAPTCHA token in request and force is disabled. Trusting session without CAPTCHA.');
               controller.abort();
               tokenCaptured = true;
               const isHeadless = yn(process.env.BROWSER_HEADLESS, { default: true });
               if (this.keepBrowserOpen && !isHeadless) {
                 this._browserContext = browser;
                 this._browserPage = page;
                 page.once('close', () => {
                   this._browserContext = null;
                   this._browserPage = null;
                   browser.browser()?.close().catch(() => {});
                 });
               } else {
                 this._browserContext = null;
                 this._browserPage = null;
                 browser.browser()?.close();
               }
               resolve(null);
            } else {
              // Don't short-circuit; let the CAPTCHA detection flow continue so we can try
              // to wait for an iframe and solve natively.
              logger.warn('No CAPTCHA token in intercepted request — continuing CAPTCHA detection flow');
            }
          }
        } catch (err) {
          reject(err);
        }
      });
    });

    // Click the button to trigger generation (and hopefully a CAPTCHA).
    // Only click if the button is currently enabled — clicking a force-enabled
    // button corrupts Suno's form state and prevents subsequent clicks from working.
    const buttonIsEnabled = !(await button.evaluate(
      (el: Element) => (el as HTMLButtonElement).disabled
    ).catch(() => true));

    if (buttonIsEnabled) {
      logger.info('Clicking Create button');
      await this.click(button);
    } else {
      logger.warn('Create button is still disabled — skipping click, will try force-enable after CAPTCHA detection');
    }

    // Wait up to 3s — exit immediately if the token was already captured
    await Promise.race([
      tokenPromise.catch(() => {}),
      new Promise(r => setTimeout(r, 3000)),
    ]);
    if (tokenCaptured) {
      logger.info('Token captured immediately after button click — skipping CAPTCHA detection');
      return tokenPromise;
    }

    // --- Debug snapshot: after Create click ---
    await this.saveDebugSnapshot(page, '05-after-create-click', requestLog);

    // --- Step 3: Detect what CAPTCHA appeared ---
    let captchaType: string | null = null;
    if (buttonIsEnabled) {
      logger.info('Waiting for CAPTCHA challenge to appear...');
      captchaType = await this.waitForCaptchaFrame(page, 15000);

      // Re-check after CAPTCHA wait in case token appeared without a CAPTCHA challenge
      if (!captchaType && tokenCaptured) {
        logger.info('Token captured during CAPTCHA wait — no CAPTCHA challenge needed');
        return tokenPromise;
      }

      if (!captchaType) {
        // Try clicking the button again — sometimes the first click is swallowed
        logger.warn('No CAPTCHA detected after first click. Retrying...');
        await this.click(button);

        // Wait up to 5s — exit immediately if token captured on retry click
        await Promise.race([
          tokenPromise.catch(() => {}),
          new Promise(r => setTimeout(r, 5000)),
        ]);
        if (tokenCaptured) {
          logger.info('Token captured after retry click — skipping CAPTCHA detection');
          await this.saveDebugSnapshot(page, '06-after-second-click', requestLog);
          return tokenPromise;
        }

        await this.saveDebugSnapshot(page, '06-after-second-click', requestLog);
        captchaType = await this.waitForCaptchaFrame(page, 20000);
      }
    }

    if (!captchaType) {
      if (tokenCaptured) {
        logger.info('Token captured during extended CAPTCHA wait');
        return tokenPromise;
      }

      // No visible CAPTCHA frame — the Turnstile/hCaptcha challenges are invisible.
      // The Create button may still be disabled if challenges haven't completed yet.
      // Wait for the button to become enabled, then click it to trigger the generate POST.
      logger.info('No CAPTCHA frame detected — waiting for Create button to become enabled');

      const retryEnableStart = Date.now();
      const RETRY_ENABLE_TIMEOUT = parseInt(process.env.SUNO_CAPTCHA_UI_TIMEOUT_MS || '180000', 10);
      let buttonEnabled = false;
      while (Date.now() - retryEnableStart < RETRY_ENABLE_TIMEOUT) {
        const disabled = await button.evaluate((el: Element) => (el as HTMLButtonElement).disabled).catch(() => true);
        if (!disabled) {
          buttonEnabled = true;
          logger.info(`Create button became enabled after ${((Date.now() - retryEnableStart) / 1000).toFixed(1)}s`);
          break;
        }
        if (tokenCaptured) return tokenPromise;
        await new Promise(r => setTimeout(r, 500));
      }

      if (buttonEnabled) {
        // Click the now-enabled Create button — this should be the first real click
        // if the button wasn't enabled during the initial wait phase.
        logger.info('Clicking Create button (after natural enable)');
        await this.click(button);

        // Wait for the route intercept to capture the token
        await Promise.race([
          tokenPromise.catch(() => {}),
          new Promise(r => setTimeout(r, 15000)),
        ]);
        if (tokenCaptured) {
          logger.info('Token captured after enabled-button click');
          return tokenPromise;
        }

        // Sometimes clicking triggers hCaptcha — check for it
        const lateCapType = await this.waitForCaptchaFrame(page, 10000);
        if (lateCapType) {
          logger.info(`Late CAPTCHA detected after enabled click: ${lateCapType}`);
          captchaType = lateCapType;
          // Fall through to the CAPTCHA solving section below
        }
      }

      // If we still have a CAPTCHA type from late detection, fall through to solve it
      if (captchaType) {
        // Will be handled by the CAPTCHA solving section below
        logger.info(`Proceeding to solve late-detected CAPTCHA: ${captchaType}`);
      } else {
        // --- Last resort: force-enable the button and try clicking ---
        if (!buttonEnabled) {
          logger.warn('Button never became enabled — force-enabling as last resort');
          await button.evaluate((el: Element) => {
            const btn = el as HTMLButtonElement;
            btn.disabled = false;
            btn.removeAttribute('disabled');
            // Also patch React fiber props so React's synthetic events don't block onClick
            const fiberKey = Object.keys(el).find(k => k.startsWith('__reactFiber$'));
            if (fiberKey) {
              const fiber = (el as any)[fiberKey];
              if (fiber?.memoizedProps && 'disabled' in fiber.memoizedProps)
                fiber.memoizedProps.disabled = false;
              if (fiber?.pendingProps && 'disabled' in fiber.pendingProps)
                fiber.pendingProps.disabled = false;
            }
          });
          await new Promise(r => setTimeout(r, 300));
          logger.info('Clicking force-enabled Create button (last resort)');
          await this.click(button);

          await Promise.race([
            tokenPromise.catch(() => {}),
            new Promise(r => setTimeout(r, 15000)),
          ]);
          if (tokenCaptured) {
            logger.info('Token captured after force-enable click');
            return tokenPromise;
          }
        }

        // --- Fallback: try to extract Turnstile token directly from page ---
        logger.info('Attempting to extract Turnstile token directly from page');
        const directToken = await page.evaluate(() => {
          // Check for Cloudflare Turnstile response in hidden input
          const turnstileInput = document.querySelector<HTMLInputElement>(
            '[name="cf-turnstile-response"], input[name*="turnstile"]'
          );
          if (turnstileInput?.value) return turnstileInput.value;

          // Try Turnstile API
          try {
            const w = window as any;
            if (w.turnstile?.getResponse) {
              const resp = w.turnstile.getResponse();
              if (resp) return resp;
            }
          } catch { /* ignore */ }

          // Check Turnstile iframes for response
          const iframes = document.querySelectorAll('iframe[src*="turnstile"]');
          for (const iframe of iframes) {
            const name = iframe.getAttribute('name') || '';
            const match = name.match(/cf-chl-widget-([a-z0-9]+)/i);
            if (match) {
              try {
                const w = window as any;
                if (w.turnstile?.getResponse) {
                  const resp = w.turnstile.getResponse(match[1]);
                  if (resp) return resp;
                }
              } catch { /* ignore */ }
            }
          }

          return null;
        }).catch(() => null);

        if (directToken) {
          logger.info(`Extracted Turnstile token directly (length=${directToken.length})`);
          resolveOuter(directToken);
          // Store browser for reuse
          const isHeadless = yn(process.env.BROWSER_HEADLESS, { default: true });
          if (this.keepBrowserOpen && !isHeadless) {
            this._browserContext = browser;
            this._browserPage = page;
            page.once('close', () => {
              this._browserContext = null;
              this._browserPage = null;
              browser.browser()?.close().catch(() => {});
            });
          }
          return tokenPromise;
        }

        // Truly no token — save debug info and give up
        logger.warn('All CAPTCHA token extraction methods failed');
        await this.saveDebugSnapshot(page, '07-no-captcha-final', requestLog);
        const isHeadless = yn(process.env.BROWSER_HEADLESS, { default: true });
        if (this.keepBrowserOpen && !isHeadless) {
          logger.info('[BROWSER_KEEP_OPEN] Browser staying open for reuse by next request.');
          this._browserContext = browser;
          this._browserPage = page;
          page.once('close', () => {
            this._browserContext = null;
            this._browserPage = null;
            browser.browser()?.close().catch(() => {});
          });
        } else {
          this._browserContext = null;
          this._browserPage = null;
          await browser.browser()?.close();
        }
        resolveOuter(null);
        return tokenPromise;
      }
    }

    logger.info(`Detected CAPTCHA type: ${captchaType}`);

    // --- Step 4: Solve CAPTCHA ---
    let captchaSolverPromise: Promise<void>;

    if (captchaType === 'hcaptcha') {
      // --- Solve hCaptcha challenges in a loop ---
      logger.info('Starting hCaptcha solving loop');
      captchaSolverPromise = new Promise<void>(async (resolve, reject) => {
        const frame = page.frameLocator('iframe[title*="hCaptcha"]');
        const challenge = frame.locator('.challenge-container');
        try {
          // First iteration: challenge is already loaded (images already fetched), skip waitForRequests.
          // Subsequent iterations: wait for the new challenge images to load after each submission.
          let wait = false;
          while (true) {
            if (wait)
              await waitForRequests(page, controller.signal);
            // Wait for the challenge container to be fully rendered before interacting
            await challenge.waitFor({ state: 'visible', timeout: 60000 });
            const promptText = await challenge.locator('.prompt-text').first().innerText({ timeout: 15000 }).catch(() => '');
            const drag = promptText.toLowerCase().includes('drag');
            let captcha: any;
            for (let j = 0; j < 3; j++) {
              try {
                logger.info('Sending the CAPTCHA to 2Captcha');
                const payload: paramsCoordinates = {
                  body: (await challenge.screenshot({ timeout: 5000 })).toString('base64'),
                  lang: process.env.BROWSER_LOCALE
                };
                if (drag) {
                  payload.textinstructions = 'CLICK on the shapes at their edge or center as shown above—please be precise!';
                  payload.imginstructions = (await fs.readFile(path.join(process.cwd(), 'public', 'drag-instructions.jpg'))).toString('base64');
                }
                captcha = await this.solver.coordinates(payload);
                break;
              } catch (err: any) {
                logger.info(err.message);
                if (j !== 2)
                  logger.info('Retrying...');
                else
                  throw err;
              }
            }
            if (drag) {
              const challengeBox = await challenge.boundingBox();
              if (challengeBox == null)
                throw new Error('.challenge-container boundingBox is null!');
              if (captcha.data.length % 2) {
                logger.info('Solution does not have even amount of points required for dragging. Requesting new solution...');
                this.solver.badReport(captcha.id);
                wait = false;
                continue;
              }
              for (let i = 0; i < captcha.data.length; i += 2) {
                const data1 = captcha.data[i];
                const data2 = captcha.data[i + 1];
                logger.info(JSON.stringify(data1) + JSON.stringify(data2));
                await page.mouse.move(challengeBox.x + +data1.x, challengeBox.y + +data1.y);
                await page.mouse.down();
                await sleep(1.1);
                await page.mouse.move(challengeBox.x + +data2.x, challengeBox.y + +data2.y, { steps: 30 });
                await page.mouse.up();
              }
              wait = true;
            } else {
              for (const data of captcha.data) {
                logger.info(data);
                await this.click(challenge, { x: +data.x, y: +data.y });
                await sleep(500);
              }
              // Don't wait for images here yet, we will check status after clicking submit
            }

            await sleep(500);
            try {
              await this.click(frame.locator('.button-submit'));
            } catch (e: any) {
              if (e.message.includes('viewport'))
                await this.click(frame.locator('.button-submit'));
              else
                throw e;
            }

            // Wait a moment to let the UI update (either show error, or start loading new images)
            await sleep(2000);

            // Check if it showed an error instead of loading new images
            const tryAgainVisible = await frame.getByText('try again', { exact: false }).isVisible().catch(() => false);
            if (tryAgainVisible) {
              logger.info('hCaptcha reported "Please try again". Requesting new solution...');
              if (captcha?.id) this.solver.badReport(captcha.id).catch(() => null);
              wait = false;
              continue;
            }

            wait = true; // Wait for new challenge images after successful submit click
          }
        } catch (e: any) {
          if (
            e.message.includes('been closed') ||
            e.message === 'AbortError' ||
            e.message.includes('No CAPTCHA image') || // signal was already aborted before waitForRequests was called
            e.message.includes('Target closed')  // browser closed while we were in the loop
          )
            resolve();
          else
            reject(e);
        }
      });

    } else if (captchaType === 'turnstile') {
      // --- Solve Cloudflare Turnstile via 2Captcha ---
      logger.info('Turnstile detected — solving via 2Captcha');

      // Extract the sitekey from the DOM or from the Turnstile iframe URL
      let sitekey: string | null = await page.evaluate(() => {
        const el = document.querySelector('[data-sitekey]');
        return el ? el.getAttribute('data-sitekey') : null;
      }).catch(() => null);

      if (!sitekey) {
        for (const frame of page.frames()) {
          const url = frame.url();
          if (url.includes('challenges.cloudflare.com') || url.includes('turnstile')) {
            const match = url.match(/\/(0x[0-9a-zA-Z_-]{10,})\//i) || url.match(/\/([0-9a-zA-Z_-]{20,})\//);
            if (match) { sitekey = match[1]; break; }
          }
        }
      }

      if (!sitekey) {
        await this.saveDebugSnapshot(page, '08-turnstile-no-sitekey', requestLog);
        this._browserContext = null;
        this._browserPage = null;
        await browser.browser()?.close();
        throw new Error('Could not extract Turnstile sitekey from the page. Check debug/ folder for details.');
      }

      logger.info(`Extracted Turnstile sitekey: ${sitekey}`);
      const resolvedSitekey = sitekey;

      captchaSolverPromise = new Promise<void>(async (resolve, reject) => {
        try {
          logger.info('Sending Turnstile CAPTCHA to 2Captcha');
          const result = await this.solver.cloudflareTurnstile({
            pageurl: 'https://suno.com/create',
            sitekey: resolvedSitekey,
          });

          logger.info(`Turnstile CAPTCHA solved by 2Captcha (token: ${result.data.slice(0, 20)}…)`);

          // We have the CAPTCHA token directly from 2Captcha — resolve the outer
          // promise immediately. this.currentToken (JWT) was already refreshed by
          // keepAlive() before the browser launched, so no route-intercept is needed.
          tokenCaptured = true;
          controller.abort();
          const isHeadless = yn(process.env.BROWSER_HEADLESS, { default: true });
          if (this.keepBrowserOpen && !isHeadless) {
            logger.info('[BROWSER_KEEP_OPEN] Browser staying open for reuse by next request.');
            this._browserContext = browser;
            this._browserPage = page;
            page.once('close', () => {
              this._browserContext = null;
              this._browserPage = null;
              browser.browser()?.close().catch(() => {});
            });
          } else {
            this._browserContext = null;
            this._browserPage = null;
            browser.browser()?.close();
          }
          resolveOuter(result.data);
          resolve();
        } catch (e: any) {
          if (
            e.message.includes('been closed') ||
            e.message === 'AbortError' ||
            e.message.includes('Target closed')
          )
            resolve();
          else
            reject(e);
        }
      });

    } else {
      await this.saveDebugSnapshot(page, '08-unsupported-captcha', requestLog);
      this._browserContext = null;
      this._browserPage = null;
      await browser.browser()?.close();
      throw new Error(
        `Detected CAPTCHA type "${captchaType}" which is not currently supported. `
        + 'Only hCaptcha and Turnstile are supported via 2Captcha. Check debug/ folder for details.'
      );
    }

    // Wire captcha solver errors into the token promise
    captchaSolverPromise.catch(e => {
      this._browserContext = null;
      this._browserPage = null;
      browser.browser()?.close();
      rejectOuter(e);
    });

    // Prevent unhandled rejection on the solver promise
    captchaSolverPromise.catch(() => {});

    return tokenPromise;
  }

  /**
   * Imitates Cloudflare Turnstile loading error. Unused right now, left for future
   */
  private async getTurnstile() {
    return this.client.post(
      `https://clerk.suno.com/v1/client?__clerk_api_version=2021-02-05&_clerk_js_version=${SunoApi.CLERK_VERSION}&_method=PATCH`,
      { captcha_error: '300030,300030,300030' },
      { headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  }

  /**
   * Generate a song based on the prompt.
   * @param prompt The text prompt to generate audio from.
   * @param make_instrumental Indicates if the generated audio should be instrumental.
   * @param wait_audio Indicates if the method should wait for the audio file to be fully generated before returning.
   * @returns
   */
  public async generate(
    prompt: string,
    make_instrumental: boolean = false,
    model?: string,
    wait_audio: boolean = false
  ): Promise<AudioInfo[]> {
    await this.keepAlive(false);
    const startTime = Date.now();
    const audios = await this.generateSongs(
      prompt,
      false,
      undefined,
      undefined,
      make_instrumental,
      model,
      wait_audio
    );
    const costTime = Date.now() - startTime;
    logger.info('Generate Response:\n' + JSON.stringify(audios, null, 2));
    logger.info('Cost time: ' + costTime);
    return audios;
  }

  /**
   * Calls the concatenate endpoint for a clip to generate the whole song.
   * @param clip_id The ID of the audio clip to concatenate.
   * @returns A promise that resolves to an AudioInfo object representing the concatenated audio.
   * @throws Error if the response status is not 200.
   */
  public async concatenate(clip_id: string): Promise<AudioInfo> {
    await this.keepAlive(false);
    const payload: any = { clip_id: clip_id };

    const response = await this.client.post(
      `${SunoApi.BASE_URL}/api/generate/concat/v2/`,
      payload,
      {
        timeout: 10000 // 10 seconds timeout
      }
    );
    if (response.status !== 200) {
      throw new Error('Error response:' + response.statusText);
    }
    return response.data;
  }

  /**
   * Generates custom audio based on provided parameters.
   *
   * @param prompt The text prompt to generate audio from.
   * @param tags Tags to categorize the generated audio.
   * @param title The title for the generated audio.
   * @param make_instrumental Indicates if the generated audio should be instrumental.
   * @param wait_audio Indicates if the method should wait for the audio file to be fully generated before returning.
   * @param negative_tags Negative tags that should not be included in the generated audio.
   * @param advanced Advanced options: vocal_gender, weirdness, style_influence, persona_id.
   * @returns A promise that resolves to an array of AudioInfo objects representing the generated audios.
   */
  public async custom_generate(
    prompt: string,
    tags: string,
    title: string,
    make_instrumental: boolean = false,
    model?: string,
    wait_audio: boolean = false,
    negative_tags?: string,
    advanced?: AdvancedOptions
  ): Promise<AudioInfo[]> {
    const startTime = Date.now();
    const audios = await this.generateSongs(
      prompt,
      true,
      tags,
      title,
      make_instrumental,
      model,
      wait_audio,
      negative_tags,
      undefined, // task
      undefined, // continue_clip_id
      undefined, // continue_at
      advanced
    );
    const costTime = Date.now() - startTime;
    logger.info(
      'Custom Generate Response:\n' + JSON.stringify(audios, null, 2)
    );
    logger.info('Cost time: ' + costTime);
    return audios;
  }

  /**
   * Generates sound effects (Sounds tab) based on a text description.
   *
   * @param prompt Description of the sound you want (e.g. "thunderstorm with heavy rain").
   * @param make_instrumental Currently always true for sounds — no vocals.
   * @param model Optional model to use.
   * @param wait_audio Whether to poll until audio is complete before returning.
   * @returns A promise that resolves to an array of AudioInfo objects.
   */
  public async generate_sounds(
    prompt: string,
    make_instrumental: boolean = true,
    model?: string,
    wait_audio: boolean = false,
  ): Promise<AudioInfo[]> {
    const reqId = ++this.requestCounter;
    const release = await this.requestSemaphore.acquire();
    logger.info(
      `[req-${reqId}] Acquired slot for sounds (active: ${this.requestSemaphore.activeCount}, waiting: ${this.requestSemaphore.waitingCount})`
    );

    try {
      await this.keepAlive();

      const payload: any = {
        gpt_description_prompt: prompt,
        prompt: '',  // Required by Suno API — sounds use gpt_description_prompt for the actual text
        make_instrumental: make_instrumental,
        mv: model || DEFAULT_MODEL,
        generation_type: 'TEXT',
      };

      // Solve CAPTCHA using the Sounds tab so we capture the correct endpoint.
      // Only include token in the payload when it's non-null — the browser doesn't
      // send a token field when no CAPTCHA was shown, and sending token:null can
      // cause Suno to reject the request with 422.
      const captchaToken = await this.getCaptcha(
        yn(process.env.BROWSER_FORCE_CAPTCHA, { default: false }),
        'sounds'
      );
      if (captchaToken) {
        payload.token = captchaToken;
      }

      await this.keepAlive();

      const resolvedModel = model || this.capturedBrowserModel || DEFAULT_MODEL;
      payload.mv = resolvedModel;

      // The Sounds tab uses the same /api/generate/v2-web/ endpoint as Advanced mode.
      // Fall back to the advanced endpoint captured from the browser, then to the sounds-specific
      // endpoint, and finally to a hardcoded fallback.
      const resolvedEndpoint = this.capturedSoundsEndpoint
        || this.capturedBrowserEndpoint
        || '/api/generate/v2-web/';

      const tokenPreview = captchaToken
        ? `✅ ${captchaToken.slice(0, 12)}…${captchaToken.slice(-6)} (len:${captchaToken.length})`
        : '❌ null (no CAPTCHA token — sending without token)';

      const sep = '─'.repeat(55);
      logger.info(
        `\n${sep}\n` +
        `🔊  SOUNDS REQUEST  [req-${reqId}]\n` +
        `${sep}\n` +
        `🤖  Mode              : 🔊 Sounds (sound effects)\n` +
        `🧠  Model / Version   : ${resolvedModel}\n` +
        `📝  Prompt            : "${prompt.slice(0, 120)}${prompt.length > 120 ? '…' : ''}"\n` +
        `⏳  Wait for audio    : ${wait_audio ? '✅ Yes' : '❌ No'}\n` +
        `🌐  Sounds endpoint   : ${resolvedEndpoint}${this.capturedSoundsEndpoint ? ' (from browser)' : ' (fallback)'}\n` +
        `🛡️  CAPTCHA token     : ${tokenPreview}\n` +
        `📦  Payload keys      : ${JSON.stringify(Object.keys(payload))}\n` +
        `${sep}`
      );

      const doGenerate = () => this.client.post(
        `${SunoApi.BASE_URL}${resolvedEndpoint}`,
        payload,
        { timeout: 10000 }
      );

      const response = await doGenerate().catch(async (err: any) => {
        const status = err?.response?.status ?? err?.status;
        const detail: string = (err?.response?.data?.detail ?? '').toLowerCase();
        const respData = err?.response?.data;
        logger.warn(`[req-${reqId}] Sounds generate failed: status=${status}, detail="${respData?.detail}", full response: ${JSON.stringify(respData)}`);

        if (status === 422 || detail.includes('token')) {
          logger.warn(`[req-${reqId}] Sounds got ${status} — force-solving CAPTCHA and retrying`);
          const retryToken = await this.getCaptcha(true, 'sounds');
          if (retryToken) {
            payload.token = retryToken;
          } else {
            // No CAPTCHA token available even after force-solve.
            // Try sending without a token field — may work if Suno session is valid.
            logger.warn(`[req-${reqId}] Force-solve returned null — retrying without token field`);
            delete payload.token;
          }
          return doGenerate();
        }
        throw err;
      });

      if (response.status !== 200) {
        throw new Error('Error response:' + response.statusText);
      }

      const songIds = response.data.clips.map((audio: any) => audio.id);
      if (wait_audio) {
        const startTime = Date.now();
        let lastResponse: AudioInfo[] = [];
        await sleep(5, 5);
        while (Date.now() - startTime < 100000) {
          const resp = await this.get(songIds);
          const allDone = resp.every(a => a.status === 'streaming' || a.status === 'complete');
          const allError = resp.every(a => a.status === 'error');
          if (allDone || allError) return resp;
          lastResponse = resp;
          await sleep(3, 6);
          await this.keepAlive(true);
        }
        return lastResponse;
      } else {
        return response.data.clips.map((audio: any) => ({
          id: audio.id,
          title: audio.title,
          image_url: audio.image_url,
          lyric: audio.metadata?.prompt,
          audio_url: audio.audio_url,
          video_url: audio.video_url,
          created_at: audio.created_at,
          model_name: audio.model_name,
          status: audio.status,
          gpt_description_prompt: audio.metadata?.gpt_description_prompt,
          prompt: audio.metadata?.prompt,
          type: audio.metadata?.type,
          tags: audio.metadata?.tags,
          duration: audio.metadata?.duration,
        }));
      }
    } finally {
      logger.info(`[req-${reqId}] Released slot`);
      release();
    }
  }

  /**
   * Generates songs based on the provided parameters.
   *
   * @param prompt The text prompt to generate songs from.
   * @param isCustom Indicates if the generation should consider custom parameters like tags and title.
   * @param tags Optional tags to categorize the song, used only if isCustom is true.
   * @param title Optional title for the song, used only if isCustom is true.
   * @param make_instrumental Indicates if the generated song should be instrumental.
   * @param wait_audio Indicates if the method should wait for the audio file to be fully generated before returning.
   * @param negative_tags Negative tags that should not be included in the generated audio.
   * @param task Optional indication of what to do. Enter 'extend' if extending an audio, otherwise specify null.
   * @param continue_clip_id 
   * @returns A promise that resolves to an array of AudioInfo objects representing the generated songs.
   */
  private async generateSongs(
    prompt: string,
    isCustom: boolean,
    tags?: string,
    title?: string,
    make_instrumental?: boolean,
    model?: string,
    wait_audio: boolean = false,
    negative_tags?: string,
    task?: string,
    continue_clip_id?: string,
    continue_at?: number,
    advanced?: AdvancedOptions
  ): Promise<AudioInfo[]> {
    const reqId = ++this.requestCounter;
    const release = await this.requestSemaphore.acquire();
    logger.info(
      `[req-${reqId}] Acquired slot (active: ${this.requestSemaphore.activeCount}, waiting: ${this.requestSemaphore.waitingCount})`
    );

    try {
      await this.keepAlive();
    const payload: any = {
      make_instrumental: make_instrumental,
      mv: model || DEFAULT_MODEL, // placeholder — overwritten after getCaptcha() captures browser model
      prompt: '',
      generation_type: 'TEXT',
      continue_at: continue_at,
      continue_clip_id: continue_clip_id,
      task: task,
    };
    if (isCustom) {
      payload.tags = tags;
      payload.title = title;
      payload.negative_tags = negative_tags;
      payload.prompt = prompt;
    } else {
      payload.gpt_description_prompt = prompt;
    }

    // --- Advanced options (More Options panel) ---
    if (advanced) {
      // Build metadata.control_sliders for numeric knobs (weirdness, style influence)
      const controlSliders: Record<string, number> = {};
      if (advanced.weirdness != null) {
        // UI shows 0-100 but Suno expects 0-1 float (weirdness_constraint)
        const w = advanced.weirdness > 1 ? advanced.weirdness / 100 : advanced.weirdness;
        controlSliders.weirdness_constraint = w;
      }
      if (advanced.style_influence != null) {
        // UI shows 0-100 but Suno expects 0-1 float (style_weight)
        const s = advanced.style_influence > 1 ? advanced.style_influence / 100 : advanced.style_influence;
        controlSliders.style_weight = s;
      }

      // Merge into payload.metadata
      if (!payload.metadata) payload.metadata = {};
      if (Object.keys(controlSliders).length > 0) {
        payload.metadata.control_sliders = controlSliders;
      }
      if (advanced.vocal_gender) {
        // Suno relies on tags/prompts for vocal gender
        if (isCustom && typeof payload.tags === 'string') {
          if (!payload.tags.toLowerCase().includes(advanced.vocal_gender)) {
            payload.tags = payload.tags ? `${payload.tags}, ${advanced.vocal_gender} vocals` : `${advanced.vocal_gender} vocals`;
          }
        } else if (!isCustom && typeof payload.gpt_description_prompt === 'string') {
          if (!payload.gpt_description_prompt.toLowerCase().includes(advanced.vocal_gender)) {
            payload.gpt_description_prompt += `, ${advanced.vocal_gender} vocals`;
          }
        }
        payload.metadata.vocal_gender = advanced.vocal_gender;
      }

      // Persona is a top-level field
      if (advanced.persona_id) {
        payload.persona_id = advanced.persona_id;
      }
    }

    const forceCaptcha = yn(process.env.BROWSER_FORCE_CAPTCHA, { default: false });
    const captchaToken = await this.getCaptcha(forceCaptcha);
    if (captchaToken) {
      payload.token = captchaToken;
    } else if (forceCaptcha) {
      // CAPTCHA solving was forced but the browser flow failed to obtain a token.
      // Sending without a token will 422, and retrying would open a second browser
      // that fails the same way. Fail fast instead.
      throw new Error(
        'CAPTCHA token could not be obtained (browser flow failed). '
        + 'The Create button may have stayed disabled because textarea filling failed. '
        + 'Check debug/ folder for screenshots and HTML snapshots.'
      );
    }

    // Refresh JWT in case the captcha session took long enough to stale it
    await this.keepAlive();

    // Use in order of preference: caller-supplied model → browser-captured model (set during getCaptcha) → DEFAULT_MODEL
    const resolvedModel = model || this.capturedBrowserModel || DEFAULT_MODEL;
    payload.mv = resolvedModel;

    // Use the endpoint URL captured from the browser (mirrors whatever Suno's frontend uses).
    // The browser always captures the Advanced/Custom endpoint (e.g. /api/generate/v2-web/).
    // For Simple/Auto mode (isCustom=false), Suno uses a separate endpoint without the -web suffix.
    const capturedOrFallback = this.capturedBrowserEndpoint || '/api/generate/v2-web/';
    const resolvedEndpoint = isCustom
      ? capturedOrFallback
      : capturedOrFallback.replace('-web/', '/');

    const tokenPreview = captchaToken
      ? `✅ ${captchaToken.slice(0, 12)}…${captchaToken.slice(-6)} (len:${captchaToken.length})`
      : '❌ null (no CAPTCHA token — sending without token)';

    const sep = '─'.repeat(55);
    logger.info(
      `\n${sep}\n` +
      `🎵  GENERATE REQUEST  [req-${reqId}]\n` +
      `${sep}\n` +
      `🆔  Request ID        : ${reqId}\n` +
      `🤖  Mode              : ${isCustom ? '🎨 Advanced (manual style)' : '✨ Auto (AI description)'}\n` +
      `🧠  Model / Version   : ${resolvedModel}${this.capturedBrowserModel && !model ? ' (from browser)' : ''}\n` +
      `📝  Prompt            : ${prompt ? `"${prompt.slice(0, 120)}${prompt.length > 120 ? '…' : ''}"` : '(none)'}\n` +
      `🎼  Title             : ${title || '(not set)'}\n` +
      `🎸  Style / Tags      : ${tags || '(not set)'}\n` +
      `🚫  Negative Tags     : ${negative_tags || '(none)'}\n` +
      `🎹  Instrumental      : ${make_instrumental ? '✅ Yes' : '❌ No (with vocals)'}\n` +
      `⏳  Wait for audio    : ${wait_audio ? '✅ Yes (blocking)' : '❌ No (async)'}\n` +
      `🔧  Task              : ${task || 'generate (default)'}\n` +
      `🔗  Continue clip ID  : ${continue_clip_id || '(none)'}\n` +
      `⏱️  Continue at       : ${continue_at != null ? `${continue_at}s` : '(none)'}\n` +
      `�  Vocal Gender      : ${advanced?.vocal_gender || '(auto)'}\n` +
      `🌀  Weirdness         : ${advanced?.weirdness != null ? advanced.weirdness : '(default)'}\n` +
      `🎨  Style Influence   : ${advanced?.style_influence != null ? advanced.style_influence : '(default)'}\n` +
      `👤  Persona ID        : ${advanced?.persona_id || '(none)'}\n` +
      `�🌐  Generate endpoint  : ${resolvedEndpoint}${this.capturedBrowserEndpoint ? ' (from browser)' : ' (fallback)'}\n` +
      `🛡️  CAPTCHA token     : ${tokenPreview}\n` +
      `${sep}`
    );

    const doGenerate = () => this.client.post(
      `${SunoApi.BASE_URL}${resolvedEndpoint}`,
      payload,
      { timeout: 10000 }
    );

    // If the API rejects our token (or null token) with 422, force-solve CAPTCHA and retry once.
    const response = await doGenerate().catch(async (err: any) => {
      const status = err?.response?.status ?? err?.status;
      const detail: string = (err?.response?.data?.detail ?? '').toLowerCase();
      const respData = err?.response?.data;
      logger.warn(`[req-${reqId}] Generate failed: status=${status}, detail="${respData?.detail}", full: ${JSON.stringify(respData)}`);
      if (status === 422 || detail.includes('token')) {
        logger.warn(`[req-${reqId}] Generate got ${status} ("${respData?.detail}") — force-solving CAPTCHA and retrying`);
        const retryToken = await this.getCaptcha(true);
        if (retryToken) {
          payload.token = retryToken;
          return doGenerate();
        }
        // Force-solve returned null — no point retrying without a token (we'd get 422 again)
        throw new Error(
          `CAPTCHA token required but could not be obtained. `
          + `Suno returned ${status}: "${respData?.detail}". `
          + `Ensure TWOCAPTCHA_KEY is set and 2Captcha has balance. Check debug/ folder for details.`
        );
      }
      throw err;
    });

    if (response.status !== 200) {
      throw new Error('Error response:' + response.statusText);
    }
    const songIds = response.data.clips.map((audio: any) => audio.id);
    //Want to wait for music file generation
    if (wait_audio) {
      const startTime = Date.now();
      let lastResponse: AudioInfo[] = [];
      await sleep(5, 5);
      while (Date.now() - startTime < 100000) {
        const response = await this.get(songIds);
        const allCompleted = response.every(
          (audio) => audio.status === 'streaming' || audio.status === 'complete'
        );
        const allError = response.every((audio) => audio.status === 'error');
        if (allCompleted || allError) {
          return response;
        }
        lastResponse = response;
        await sleep(3, 6);
        await this.keepAlive(true);
      }
      return lastResponse;
    } else {
      return response.data.clips.map((audio: any) => ({
        id: audio.id,
        title: audio.title,
        image_url: audio.image_url,
        lyric: audio.metadata.prompt,
        audio_url: audio.audio_url,
        video_url: audio.video_url,
        created_at: audio.created_at,
        model_name: audio.model_name,
        status: audio.status,
        gpt_description_prompt: audio.metadata.gpt_description_prompt,
        prompt: audio.metadata.prompt,
        type: audio.metadata.type,
        tags: audio.metadata.tags,
        negative_tags: audio.metadata.negative_tags,
        duration: audio.metadata.duration
      }));
    }
    } finally {
      logger.info(`[req-${reqId}] Released slot`);
      release();
    }
  }

  /**
   * Generates lyrics based on a given prompt.
   * @param prompt The prompt for generating lyrics.
   * @returns The generated lyrics text.
   */
  public async generateLyrics(prompt: string): Promise<string> {
    await this.keepAlive(false);
    // Initiate lyrics generation
    const generateResponse = await this.client.post(
      `${SunoApi.BASE_URL}/api/generate/lyrics/`,
      { prompt }
    );
    const generateId = generateResponse.data.id;

    // Poll for lyrics completion
    let lyricsResponse = await this.client.get(
      `${SunoApi.BASE_URL}/api/generate/lyrics/${generateId}`
    );
    while (lyricsResponse?.data?.status !== 'complete') {
      await sleep(2); // Wait for 2 seconds before polling again
      lyricsResponse = await this.client.get(
        `${SunoApi.BASE_URL}/api/generate/lyrics/${generateId}`
      );
    }

    // Return the generated lyrics text
    return lyricsResponse.data;
  }

  /**
   * Extends an existing audio clip by generating additional content based on the provided prompt.
   *
   * @param audioId The ID of the audio clip to extend.
   * @param prompt The prompt for generating additional content.
   * @param continueAt Extend a new clip from a song at mm:ss(e.g. 00:30). Default extends from the end of the song.
   * @param tags Style of Music.
   * @param title Title of the song.
   * @returns A promise that resolves to an AudioInfo object representing the extended audio clip.
   */
  public async extendAudio(
    audioId: string,
    prompt: string = '',
    continueAt: number,
    tags: string = '',
    negative_tags: string = '',
    title: string = '',
    model?: string,
    wait_audio?: boolean
  ): Promise<AudioInfo[]> {
    return this.generateSongs(prompt, true, tags, title, false, model, wait_audio, negative_tags, 'extend', audioId, continueAt);
  }

  /**
   * Generate stems for a song.
   * @param song_id The ID of the song to generate stems for.
   * @returns A promise that resolves to an AudioInfo object representing the generated stems.
   */
  public async generateStems(song_id: string): Promise<AudioInfo[]> {
    await this.keepAlive(false);
    const response = await this.client.post(
      `${SunoApi.BASE_URL}/api/edit/stems/${song_id}`, {}
    );

    console.log('generateStems response:\n', response?.data);
    return response.data.clips.map((clip: any) => ({
      id: clip.id,
      status: clip.status,
      created_at: clip.created_at,
      title: clip.title,
      stem_from_id: clip.metadata.stem_from_id,
      duration: clip.metadata.duration
    }));
  }


  /**
   * Get the lyric alignment for a song.
   * @param song_id The ID of the song to get the lyric alignment for.
   * @returns A promise that resolves to an object containing the lyric alignment.
   */
  public async getLyricAlignment(song_id: string): Promise<object> {
    await this.keepAlive(false);
    const response = await this.client.get(`${SunoApi.BASE_URL}/api/gen/${song_id}/aligned_lyrics/v2/`);

    console.log(`getLyricAlignment ~ response:`, response.data);
    return response.data?.aligned_words.map((transcribedWord: any) => ({
      word: transcribedWord.word,
      start_s: transcribedWord.start_s,
      end_s: transcribedWord.end_s,
      success: transcribedWord.success,
      p_align: transcribedWord.p_align
    }));
  }

  /**
   * Processes the lyrics (prompt) from the audio metadata into a more readable format.
   * @param prompt The original lyrics text.
   * @returns The processed lyrics text.
   */
  private parseLyrics(prompt: string): string {
    // Assuming the original lyrics are separated by a specific delimiter (e.g., newline), we can convert it into a more readable format.
    // The implementation here can be adjusted according to the actual lyrics format.
    // For example, if the lyrics exist as continuous text, it might be necessary to split them based on specific markers (such as periods, commas, etc.).
    // The following implementation assumes that the lyrics are already separated by newlines.

    // Split the lyrics using newline and ensure to remove empty lines.
    const lines = prompt.split('\n').filter((line) => line.trim() !== '');

    // Reassemble the processed lyrics lines into a single string, separated by newlines between each line.
    // Additional formatting logic can be added here, such as adding specific markers or handling special lines.
    return lines.join('\n');
  }

  /**
   * Retrieves audio information for the given song IDs.
   * @param songIds An optional array of song IDs to retrieve information for.
   * @param page An optional page number to retrieve audio information from.
   * @returns A promise that resolves to an array of AudioInfo objects.
   */
  public async get(
    songIds?: string[],
    page?: string | null
  ): Promise<AudioInfo[]> {
    await this.keepAlive(false);
    let url = new URL(`${SunoApi.BASE_URL}/api/feed/v2`);
    if (songIds) {
      url.searchParams.append('ids', songIds.join(','));
    }
    if (page) {
      url.searchParams.append('page', page);
    }
    logger.info('Get audio status: ' + url.href);
    const response = await this.client.get(url.href, {
      // 10 seconds timeout
      timeout: 10000
    });

    const audios = response.data.clips;

    return audios.map((audio: any) => ({
      id: audio.id,
      title: audio.title,
      image_url: audio.image_url,
      lyric: audio.metadata.prompt
        ? this.parseLyrics(audio.metadata.prompt)
        : '',
      audio_url: audio.audio_url,
      video_url: audio.video_url,
      created_at: audio.created_at,
      model_name: audio.model_name,
      status: audio.status,
      gpt_description_prompt: audio.metadata.gpt_description_prompt,
      prompt: audio.metadata.prompt,
      type: audio.metadata.type,
      tags: audio.metadata.tags,
      duration: audio.metadata.duration,
      error_message: audio.metadata.error_message
    }));
  }

  /**
   * Retrieves information for a specific audio clip.
   * @param clipId The ID of the audio clip to retrieve information for.
   * @returns A promise that resolves to an object containing the audio clip information.
   */
  public async getClip(clipId: string): Promise<object> {
    await this.keepAlive(false);
    const response = await this.client.get(
      `${SunoApi.BASE_URL}/api/clip/${clipId}`
    );
    return response.data;
  }

  public async get_credits(): Promise<object> {
    await this.keepAlive(false);
    const response = await this.client.get(
      `${SunoApi.BASE_URL}/api/billing/info/`
    );
    return {
      credits_left: response.data.total_credits_left,
      period: response.data.period,
      monthly_limit: response.data.monthly_limit,
      monthly_usage: response.data.monthly_usage
    };
  }

  public async getPersonaPaginated(personaId: string, page: number = 1): Promise<PersonaResponse> {
    await this.keepAlive(false);

    const url = `${SunoApi.BASE_URL}/api/persona/get-persona-paginated/${personaId}/?page=${page}`;

    logger.info(`Fetching persona data: ${url}`);

    try {
      const response = await this.client.get(url, {
        timeout: 10000 // 10 seconds timeout
      });

      if (response.status !== 200) {
        throw new Error('Error response: ' + response.statusText);
      }

      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        logger.warn('Direct persona endpoint returned 404, retrying through authenticated browser context.');
        return this.fetchPersonaWithBrowser(personaId, page);
      }

      throw error;
    }
  }
}

export const sunoApi = async (cookie?: string) => {
  const resolvedCookie = cookie && cookie.includes('__client') ? cookie : process.env.SUNO_COOKIE; // Check for bad `Cookie` header (It's too expensive to actually parse the cookies *here*)
  if (!resolvedCookie) {
    logger.info('No cookie provided! Aborting...\nPlease provide a cookie either in the .env file or in the Cookie header of your request.')
    throw new Error('Please provide a cookie either in the .env file or in the Cookie header of your request.');
  }

  // Check if the instance for this cookie already exists in the cache
  const cachedInstance = cache.get(resolvedCookie);
  if (cachedInstance)
    return cachedInstance;

  // If not, create a new instance and initialize it
  const instance = await new SunoApi(resolvedCookie).init();
  // Cache the initialized instance
  cache.set(resolvedCookie, instance);

  return instance;
};