import os from 'node:os';
import { expect, test } from '@playwright/test';
import {
  launchExtension,
  waitForRegistration,
  type LaunchedExtension,
} from './spike-b-support/extension';
import {
  installProbe,
  readTiming,
  resetProbe,
  summarize,
  throttleCpu,
  type Timing,
} from './spike-b-support/measure';
import { dblclickText, trackWorlds } from './spike-b-support/page';
import { startFixtureServer, type FixtureServer } from './spike-b-support/server';
import { tb } from './spike-b-support/toolbar';
import { machineLoad, median, round, writeResult } from './p9-perf-support/metrics';

/**
 * Phase 9 toolbar latency, repeated: the Phase 4 measurement (tests/e2e/p4-toolbar-latency.spec.ts,
 * same probe and method, see docs/decisions/spike-b-toolbar.md) run in ROUNDS, with the load
 * average recorded per round, so a noisy machine shows up as a spread between rounds instead of
 * one unexplained outlier. The reported figure is the MEDIAN of the rounds' p95 values.
 *
 * Budgets (docs/requirements.md NFR, docs/tech-stack.md section 6, D-08): first toolbar on a page
 * <= 150 ms p95 including the lazy UI load, later toolbars <= 50 ms p95, selection end -> toolbar
 * visible (the `frame` figure: one animation frame later than the DOM change, the conservative one).
 *
 * Asserted: the budgets themselves only with CLAVIS_LATENCY_STRICT=1 (quiet machine, never on CI);
 * otherwise a 3x sanity ceiling, because absolute latency depends on machine load and a CI runner
 * must not flake. The numbers are always logged and written to <outputDir>/p9-perf-toolbar.json.
 *
 * Env: CLAVIS_P9_ROUNDS (default 3), CLAVIS_P9_LOADS (page loads per round, default 15).
 */
const ROUNDS = Number(process.env['CLAVIS_P9_ROUNDS'] ?? 3);
const LOADS = Number(process.env['CLAVIS_P9_LOADS'] ?? 15);
const STRICT = process.env['CLAVIS_LATENCY_STRICT'] === '1';
const FIRST_BUDGET_MS = 150;
const REPEAT_BUDGET_MS = 50;
const SLACK = STRICT ? 1 : 3;

interface Round {
  first: { p50: number; p95: number };
  repeat: { p50: number; p95: number };
  loadBefore: number;
  loadAfter: number;
}
interface Scenario {
  name: string;
  throttle: number | undefined;
  rounds: Round[];
  medianFirstP95: number;
  medianRepeatP95: number;
}
const scenarios: Scenario[] = [];
let server: FixtureServer;
let ext: LaunchedExtension;

test.beforeAll(async () => {
  server = await startFixtureServer();
  ext = await launchExtension({ grantedSiteAccess: true });
  await waitForRegistration(ext.serviceWorker);
});
test.afterAll(async () => {
  await ext?.close();
  await server?.close();
});

async function measureOnce(
  throttle: number | undefined,
): Promise<{ first: Timing; repeat: Timing }> {
  const page = await ext.context.newPage();
  const worlds = await trackWorlds(page);
  try {
    if (throttle !== undefined) await throttleCpu(ext.context, page, throttle);
    await installProbe(page);
    await page.goto(`${server.origin}/article.html`);
    await worlds.waitForObserver();

    await resetProbe(page);
    await dblclickText(page, page, 'cartographer');
    const first = await readTiming(page);
    await tb(page).waitShown();

    await page.keyboard.press('Escape');
    await tb(page).waitHidden();
    await resetProbe(page);
    await dblclickText(page, page, 'Ingrid');
    const repeat = await readTiming(page);
    return { first, repeat };
  } finally {
    await worlds.dispose();
    await page.close();
  }
}

async function runScenario(name: string, throttle: number | undefined): Promise<void> {
  const rounds: Round[] = [];
  for (let r = 0; r < ROUNDS; r++) {
    const loadBefore = os.loadavg()[0] ?? 0;
    const first: number[] = [];
    const repeat: number[] = [];
    for (let i = 0; i < LOADS + 1; i++) {
      const sample = await measureOnce(throttle);
      if (i === 0) continue; // warm-up: first page load of the round
      first.push(sample.first.frame);
      repeat.push(sample.repeat.frame);
    }
    const f = summarize(first);
    const rp = summarize(repeat);
    expect(f.n).toBe(LOADS);
    rounds.push({
      first: { p50: round(f.p50), p95: round(f.p95) },
      repeat: { p50: round(rp.p50), p95: round(rp.p95) },
      loadBefore: round(loadBefore, 2),
      loadAfter: round(os.loadavg()[0] ?? 0, 2),
    });
  }
  const scenario: Scenario = {
    name,
    throttle,
    rounds,
    medianFirstP95: round(median(rounds.map((x) => x.first.p95))),
    medianRepeatP95: round(median(rounds.map((x) => x.repeat.p95))),
  };
  scenarios.push(scenario);
  expect(
    scenario.medianFirstP95,
    `first toolbar p95, median of ${ROUNDS} rounds (${name})`,
  ).toBeLessThanOrEqual(FIRST_BUDGET_MS * SLACK);
  expect(
    scenario.medianRepeatP95,
    `repeat toolbar p95, median of ${ROUNDS} rounds (${name})`,
  ).toBeLessThanOrEqual(REPEAT_BUDGET_MS * SLACK);
}

test.describe('toolbar latency, median of rounds', () => {
  test.setTimeout(20 * 60_000);

  test(`1x CPU: ${ROUNDS} rounds x ${LOADS} page loads`, async () => {
    await runScenario('1x CPU', undefined);
  });
  test(`4x CPU slowdown: ${ROUNDS} rounds x ${LOADS} page loads`, async () => {
    await runScenario('4x CPU', 4);
  });

  // eslint-disable-next-line no-empty-pattern
  test.afterAll(({}, testInfo) => {
    const load = machineLoad();
    writeResult(testInfo, 'p9-perf-toolbar', {
      budgetsMs: { firstP95: FIRST_BUDGET_MS, repeatP95: REPEAT_BUDGET_MS },
      asserted: STRICT
        ? 'budgets'
        : `${SLACK}x sanity ceiling (set CLAVIS_LATENCY_STRICT=1 for the budgets)`,
      quietMachine: load.loadavg[0]! / load.cpus < 0.5,
      rounds: ROUNDS,
      loadsPerRound: LOADS,
      scenarios,
    });
  });
});
