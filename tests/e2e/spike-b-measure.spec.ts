import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { expect, test } from '@playwright/test';
import {
  buildDirFor,
  launchExtension,
  waitForRegistration,
  type LaunchedExtension,
} from './spike-b-support/extension';
import {
  installProbe,
  readTiming,
  resetProbe,
  stopExtensionWorker,
  summarize,
  throttleCpu,
  type Stats,
  type Timing,
} from './spike-b-support/measure';
import { dblclickText, trackWorlds } from './spike-b-support/page';
import { tb } from './spike-b-support/toolbar';
import { startFixtureServer, type FixtureServer } from './spike-b-support/server';

// D-08 measurement: selection end -> toolbar visible, for the three UI loading options
// (architecture.md section 5), built from one source with VITE_CLAVIS_TOOLBAR_VARIANT=a|b|c:
//   node tests/e2e/spike-b-support/build-variants.mjs
//
// Method (details and error bars in tests/e2e/spike-b-support/measure.ts and
// docs/decisions/spike-b-toolbar.md):
//  - every sample is a FRESH page load (new tab, fresh content-script world);
//  - the variants run INTERLEAVED (a, b, c, a, b, c ...), each in its own browser with the same
//    permissions, so load from other processes on this shared machine hits all of them alike;
//  - the first iteration per browser is a discarded warm-up;
//  - "first" = first selection on the page (includes loading the UI); "repeat" = dismiss with
//    Escape, then select another word on the same page.
// Results are also written to test-results/spike-b-latency.json.

const ALL = [
  { id: 'a', label: 'a: background injection', webAccessibleUi: false },
  { id: 'b', label: 'b: dynamic import (web-accessible)', webAccessibleUi: true },
  { id: 'c', label: 'c: Preact bundled', webAccessibleUi: false },
] as const;
type Variant = (typeof ALL)[number];

const WARM_RUNS = Number(process.env['CLAVIS_MEASURE_RUNS'] ?? 30);
const THROTTLED_RUNS = Number(process.env['CLAVIS_MEASURE_THROTTLED_RUNS'] ?? 20);
const COLD_RUNS = Number(process.env['CLAVIS_MEASURE_COLD_RUNS'] ?? 12);
const THROTTLE_RATE = 4;

interface Samples {
  first: Timing[];
  repeat: Timing[];
}
interface ScenarioResult {
  variant: string;
  scenario: string;
  first: { dom: Stats; frame: Stats };
  repeat: { dom: Stats; frame: Stats };
}

const results: ScenarioResult[] = [];
let server: FixtureServer;

test.beforeAll(async () => {
  server = await startFixtureServer();
});

test.afterAll(async () => {
  await server?.close();
  mkdirSync('test-results', { recursive: true });
  writeFileSync(
    'test-results/spike-b-latency.json',
    JSON.stringify(
      { machine: { cpus: os.cpus().length, load: os.loadavg(), node: process.version }, results },
      null,
      2,
    ),
  );
  const f = (x: Stats): string => `${x.p50.toFixed(1)} / ${x.p95.toFixed(1)}`;
  const rows = [
    'variant | scenario | n | first (dom) p50/p95 | first (frame) p50/p95 | repeat (dom) p50/p95 | repeat (frame) p50/p95',
  ];
  for (const r of results) {
    rows.push(
      `${r.variant} | ${r.scenario} | ${r.first.dom.n} | ${f(r.first.dom)} | ${f(r.first.frame)} | ${f(r.repeat.dom)} | ${f(r.repeat.frame)}`,
    );
  }
  console.log(
    `\nload average at end: ${os
      .loadavg()
      .map((x) => x.toFixed(1))
      .join(' ')}\n${rows.join('\n')}\n`,
  );
});

async function measureOnce(
  ext: LaunchedExtension,
  options: { throttle?: number; coldWorker?: boolean },
): Promise<{ first: Timing; repeat: Timing }> {
  const page = await ext.context.newPage();
  const worlds = await trackWorlds(page);
  try {
    if (options.throttle !== undefined) await throttleCpu(ext.context, page, options.throttle);
    await installProbe(page);
    await page.goto(`${server.origin}/article.html`);
    await worlds.waitForObserver();
    if (options.coldWorker === true) await stopExtensionWorker(ext.context, ext.extensionId);

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

async function scenario(
  name: string,
  variants: readonly Variant[],
  runs: number,
  options: { throttle?: number; coldWorker?: boolean } = {},
): Promise<void> {
  const exts = new Map<string, LaunchedExtension>();
  const samples = new Map<string, Samples>();
  try {
    for (const variant of variants) {
      const ext = await launchExtension({
        buildDir: buildDirFor(variant.id),
        grantedSiteAccess: true,
        webAccessibleUi: variant.webAccessibleUi,
      });
      await waitForRegistration(ext.serviceWorker);
      exts.set(variant.id, ext);
      samples.set(variant.id, { first: [], repeat: [] });
    }
    for (let i = 0; i < runs + 1; i++) {
      // Rotate the order so no variant is always measured right after the same neighbour.
      const order = variants.map((_, k) => variants[(k + i) % variants.length] as Variant);
      for (const variant of order) {
        const measured = await measureOnce(exts.get(variant.id) as LaunchedExtension, options);
        if (i === 0) continue; // warm-up
        samples.get(variant.id)?.first.push(measured.first);
        samples.get(variant.id)?.repeat.push(measured.repeat);
      }
    }
  } finally {
    await Promise.all([...exts.values()].map((ext) => ext.close()));
  }
  for (const variant of variants) {
    const s = samples.get(variant.id) as Samples;
    expect(s.first).toHaveLength(runs);
    results.push({
      variant: variant.id,
      scenario: name,
      first: {
        dom: summarize(s.first.map((t) => t.dom)),
        frame: summarize(s.first.map((t) => t.frame)),
      },
      repeat: {
        dom: summarize(s.repeat.map((t) => t.dom)),
        frame: summarize(s.repeat.map((t) => t.frame)),
      },
    });
  }
}

test.describe('D-08 toolbar latency', () => {
  test.skip(
    !ALL.every((v) => existsSync(buildDirFor(v.id))),
    'build the variants first: node tests/e2e/spike-b-support/build-variants.mjs',
  );
  test.setTimeout(15 * 60_000);

  test(`warm worker, ${WARM_RUNS} page loads per option`, async () => {
    await scenario('warm, 1x CPU', ALL, WARM_RUNS);
  });

  test(`warm worker, ${THROTTLE_RATE}x CPU slowdown, ${THROTTLED_RUNS} page loads per option`, async () => {
    await scenario(`warm, ${THROTTLE_RATE}x CPU`, ALL, THROTTLED_RUNS, { throttle: THROTTLE_RATE });
  });

  // Chrome stops an idle worker after about 30 s; the next selection then pays a cold start.
  // Only (a) uses the worker; (c) is the control.
  test(`cold worker (stopped before each selection), ${COLD_RUNS} page loads`, async () => {
    const [a, , c] = ALL;
    await scenario('cold worker, 1x CPU', [a, c], COLD_RUNS, { coldWorker: true });
  });
});
