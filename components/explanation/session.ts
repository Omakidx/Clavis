import { FEATURES } from '../../lib/config/constants';
import type { ExplainMode, ExplainRequest, ExplainResult } from '../../lib/contracts/explain';
import type { SidePanelHandoff } from '../../lib/contracts/sidepanel';
import type { SelectionKind, SelectionSnapshot } from '../../lib/contracts/selection';
import { t } from '../../lib/i18n';
import { describeError, type ClientErrorCode } from '../../lib/ui-client/errors';
import type { BackendReply, ExplainBackend, SettingsSection } from './backend';
import { cacheKey, resultText, tabLabel, tabsFor, type FeatureFlags } from './model';

/**
 * The state machine behind one explanation card (docs/architecture.md section 5): one core
 * request, then one more request per tab the user opens for the FIRST time, cached per selection.
 *
 * Rules it enforces (requirements FR-030 .. FR-039, D-05):
 * - Opening an already loaded tab never sends anything; nothing is prefetched.
 * - Requests run one at a time, because the background lets a sender have one AI request in
 *   flight (a second would cancel the first). A tab opened meanwhile waits its turn.
 * - Nothing is retried by itself: an error stays until the user presses Retry, and Retry is
 *   refused while a rate-limit delay is running.
 * - A reply that is not for the request in flight (superseded, aborted, timed out, another
 *   selection) is ignored.
 * - Every request has a client-side timeout, so there is no infinite spinner.
 */

/** A bit longer than the background's own 30 s Groq timeout (REQUEST_TIMEOUT_MS.default). */
export const REQUEST_TIMEOUT_MS = 45_000;

export type EntryStatus = 'queued' | 'loading' | 'ready' | 'disclosure' | 'error';

/** What a failed tab offers the user. */
export type ErrorAction =
  'retry' | 'connect' | 'update-key' | 'choose-model' | 'open-settings' | 'none';

export interface CardError {
  code: ClientErrorCode;
  /** Short heading (requirements section 7), when the catalog has one for this error. */
  title: string | null;
  message: string;
  action: ErrorAction;
  /** Not a failure: the request was cancelled for us, so the tab offers a quiet "Load". */
  quiet?: boolean;
  /** Epoch ms before which Retry is refused (rate limit). */
  retryAt?: number;
}

export interface Entry {
  mode: ExplainMode;
  status: EntryStatus;
  requestId: string | null;
  result: ExplainResult | null;
  error: CardError | null;
  /** The user confirmed the first-send prompt: the next send for this entry carries the acknowledgement. */
  acknowledge: boolean;
}

export interface SessionState {
  selectionId: string;
  kind: SelectionKind;
  text: string;
  tabs: ExplainMode[];
  active: ExplainMode;
  entries: Partial<Record<ExplainMode, Entry>>;
  /** Polite live-region text: loading, result, error and copy feedback. */
  live: string;
}

export interface SessionOptions {
  snapshot: SelectionSnapshot;
  backend: ExplainBackend;
  newId(): string;
  now?(): number;
  requestTimeoutMs?: number | undefined;
  features?: FeatureFlags | undefined;
  /** The Translate tab's target language (only read when that tab is enabled). */
  targetLanguage?: string | undefined;
}

type Listener = (state: SessionState) => void;

