import { browser } from 'wxt/browser';
import { MESSAGE_VERSION } from '../../lib/config/constants';
import type { ErrorCode } from '../../lib/contracts/errors';
import type { ExplainRequest, ExplainResult } from '../../lib/contracts/explain';
import type { SidePanelHandoff } from '../../lib/contracts/sidepanel';
import type { ClientErrorCode } from '../../lib/ui-client/errors';
import { readExplainResult } from './model';

/**
 * The card's side of the background routes AI_EXPLAIN, AI_CANCEL, OPEN_SETTINGS,
 * OPEN_SIDE_PANEL and GET_PUBLIC_SETTINGS (lib/contracts/messages.ts). Hand-written and zod-free on purpose: the
 * card script has its own size budget, and `lib/ui-client/api.ts` pulls in every contract schema.
 * The reply is still checked before it is drawn (`readExplainResult`), and nothing in it is ever
 * shown as HTML.
 */

export type SettingsSection = 'key' | 'model' | 'privacy';

/** What one AI_EXPLAIN call came back with. */
export type BackendReply =
  | { kind: 'result'; result: ExplainResult }
  /** The one-time "Send this to Groq?" confirmation is still owed (FR-002, D-16). */
  | { kind: 'disclosure' }
  | { kind: 'error'; code: ClientErrorCode; retryAfterMs?: number };

export interface ExplainBackend {
  /**
   * One paid request. Never retried here, not even when nobody answers (a second send could be a
   * second Groq call, requirements §8 abuse case 5). `acknowledge` is true only after the user
   * pressed Confirm on the first-send prompt.
   */
  explain(request: ExplainRequest, acknowledge: boolean): Promise<BackendReply>;
  /** Tell the background to stop work for `requestId`. Fire and forget. */
  cancel(requestId: string): void;
  /** Open the Settings page, at a section if given. Resolves to whether the background did it. */
  openSettings(section?: SettingsSection): Promise<boolean>;
  /** The user's explanation language (needed by the Translate tab only). */
  explanationLanguage(): Promise<string | undefined>;
  /**
   * Hand the explanation to the side panel and open it (FR-042). Must be called synchronously from
   * the trusted click that asked for it: Chrome lets the background open the panel only while that
   * user gesture is alive, and the gesture does not survive an `await` before this call.
   */
  openSidePanel(handoff: SidePanelHandoff): Promise<boolean>;
}

export type Send = (message: unknown) => Promise<unknown>;

const KNOWN_CODES: readonly string[] = [
  'SETUP_REQUIRED',
  'INVALID_API_KEY',
  'MODEL_UNAVAILABLE',
  'RATE_LIMITED',
  'NETWORK_ERROR',
  'TIMEOUT',
  'INVALID_RESPONSE',
  'UNSUPPORTED_SITE',
  'NO_VOICE',
  'PERMISSION_DENIED',
  'PDF_LOAD_ERROR',
  'REQUEST_CANCELLED',
  'SELECTION_TOO_LONG',
  'INVALID_REQUEST',
  'STORAGE_UNAVAILABLE',
  'INTERNAL_ERROR',
] satisfies ErrorCode[];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Whether an error envelope means "ask the user to confirm the first send" rather than "no key":
 * exactly SETUP_REQUIRED with `reason: 'disclosure'` (lib/contracts/errors.ts). Nothing else.
 */
function isDisclosure(code: string, error: Record<string, unknown>): boolean {
  return code === 'SETUP_REQUIRED' && error['reason'] === 'disclosure';
}

/** Turn whatever came back into a `BackendReply`. */
export function interpretReply(raw: unknown): BackendReply {
  // Nobody answered: the service worker was restarting, or the listener never called back.
  if (raw === undefined || raw === null) return { kind: 'error', code: 'NO_RESPONSE' };
  if (!isRecord(raw)) return { kind: 'error', code: 'BAD_REPLY' };
  if (raw['ok'] === true) {
    const result = readExplainResult(raw['data']);
    return result === null ? { kind: 'error', code: 'BAD_REPLY' } : { kind: 'result', result };
  }
  const error = raw['error'];
  if (raw['ok'] !== false || !isRecord(error) || typeof error['code'] !== 'string') {
    return { kind: 'error', code: 'BAD_REPLY' };
  }
  const code = error['code'];
  if (isDisclosure(code, error)) return { kind: 'disclosure' };
  const retryAfter = error['retryAfterMs'];
  return {
    kind: 'error',
    code: (KNOWN_CODES.includes(code) ? code : 'INTERNAL_ERROR') as ClientErrorCode,
    ...(typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter >= 0
      ? { retryAfterMs: Math.min(retryAfter, 3_600_000) }
      : {}),
  };
}

export function createBackend(send: Send = (message) => browser.runtime.sendMessage(message)) {
  const call = async (message: Record<string, unknown>): Promise<unknown> => {
    try {
      return await send({ v: MESSAGE_VERSION, ...message });
    } catch {
      // "Receiving end does not exist" and a closed port look the same as no reply.
      return undefined;
    }
  };

  const backend: ExplainBackend = {
    async explain(request, acknowledge) {
      return interpretReply(
        await call({
          type: 'AI_EXPLAIN',
          payload: request,
          ...(acknowledge ? { acknowledgeDisclosure: true } : {}),
        }),
      );
    },
    cancel(requestId) {
      void call({ type: 'AI_CANCEL', requestId });
    },
    async openSettings(section) {
      const reply = await call({ type: 'OPEN_SETTINGS', ...(section ? { section } : {}) });
      return isRecord(reply) && reply['ok'] === true;
    },
    async openSidePanel(handoff) {
      const reply = await call({ type: 'OPEN_SIDE_PANEL', handoff });
      return isRecord(reply) && reply['ok'] === true;
    },
    async explanationLanguage() {
      const reply = await call({ type: 'GET_PUBLIC_SETTINGS' });
      const data = isRecord(reply) && isRecord(reply['data']) ? reply['data'] : undefined;
      const language = data?.['explanationLanguage'];
      return typeof language === 'string' ? language : undefined;
    },
  };
  return backend;
}
