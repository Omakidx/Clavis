import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExplainSession, type SessionState } from '../../../components/explanation/session';
import type { ExplainMode } from '../../../lib/contracts/explain';
import {
  createFakeBackend,
  flush,
  installCatalog,
  makeSnapshot,
  resultFor,
  type PendingCall,
} from '../explanation/support';

// Phase 9, "Regression test navigation/reselection stale answers" (architecture section 5 rule 8:
// "A response is displayed only if its requestId and selection token match"; requirements NFR
// "stale-response prevention"; FR-038 "opening an already-loaded tab for the same selection makes
// no new request"). The session tests cover chosen sequences; this one throws thousands of RANDOM
// interleavings at the real ExplainSession (tabs opened, cards detached and re-attached, replies
// answered late, twice, out of order, for the wrong request, with the wrong mode, after destroy)
// and checks the invariants that must hold in every one of them. The seed is fixed: a failure
// reproduces, and the message names the run and the operation log.

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let ids = 0;
const newId = (): string => `id-${(ids += 1)}`;

beforeEach(() => {
  installCatalog();
  ids = 0;
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

// The tabs of a word under the shipped flags: Translate is on (FR-037), Grammar off (FR-036).
const MODES: ExplainMode[] = ['core', 'etymology', 'related_words', 'translate'];
const STALE = 'STALE-ANSWER-OF-ANOTHER-REQUEST';

/** Every text the session state could show a person. */
function visibleText(state: SessionState): string {
  return JSON.stringify(state.entries) + state.live;
}

interface Run {
  log: string[];
}

const coverage = new Map<string, number>();

async function oneRun(seed: number): Promise<void> {
  const next = rng(seed);
  const run: Run = { log: [] };
  const fake = createFakeBackend();
  const snapshot = makeSnapshot('word', `WORD${seed}`);
  const session = new ExplainSession({
    snapshot,
    backend: fake.backend,
    newId,
    now: () => Date.now(),
    targetLanguage: 'fr',
  });
  let destroyed = false;
  let notifiedAfterDestroy = 0;
  session.subscribe(() => {
    if (destroyed) notifiedAfterDestroy += 1;
  });

  /** The ready-set the session reported before each call to the backend. */
  const callsMadeWhileReady: string[] = [];
  const originalExplain = fake.backend.explain.bind(fake.backend);
  fake.backend.explain = (request, acknowledge) => {
    const entry = session.state.entries[request.mode];
    // A request for a mode that is already answered for this selection is a duplicate (FR-038).
    if (entry?.status === 'ready' && !destroyed) callsMadeWhileReady.push(request.mode);
    if (!session.state.entries[request.mode] && destroyed)
      callsMadeWhileReady.push('after-destroy');
    return originalExplain(request, acknowledge);
  };

  const answered = new Set<PendingCall>();
  const fail = (what: string): never => {
    throw new Error(`seed ${seed}: ${what}\n  operations: ${run.log.join(' | ')}`);
  };

  const steps = 10 + Math.floor(next() * 40);
  for (let i = 0; i < steps; i++) {
    const op = next();
    const pending = fake.calls.filter((c) => !answered.has(c));
    if (op < 0.2) {
      const mode = MODES[Math.floor(next() * MODES.length)]!;
      run.log.push(`tab:${mode}`);
      session.selectTab(mode);
    } else if (op < 0.3) {
      run.log.push('attach');
      session.attach();
    } else if (op < 0.4) {
      run.log.push('detach');
      session.detach();
    } else if (op < 0.75 && pending.length > 0) {
      // Answer ANY unanswered request, not necessarily the newest one.
      const call = pending[Math.floor(next() * pending.length)]!;
      answered.add(call);
      const kind = next();
      if (kind < 0.55) {
        run.log.push(`answer:${call.request.mode}:ok`);
        call.succeed();
      } else if (kind < 0.65) {
        run.log.push(`answer:${call.request.mode}:wrong-id`);
        call.reply({
          kind: 'result',
          result: resultFor(call.request, { requestId: 'someone-elses', title: STALE }),
        });
      } else if (kind < 0.75) {
        run.log.push(`answer:${call.request.mode}:wrong-mode`);
        const other = call.request.mode === 'core' ? 'etymology' : 'core';
        call.reply({
          kind: 'result',
          result: resultFor(
            { ...call.request, mode: other },
            { requestId: call.request.requestId, title: STALE },
          ),
        });
      } else if (kind < 0.85) {
        run.log.push(`answer:${call.request.mode}:rate`);
        call.reply({ kind: 'error', code: 'RATE_LIMITED', retryAfterMs: 2000 });
      } else if (kind < 0.92) {
        run.log.push(`answer:${call.request.mode}:network`);
        call.reply({ kind: 'error', code: 'NETWORK_ERROR' });
      } else {
        run.log.push(`answer:${call.request.mode}:cancelled`);
        call.reply({ kind: 'error', code: 'REQUEST_CANCELLED' });
      }
    } else if (op < 0.8 && answered.size > 0) {
      // The same reply delivered a second time (a duplicate message).
      const call = [...answered][Math.floor(next() * answered.size)]!;
      run.log.push(`duplicate-answer:${call.request.mode}`);
      call.succeed({ title: STALE });
    } else if (op < 0.9) {
      const mode = MODES[Math.floor(next() * MODES.length)]!;
      run.log.push(`retry:${mode}`);
      session.retry(mode);
    } else if (op < 0.95) {
      run.log.push('advance-time');
      vi.advanceTimersByTime(Math.floor(next() * 60_000));
    } else if (op < 0.98 && !destroyed) {
      run.log.push('destroy');
      session.destroy();
      destroyed = true;
    } else {
      run.log.push('noop');
    }
    // Let the answered promises settle into the session, then check the invariants after EVERY operation.
    await flush();
    coverage.set(
      run.log.at(-1)!.split(':').slice(0, 1).join(''),
      (coverage.get(run.log.at(-1)!.split(':')[0]!) ?? 0) + 1,
    );
    coverage.set(run.log.at(-1)!, (coverage.get(run.log.at(-1)!) ?? 0) + 1);
    const state = session.state;
    const shown = visibleText(state);
    if (shown.includes(STALE)) fail('an answer for another request/mode is on screen');
    for (const mode of MODES) {
      const entry = state.entries[mode];
      if (entry === undefined) continue;
      if (entry.status === 'ready') {
        if (entry.result === null) fail(`${mode} is ready without a result`);
        if (entry.result?.mode !== mode) fail(`${mode} shows a ${entry.result?.mode} result`);
        if (entry.result?.requestId !== entry.requestId)
          fail(`${mode} shows another request's result`);
        if (entry.result?.selectedText !== snapshot.text)
          fail(`${mode} shows another selection's text`);
      }
      if (entry.status === 'error' && entry.result !== null)
        fail(`${mode} shows an error and a result`);
    }
    // At most one request is loading at a time (the background allows one in flight per sender).
    const loading = MODES.filter((m) => state.entries[m]?.status === 'loading');
    if (loading.length > 1) fail(`two requests loading at once: ${loading.join(', ')}`);
  }
  if (callsMadeWhileReady.length > 0) {
    fail(
      `a request was sent for a tab that was already answered: ${callsMadeWhileReady.join(',')}`,
    );
  }
  if (destroyed && notifiedAfterDestroy > 0)
    fail('a destroyed session still notified its listeners');
  session.destroy();
}

describe('ExplainSession under random interleavings', () => {
  it('never shows a stale, mismatched or duplicate answer, never double-loads a tab and never has two requests in flight (1,500 runs)', async () => {
    for (let seed = 1; seed <= 1500; seed++) {
      await oneRun(seed);
    }
    // The generator really exercised every kind of operation, many times (the test is not vacuous).
    for (const op of [
      'attach',
      'detach',
      'destroy',
      'advance-time',
      'duplicate-answer',
      'tab',
      'retry',
      'answer',
    ]) {
      expect(coverage.get(op) ?? 0, `operation ${op}`).toBeGreaterThan(100);
    }
    for (const outcome of ['ok', 'wrong-id', 'wrong-mode', 'rate', 'network', 'cancelled']) {
      const seen = [...coverage].filter(
        ([k]) => k.startsWith('answer:') && k.endsWith(`:${outcome}`),
      );
      expect(
        seen.reduce((n, [, c]) => n + c, 0),
        `answer outcome ${outcome}`,
      ).toBeGreaterThan(50);
    }
  });

  it('self-check: the probe that looks for a stale answer on screen sees one when it is there', () => {
    // A hand-made violation: the checks above would flag this exact state.
    const state = {
      entries: {
        core: {
          status: 'ready',
          result: { mode: 'core', requestId: 'a', selectedText: 'x', title: STALE },
          requestId: 'b',
        },
      },
      live: '',
    } as unknown as SessionState;
    expect(visibleText(state)).toContain(STALE);
  });
});