/** The error a failed request shows, with the action the user can take (requirements section 7). */
export function toCardError(
  code: ClientErrorCode,
  retryAfterMs: number | undefined,
  now: number,
): CardError {
  const described = describeError(code, retryAfterMs);
  let action: ErrorAction = described.action;
  let title: string | null = null;
  switch (code) {
    case 'NETWORK_ERROR':
    case 'TIMEOUT':
    case 'NO_RESPONSE':
      title = t('cardErrConnectTitle');
      break;
    case 'INVALID_RESPONSE':
    case 'BAD_REPLY':
      title = t('cardErrFormatTitle');
      break;
    case 'RATE_LIMITED':
      title = t('cardErrRateTitle');
      break;
    case 'MODEL_UNAVAILABLE':
      action = 'choose-model';
      break;
    case 'REQUEST_CANCELLED':
      // Cancelled by someone else (a newer request from this tab, a key change): not an error the
      // user caused or needs to fix. The tab says so quietly and offers "Load".
      return {
        code,
        title: null,
        message: t('cardNotLoaded'),
        action: 'retry',
        quiet: true,
      };
  }
  return {
    code,
    title,
    message: described.message,
    action,
    ...(code === 'RATE_LIMITED' && retryAfterMs !== undefined && retryAfterMs > 0
      ? { retryAt: now + retryAfterMs }
      : {}),
  };
}

export class ExplainSession {
  readonly selectionId: string;
  private readonly snapshot: SelectionSnapshot;
  private readonly backend: ExplainBackend;
  private readonly newId: () => string;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly tabs: ExplainMode[];
  private readonly language: string | undefined;
  /** Cached entries by `cacheKey(selectionId, mode, language)`. */
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<Listener>();
  private queue: Entry[] = [];
  private inflight: Entry | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private attached = false;
  private destroyed = false;
  private active: ExplainMode = 'core';
  private live = '';
  state: SessionState;

  constructor(options: SessionOptions) {
    this.snapshot = options.snapshot;
    this.selectionId = options.snapshot.selectionId;
    this.backend = options.backend;
    this.newId = options.newId;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.language = options.targetLanguage;
    this.tabs = tabsFor(options.snapshot.kind, options.features ?? FEATURES);
    this.state = this.build();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Whether a request is on its way (for tests and the card's busy state). */
  get busy(): boolean {
    return this.inflight !== null || this.queue.length > 0;
  }

  /**
   * The card is on screen: show what is cached and request the core answer if the selection has
   * none yet. Called again (after `detach`) when the user presses Explain once more. The side
   * panel passes `requestCore: false`: opening it must never send anything by itself.
   */
  attach(options: { requestCore?: boolean } = {}): void {
    if (this.destroyed || this.attached) return;
    this.attached = true;
    if (this.entry('core') === undefined && options.requestCore !== false) {
      this.live = t('cardLoading');
      this.enqueue(this.create('core'));
    } else {
      this.live = '';
    }
    this.emit();
  }

  /**
   * The card went away (superseded, replaced, dismissed): cancel what is pending and forget
   * anything unfinished. Finished results stay cached for the same selection.
   */
  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.inflight?.requestId) this.backend.cancel(this.inflight.requestId);
    for (const [key, entry] of this.entries) {
      if (entry.status === 'loading' || entry.status === 'queued') this.entries.delete(key);
    }
    this.inflight = null;
    this.queue = [];
    this.live = '';
    this.emit();
  }

  /** Drop everything, including the cache. */
  destroy(): void {
    this.detach();
    this.destroyed = true;
    this.entries.clear();
    this.listeners.clear();
  }

  /** Show a tab; its request is sent only the first time it is opened. */
  selectTab(mode: ExplainMode): void {
    if (this.destroyed || !this.tabs.includes(mode)) return;
    this.active = mode;
    if (this.attached && this.entry(mode) === undefined) {
      const entry = this.create(mode);
      this.live = t('cardLoadingTab', tabLabel(mode));
      this.enqueue(entry);
    }
    this.emit();
  }

  /**
   * Retry a failed tab: a new request, only on the user's say-so and not before a rate-limit delay.
   * A tab that stopped at the first-send prompt can be asked again too (the side panel has no
   * prompt of its own: the user confirms in the card, then loads the tab again here).
   */
  retry(mode: ExplainMode): boolean {
    const entry = this.entry(mode);
    if (!this.attached) return false;
    if (entry?.status === 'disclosure') {
      entry.status = 'queued';
      this.live = mode === 'core' ? t('cardLoading') : t('cardLoadingTab', tabLabel(mode));
      this.enqueue(entry);
      this.emit();
      return true;
    }
    if (entry?.status !== 'error' || entry.error?.action !== 'retry') return false;
    if (entry.error.retryAt !== undefined && this.now() < entry.error.retryAt) return false;
    entry.error = null;
    entry.status = 'queued';
    this.live = mode === 'core' ? t('cardLoading') : t('cardLoadingTab', tabLabel(mode));
    this.enqueue(entry);
    this.emit();
    return true;
  }

