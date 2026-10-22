import { browser } from 'wxt/browser';
import { OFFSCREEN_JUSTIFICATION, OFFSCREEN_PAGE_PATH, SPEECH_TIMING } from './constants';

/** Lifecycle of the single offscreen document plus messaging to it. Faked in unit tests. */
export interface OffscreenHost {
  /** True if the offscreen document currently exists. Never creates one. */
  hasDocument(): Promise<boolean>;
  /** Create the document if missing; concurrent callers share one creation. */
  ensureDocument(): Promise<void>;
  closeDocument(): Promise<void>;
  /** Send a command to the offscreen page and return its reply. */
  send(message: unknown): Promise<unknown>;
}

/** The browser APIs the real host needs, with the version-dependent ones optional. */
export interface OffscreenEnvironment {
  runtime: {
    getURL(path: string): string;
    sendMessage(message: unknown): Promise<unknown>;
    /** Chrome 116+ (MV3). */
    getContexts?: (filter: {
      contextTypes: string[];
      documentUrls?: string[];
    }) => Promise<{ documentUrl?: string | undefined }[]>;
  };
  offscreen: {
    createDocument(parameters: {
      url: string;
      reasons: string[];
      justification: string;
    }): Promise<void>;
    closeDocument(): Promise<void>;
    /** Chrome 150+. */
    hasDocument?: () => Promise<boolean>;
  };
  /** Service-worker `clients.matchAll()`, the pre-116 documented approach. */
  matchClients?: () => Promise<{ url: string }[]>;
  sleep?: (ms: number) => Promise<void>;
}

function defaultEnvironment(): OffscreenEnvironment {
  const sw = globalThis as unknown as {
    clients?: { matchAll(): Promise<{ url: string }[]> };
  };
  const runtime = browser.runtime;
  return {
    runtime: {
      getURL: (path) => runtime.getURL(path as typeof OFFSCREEN_PAGE_PATH),
      sendMessage: (message) => runtime.sendMessage(message) as Promise<unknown>,
      ...(typeof runtime.getContexts === 'function'
        ? { getContexts: (filter) => runtime.getContexts(filter as never) }
        : {}),
    },
    offscreen: {
      createDocument: (parameters) => browser.offscreen.createDocument(parameters as never),
      closeDocument: () => browser.offscreen.closeDocument(),
      ...(typeof browser.offscreen?.hasDocument === 'function'
        ? { hasDocument: () => browser.offscreen.hasDocument() }
        : {}),
    },
    ...(sw.clients === undefined ? {} : { matchClients: () => sw.clients!.matchAll() }),
  };
}

const SINGLE_DOCUMENT_ERROR = /single offscreen document/i;
const NO_RECEIVER_ERROR = /receiving end does not exist|could not establish connection/i;

/**
 * Existence check, newest to oldest API (verified in Spike D):
 *  1. `runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']})` - Chrome 116+, our minimum.
 *  2. `offscreen.hasDocument()` - Chrome 150+ only, so never relied on.
 *  3. `clients.matchAll()` - the documented pre-116 service-worker approach.
 * If none is available the caller still survives: createDocument's "only a
 * single offscreen document" error is treated as "already exists".
 */
export function createOffscreenHost(
  env: OffscreenEnvironment = defaultEnvironment(),
): OffscreenHost {
  const pageUrl = env.runtime.getURL(OFFSCREEN_PAGE_PATH);
  const sleep =
    env.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let creating: Promise<void> | undefined;

  async function exists(): Promise<boolean> {
    if (env.runtime.getContexts) {
      const contexts = await env.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
        documentUrls: [pageUrl],
      });
      return contexts.length > 0;
    }
    if (env.offscreen.hasDocument) return env.offscreen.hasDocument();
    if (env.matchClients) {
      const clients = await env.matchClients();
      return clients.some((client) => client.url === pageUrl);
    }
    return false;
  }

  async function create(): Promise<void> {
    if (await exists()) return;
    try {
      await env.offscreen.createDocument({
        url: OFFSCREEN_PAGE_PATH.slice(1),
        reasons: ['AUDIO_PLAYBACK'],
        justification: OFFSCREEN_JUSTIFICATION,
      });
    } catch (error) {
      // Lost a race with another creator: the document exists, which is what we wanted.
      if (error instanceof Error && SINGLE_DOCUMENT_ERROR.test(error.message)) return;
      throw error;
    }
  }

  return {
    hasDocument: exists,
    ensureDocument() {
      creating ??= create().finally(() => {
        creating = undefined;
      });
      return creating;
    },
    async closeDocument() {
      if (!(await exists())) return;
      await env.offscreen.closeDocument();
    },
    async send(message) {
      let lastError: unknown;
      for (let attempt = 0; attempt <= SPEECH_TIMING.offscreenSendRetries; attempt++) {
        try {
          return await env.runtime.sendMessage(message);
        } catch (error) {
          lastError = error;
          // The page may not have registered its listener yet right after creation.
          if (!(error instanceof Error && NO_RECEIVER_ERROR.test(error.message))) throw error;
          await sleep(SPEECH_TIMING.offscreenSendRetryDelayMs);
        }
      }
      throw lastError;
    },
  };
}
