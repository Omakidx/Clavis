import { cpus, loadavg } from 'node:os';
import { expect, test } from '@playwright/test';
import { expectHidden, expectShown, resetPage, selectText } from './p4-matrix-support/actions';
import {
  FIRST_TOOLBAR_BUDGET_MS,
  LATER_TOOLBAR_BUDGET_MS,
  percentile,
} from './p4-matrix-support/detect';
import { openFixture, startHarness, writeReport, type Harness } from './p4-matrix-support/harness';
import { manifest } from './p4-matrix-support/manifest';
import { readProbe, resetProbe } from './p4-matrix-support/page';

// Performance spot-check (tech-stack.md section 6): first toolbar on a page <= 150 ms p95 including
// the UI load, later toolbars <= 50 ms p95. Measured inside the page with the probe (last real
// mouseup to the toolbar host being displayed), so Playwright and CDP latency are excluded.
// Reported always; asserted only against a catastrophic ceiling. The budgets themselves are asserted
// only with CLAVIS_LATENCY_STRICT=1 on a machine whose load is known and low (never on Windows,
// where os.loadavg() is always zero), so CI cannot flake on timing.

const LOADS = Number(process.env['CLAVIS_MATRIX_PERF_LOADS'] ?? 25);
/** Only trust absolute numbers when the 1-minute load average per core is below this. */
const QUIET_LOAD_PER_CORE = 0.5;
/** Strict budgets are asserted only when asked for (never by default, so CI cannot flake on timing). */
const STRICT = process.env['CLAVIS_LATENCY_STRICT'] === '1';
const CEILING_MS = 600;
const FIXTURES = [
  {
    id: 'plain-baseline',
    first: ['sat on the bank of the river', 'bank'],
    later: ['such as idempotent or', 'idempotent'],
  },
  {
    id: 'news-article',
    first: ['new propeller shaft', 'propeller'],
    later: ['replacement bearings,', 'bearings'],
  },
] as const;

let harness: Harness;
test.beforeAll(async () => {
  harness = await startHarness();
});
test.afterAll(async () => {
  await harness?.close();
});

test(`first and repeat toolbar latency over ${LOADS} page loads on two fixtures`, async () => {
  test.setTimeout(300_000);
  const cores = cpus().length;
  const loadBefore = loadavg();
  const results: Record<string, { first: number[]; later: number[] }> = {};

  for (const entry of FIXTURES) {
    const fixture = manifest.fixtures.find((f) => f.id === entry.id);
    if (fixture === undefined) throw new Error(entry.id);
    const first: number[] = [];
    const later: number[] = [];
    // One discarded warm-up load per fixture (browser start, first service worker wake).
    for (let i = -1; i < LOADS; i++) {
      const opened = await openFixture(harness.ext.context, harness.server, fixture);
      try {
        const page = opened.page;
        await resetProbe(page);
        await selectText(page, page, { context: entry.first[0], text: entry.first[1] }, 'dblclick');
        expect(await expectShown(page)).toBe(true);
        const a = await readProbe(page);
        await page.keyboard.press('Escape');
        await expectHidden(page);
        await resetPage(page);
        await resetProbe(page);
        await selectText(page, page, { context: entry.later[0], text: entry.later[1] }, 'dblclick');
        expect(await expectShown(page)).toBe(true);
        const b = await readProbe(page);
        if (i >= 0 && a.t0 !== null && a.tDom !== null) first.push(a.tDom - a.t0);
        if (i >= 0 && b.t0 !== null && b.tDom !== null) later.push(b.tDom - b.t0);
      } finally {
        await opened.close();
      }
    }
    results[entry.id] = { first, later };
  }

  const loadAfter = loadavg();
  const summary = Object.fromEntries(
    Object.entries(results).map(([id, r]) => [
      id,
      {
        first: {
          n: r.first.length,
          p50: percentile(r.first, 50),
          p95: percentile(r.first, 95),
          max: Math.max(...r.first),
        },
        later: {
          n: r.later.length,
          p50: percentile(r.later, 50),
          p95: percentile(r.later, 95),
          max: Math.max(...r.later),
        },
      },
    ]),
  );
  // os.loadavg() is always [0, 0, 0] on Windows, so an all-zero reading means "unknown", not "quiet".
  const loadKnown =
    process.platform !== 'win32' && [...loadBefore, ...loadAfter].some((n) => n > 0);
  const quiet =
    loadKnown && Math.max(loadBefore[0] ?? 0, loadAfter[0] ?? 0) / cores <= QUIET_LOAD_PER_CORE;
  const strict = STRICT && quiet;
  const report = {
    loads: LOADS,
    cores,
    loadAverage: { before: loadBefore, after: loadAfter },
    quietMachine: quiet,
    strictBudgets: strict,
    budgets: { firstP95Ms: FIRST_TOOLBAR_BUDGET_MS, laterP95Ms: LATER_TOOLBAR_BUDGET_MS },
    summary,
    raw: results,
  };
  const file = await writeReport('performance.json', report);
  const text = JSON.stringify({ ...report, raw: undefined }, null, 2);
  await test.info().attach('performance.json', { body: text, contentType: 'application/json' });
  console.log(`performance (${file})\n${text}`);

  for (const [id, r] of Object.entries(summary)) {
    expect(r.first.n, `${id}: samples`).toBeGreaterThanOrEqual(LOADS * 0.8);
    expect(r.first.p95, `${id}: first-toolbar p95 ceiling`).toBeLessThanOrEqual(CEILING_MS);
    expect(r.later.p95, `${id}: later-toolbar p95 ceiling`).toBeLessThanOrEqual(CEILING_MS);
    if (strict) {
      expect(
        r.first.p95,
        `${id}: first-toolbar p95 vs ${FIRST_TOOLBAR_BUDGET_MS} ms budget`,
      ).toBeLessThanOrEqual(FIRST_TOOLBAR_BUDGET_MS);
      expect(
        r.later.p95,
        `${id}: later-toolbar p95 vs ${LATER_TOOLBAR_BUDGET_MS} ms budget`,
      ).toBeLessThanOrEqual(LATER_TOOLBAR_BUDGET_MS);
    } else {
      test.info().annotations.push({
        type: 'note',
        description: `budgets reported, not asserted (strict=${String(STRICT)}, load known=${String(loadKnown)}, quiet=${String(quiet)}, load ${loadBefore[0]?.toFixed(1)}/${cores} cores)`,
      });
    }
  }
});
