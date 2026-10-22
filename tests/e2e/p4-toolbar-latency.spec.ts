import { mkdirSync, writeFileSync } from 'node:fs';
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
  type Stats,
  type Timing,
} from './spike-b-support/measure';
import { dblclickText, trackWorlds } from './spike-b-support/page';
import { startFixtureServer, type FixtureServer } from './spike-b-support/server';
import { tb } from './spike-b-support/toolbar';

// Phase 4 re-measurement of the toolbar latency budgets (docs/tech-stack.md section 6) on the
// PRODUCTION build (the Spike B variant builds are gone, D-08): selection end -> toolbar visible.
//
//   first   the first selection on a fresh page load (UI is bundled, nothing is loaded)
//   repeat  Escape, then select another word on the same page
//
// Method (see tests/e2e/spike-b-support/measure.ts and docs/decisions/spike-b-toolbar.md):
// every sample is a fresh tab, the first iteration is discarded, timestamps come from one
// page-side clock, `frame` is the conservative number (adds up to one animation frame).
// Budgets: first p95 <= 150 ms, repeat p95 <= 50 ms. They are only ASSERTED with
// CLAVIS_LATENCY_STRICT=1 on a quiet machine; otherwise the numbers are recorded and the test
// checks a loose sanity bound (3x), because absolute latency depends on the machine's load.
// Results: test-results/p4-toolbar-latency.json.
const RUNS = Number(process.env['CLAVIS_MEASURE_RUNS'] ?? 30);
const STRICT = process.env['CLAVIS_LATENCY_STRICT'] === '1';
const THROTTLE = 4;

interface Row {
  scenario: string;
  first: { dom: Stats; frame: Stats };
  repeat: { dom: Stats; frame: Stats };
}
const rows: Row[] = [];
let server: FixtureServer;
let ext: LaunchedExtension;
const loadBefore = os.loadavg();

test.beforeAll(async () => {
  server = await startFixtureServer();
  ext = await launchExtension({ grantedSiteAccess: true });
  await waitForRegistration(ext.serviceWorker);
});

test.afterAll(async () => {
  await ext?.close();
  await server?.close();
  mkdirSync('test-results', { recursive: true });
  writeFileSync(
    'test-results/p4-toolbar-latency.json',
    JSON.stringify(
      {
        machine: {
          cpus: os.cpus().length,
          loadBefore,
          loadAfter: os.loadavg(),
          node: process.version,
        },
        runs: RUNS,
        rows,
      },
      null,
      2,
    ),
  );
  const f = (x: Stats): string => `${x.p50.toFixed(1)} / ${x.p95.toFixed(1)}`;
  const lines = [
    'scenario | n | first dom | first frame | repeat dom | repeat frame (p50 / p95 ms)',
  ];
  for (const r of rows) {
    lines.push(
      `${r.scenario} | ${r.first.dom.n} | ${f(r.first.dom)} | ${f(r.first.frame)} | ${f(r.repeat.dom)} | ${f(r.repeat.frame)}`,
    );
  }
  const load = (x: number[]): string => x.map((v) => v.toFixed(1)).join(' ');
  console.log(
    `\nload average (1/5/15 min) before: ${load(loadBefore)}, after: ${load(os.loadavg())}, ${os.cpus().length} CPUs\n${lines.join('\n')}\n`,
  );
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

async function scenario(name: string, throttle?: number): Promise<void> {
  const first: Timing[] = [];
  const repeat: Timing[] = [];
  for (let i = 0; i < RUNS + 1; i++) {
    const sample = await measureOnce(throttle);
    if (i === 0) continue; // warm-up
    first.push(sample.first);
    repeat.push(sample.repeat);
  }
  const row: Row = {
    scenario: name,
    first: { dom: summarize(first.map((t) => t.dom)), frame: summarize(first.map((t) => t.frame)) },
    repeat: {
      dom: summarize(repeat.map((t) => t.dom)),
      frame: summarize(repeat.map((t) => t.frame)),
    },
  };
  rows.push(row);
  expect(row.first.frame.n).toBe(RUNS);
  const slack = STRICT ? 1 : 3;
  expect(row.first.frame.p95, 'first toolbar p95 (frame)').toBeLessThanOrEqual(150 * slack);
  expect(row.repeat.frame.p95, 'repeat toolbar p95 (frame)').toBeLessThanOrEqual(50 * slack);
}

test.describe('toolbar latency, production build', () => {
  test.setTimeout(15 * 60_000);

  test(`1x CPU, ${RUNS} page loads`, async () => {
    await scenario('1x CPU');
  });

  test(`${THROTTLE}x CPU slowdown, ${RUNS} page loads`, async () => {
    await scenario(`${THROTTLE}x CPU`, THROTTLE);
  });
});