  /** The user confirmed the first-send prompt: send the SAME request again, with the acknowledgement. */
  confirmDisclosure(mode: ExplainMode): boolean {
    const entry = this.entry(mode);
    if (!this.attached || entry?.status !== 'disclosure') return false;
    entry.acknowledge = true;
    entry.status = 'queued';
    this.live = mode === 'core' ? t('cardLoading') : t('cardLoadingTab', tabLabel(mode));
    this.enqueue(entry);
    this.emit();
    return true;
  }

  /**
   * Adopt results another surface already loaded (the side panel starts from the card's). A mode
   * that is loaded, loading or waiting is kept; a mode not offered for this selection is ignored.
   * Sends nothing.
   */
  seed(results: readonly ExplainResult[], active?: ExplainMode): void {
    if (this.destroyed) return;
    for (const result of results) {
      if (!this.tabs.includes(result.mode)) continue;
      const existing = this.entry(result.mode);
      if (existing !== undefined && existing.status !== 'error') continue;
      const entry = existing ?? this.create(result.mode);
      entry.status = 'ready';
      entry.result = result;
      entry.error = null;
      entry.requestId = result.requestId;
    }
    if (active !== undefined && this.tabs.includes(active)) this.active = active;
    this.emit();
  }

  /**
   * What the side panel needs to continue from here (FR-042): the selection exactly as it was
   * sent, and every loaded tab. Null while nothing has loaded. Plain objects; the background
   * validates the hand-off, the panel renders it as text only.
   */
  handoff(): SidePanelHandoff | null {
    const results: SidePanelHandoff['results'] = [];
    for (const mode of this.tabs) {
      const entry = this.entry(mode);
      if (entry?.status !== 'ready' || entry.result === null) continue;
      const { selectedText: _selected, ...result } = entry.result;
      results.push(result);
    }
    if (results.length === 0) return null;
    return {
      snapshot: this.snapshot,
      results,
      active: this.active,
      ...(this.language !== undefined && results.some((r) => r.mode === 'translate')
        ? { targetLanguage: this.language }
        : {}),
    };
  }

  /** Text for the polite live region (copy feedback, retry becoming available). */
  announce(message: string): void {
    this.live = message;
    this.emit();
  }

  /** The visible result of the active tab as plain text, or null while it has none. */
  activeText(): string | null {
    const entry = this.entry(this.active);
    return entry?.status === 'ready' && entry.result !== null ? resultText(entry.result) : null;
  }

  // -------------------------------------------------------------------------

  private entry(mode: ExplainMode): Entry | undefined {
    return this.entries.get(cacheKey(this.selectionId, mode, this.language));
  }

  private create(mode: ExplainMode): Entry {
    const entry: Entry = {
      mode,
      status: 'queued',
      requestId: null,
      result: null,
      error: null,
      acknowledge: false,
    };
    this.entries.set(cacheKey(this.selectionId, mode, this.language), entry);
    return entry;
  }

  private enqueue(entry: Entry): void {
    this.queue.push(entry);
    this.pump();
  }

  /** Start the next waiting request, if none is running. */
  private pump(): void {
    if (!this.attached || this.inflight !== null) return;
    const next = this.queue.shift();
    if (next !== undefined) this.begin(next);
  }

