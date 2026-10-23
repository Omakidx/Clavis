import { performance } from 'node:perf_hooks';
import { expect, test } from '@playwright/test';
import {
  CARD,
  cardOf,
  chatBody,
  overrideChat,
  startCardHarness,
  selectWord,
} from './p5-card-support/harness';
import type { CardHarness } from './p5-card-support/harness';
import { machineLoad, median, round, writeResult } from './p9-perf-support/metrics';
import { summarize } from './spike-b-support/measure';
import { tb } from './spike-b-support/toolbar';

/**
 * Phase 9 AI latency: how much time the EXTENSION adds around an AI answer, with Groq replaced by a
 * test server that answers after a fixed delay. This says nothing about Groq's own speed (the
 * requirements promise no backend SLA; measure p50/p95 with a real free-tier account for that, see
 * docs/decisions/p5-prompt-eval.md). It answers a different question: when the answer arrives, how
 * long until the card shows it, and how long between the Explain click and the request leaving?
 *
 *   clickToRequest   Explain click -> the request reaches the (fake) network. Includes, on the FIRST
 *                    Explain of a page, injecting the card script (D-08) plus the message hop to the
 *                    service worker, key/model lookup and prompt construction.
 *   responseToPaint  the fake server answers -> the card shows the validated core answer. Service
 *                    worker parse + schema validation + message back + render.
 *   overhead         click -> answer painted, minus the server delay: everything the extension adds.
 *
 * All timestamps come from this Node process's one clock; the card sits in a CLOSED shadow root
 * and is polled through the DevTools protocol (about 10-20 ms resolution), so the figures have that
 * granularity. Asserted: only generous ceilings (the box is often loaded, CI runners vary), plus
 * that every Explain makes exactly one request. Results: <outputDir>/p9-perf-ai-latency.json.
 *
 * Env: CLAVIS_P9_AI_SAMPLES (page loads per delay, default 10).
 */
const SAMPLES = Number(process.env['CLAVIS_P9_AI_SAMPLES'] ?? 10);
const DELAYS_MS = [0, 600];
/** Ceilings: loose on purpose; the measured values sit far below (see the decision record). */
const MAX_FIRST_OVERHEAD_P95_MS = 1000;
const MAX_LATER_OVERHEAD_P95_MS = 750;
const MAX_PAINT_P95_MS = 400;

const CORE = JSON.stringify({
  title: 'council',
  summary: 'A group that makes decisions.',
  contextualMeaning: 'Here it is the town governing body.',
  definition: 'An assembly that advises or governs.',
  examples: [
    { sentence: 'The council voted to close the building.', note: null },
    { sentence: 'A council of elders met.', note: null },
  ],
  caveat: null,
});

interface Sample {
  clickToRequest: number;
  responseToPaint: number;
  overhead: number;
}

let h: CardHarness;
test.beforeAll(async () => {
  h = await startCardHarness();
});
test.afterAll(async () => {
  await h?.close();
});

/** Poll (about every 10 ms) until `selector` exists in the card; returns performance.now() then. */
async function until(selector: string, page: import('@playwright/test').Page): Promise<number> {
  const card = cardOf(page);
  const deadline = performance.now() + 15_000;
  for (;;) {
    try {
      if (await card.exists(selector)) return performance.now();
    } catch (error) {
      if (!/Could not find node|No node with given id/.test(String(error))) throw error;
    }
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${selector}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// eslint-disable-next-line no-empty-pattern
test('Explain: extension overhead around a fixed-delay AI answer, first and later Explain on a page', async ({}, testInfo) => {
  test.setTimeout(10 * 60_000);
  const timing = { requestAt: 0, fulfilledAt: 0, requests: 0 };
  let delay = 0;
  await overrideChat(h.ext.context, async (route) => {
    timing.requests++;
    timing.requestAt = performance.now();
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    timing.fulfilledAt = performance.now();
    await route.fulfill({ status: 200, contentType: 'application/json', body: chatBody(CORE) });
  });

  async function explainOnce(page: import('@playwright/test').Page, word: string): Promise<Sample> {
    await selectWord(page, word);
    const box = await tb(page).box('[data-action="explain"]');
    const requestsBefore = timing.requests;
    const t0 = performance.now();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    const tReady = await until(CARD.ready('core'), page);
    expect(timing.requests - requestsBefore, 'one chat request per Explain').toBe(1);
    return {
      clickToRequest: timing.requestAt - t0,
      responseToPaint: tReady - timing.fulfilledAt,
      overhead: tReady - t0 - delay,
    };
  }

  const results: Record<string, { first: Sample[]; later: Sample[] }> = {};
  const loadBefore = machineLoad();
  for (const d of DELAYS_MS) {
    delay = d;
    const first: Sample[] = [];
    const later: Sample[] = [];
    for (let i = 0; i < SAMPLES + 1; i++) {
      const { page, dispose } = await h.open();
      try {
        const a = await explainOnce(page, 'cartographer');
        await page.keyboard.press('Escape');
        await tb(page).waitHidden();
        const b = await explainOnce(page, 'council');
        if (i === 0) continue; // warm-up: service worker and model cache
        first.push(a);
        later.push(b);
      } finally {
        await dispose();
      }
    }
    results[`delay${d}ms`] = { first, later };
  }

  const stat = (samples: Sample[], key: keyof Sample) => {
    const s = summarize(samples.map((x) => x[key]));
    return { p50: round(s.p50), p95: round(s.p95), max: round(s.max) };
  };
  const report = Object.fromEntries(
    Object.entries(results).map(([name, r]) => [
      name,
      {
        samples: r.first.length,
        firstExplain: {
          clickToRequest: stat(r.first, 'clickToRequest'),
          responseToPaint: stat(r.first, 'responseToPaint'),
          overhead: stat(r.first, 'overhead'),
        },
        laterExplain: {
          clickToRequest: stat(r.later, 'clickToRequest'),
          responseToPaint: stat(r.later, 'responseToPaint'),
          overhead: stat(r.later, 'overhead'),
        },
      },
    ]),
  );
  writeResult(testInfo, 'p9-perf-ai-latency', {
    note: 'Fixed-delay fake Groq; measures extension overhead only, not Groq latency. Poll resolution ~10-20 ms.',
    machineBefore: loadBefore,
    medianOverheadMs: round(
      median(Object.values(results).flatMap((r) => r.first.map((x) => x.overhead))),
    ),
    ...report,
  });

  for (const r of Object.values(results)) {
    const firstOverhead = summarize(r.first.map((x) => x.overhead)).p95;
    const laterOverhead = summarize(r.later.map((x) => x.overhead)).p95;
    const paint = Math.max(
      summarize(r.first.map((x) => x.responseToPaint)).p95,
      summarize(r.later.map((x) => x.responseToPaint)).p95,
    );
    expect(firstOverhead, 'first Explain: extension overhead p95').toBeLessThanOrEqual(
      MAX_FIRST_OVERHEAD_P95_MS,
    );
    expect(laterOverhead, 'later Explain: extension overhead p95').toBeLessThanOrEqual(
      MAX_LATER_OVERHEAD_P95_MS,
    );
    expect(paint, 'answer arrival -> card painted, p95').toBeLessThanOrEqual(MAX_PAINT_P95_MS);
  }
});