  private begin(entry: Entry): void {
    // Only a click on Confirm sets this, and it covers exactly this one send.
    const acknowledge = entry.acknowledge;
    entry.acknowledge = false;
    // The same request id for the confirmed resend: it is the same request, now acknowledged.
    const requestId = acknowledge && entry.requestId !== null ? entry.requestId : this.newId();
    entry.requestId = requestId;
    entry.status = 'loading';
    entry.error = null;
    this.inflight = entry;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.expire(entry, requestId), this.timeoutMs);
    const request: ExplainRequest = {
      requestId,
      snapshot: this.snapshot,
      mode: entry.mode,
      ...(entry.mode === 'translate' && this.language !== undefined
        ? { targetLanguage: this.language }
        : {}),
      detailLevel: 'standard',
    };
    this.backend.explain(request, acknowledge).then(
      (reply) => this.settle(entry, requestId, reply, acknowledge),
      () => this.settle(entry, requestId, { kind: 'error', code: 'NO_RESPONSE' }, acknowledge),
    );
    this.emit();
  }

  /** True while `entry` is the request in flight under `requestId`: anything else is stale. */
  private isCurrent(entry: Entry, requestId: string): boolean {
    return (
      this.attached &&
      this.inflight === entry &&
      entry.requestId === requestId &&
      entry.status === 'loading'
    );
  }

  private settle(
    entry: Entry,
    requestId: string,
    reply: BackendReply,
    acknowledged: boolean,
  ): void {
    if (!this.isCurrent(entry, requestId)) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.inflight = null;
    this.apply(entry, requestId, reply, acknowledged);
    this.pump();
    this.emit();
  }

  private apply(entry: Entry, requestId: string, reply: BackendReply, acknowledged: boolean): void {
    if (reply.kind === 'result') {
      // A result for another request or another mode cannot be this answer.
      if (reply.result.requestId !== requestId || reply.result.mode !== entry.mode) {
        this.fail(entry, 'INVALID_RESPONSE');
        return;
      }
      entry.status = 'ready';
      entry.result = reply.result;
      this.live = entry.mode === 'core' ? t('cardReady') : t('cardTabReady', tabLabel(entry.mode));
      return;
    }
    if (reply.kind === 'disclosure') {
      // Asked again after the user confirmed: do not loop on the prompt, show an error instead.
      if (acknowledged) {
        this.fail(entry, 'INTERNAL_ERROR');
        return;
      }
      entry.status = 'disclosure';
      this.live = t('firstSendBody');
      return;
    }
    this.fail(entry, reply.code, reply.retryAfterMs);
  }

  private fail(entry: Entry, code: ClientErrorCode, retryAfterMs?: number): void {
    entry.status = 'error';
    entry.error = toCardError(code, retryAfterMs, this.now());
    this.live = [entry.error.title, entry.error.message].filter(Boolean).join('. ');
  }

  /** The request did not answer in time: stop waiting, tell the background, let the user retry. */
  private expire(entry: Entry, requestId: string): void {
    if (!this.isCurrent(entry, requestId)) return;
    this.backend.cancel(requestId);
    this.timer = undefined;
    this.inflight = null;
    this.fail(entry, 'TIMEOUT');
    this.pump();
    this.emit();
  }

  private build(): SessionState {
    const entries: SessionState['entries'] = {};
    for (const mode of this.tabs) {
      const entry = this.entry(mode);
      if (entry !== undefined) entries[mode] = { ...entry };
    }
    return {
      selectionId: this.selectionId,
      kind: this.snapshot.kind,
      text: this.snapshot.text,
      tabs: this.tabs,
      active: this.active,
      entries,
      live: this.live,
    };
  }

  private emit(): void {
    this.state = this.build();
    for (const listener of [...this.listeners]) listener(this.state);
  }
}

/** Settings section for an error action, or `undefined` for "open Settings" without one. */
export function settingsSectionFor(action: ErrorAction): SettingsSection | undefined {
  if (action === 'connect' || action === 'update-key') return 'key';
  if (action === 'choose-model') return 'model';
  return undefined;
}
