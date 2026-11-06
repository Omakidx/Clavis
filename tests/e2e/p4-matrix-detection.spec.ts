import { expect, test } from '@playwright/test';
import {
  attemptSelection,
  DETECTION_RATE_THRESHOLD,
  FIRST_TOOLBAR_BUDGET_MS,
  groupBy,
  LATER_TOOLBAR_BUDGET_MS,
  percentile,
  summarize,
  type Attempt,
} from './p4-matrix-support/detect';
import { openFixture, startHarness, writeReport, type Harness } from './p4-matrix-support/harness';
import { manifest, methodsFor } from './p4-matrix-support/manifest';

// Headline measure (requirements.md section 1): "Basic selection detection >= 95% success on the
// project's predefined supported-page fixture suite".
//
// For every fixture x target x method the text is selected with REAL input (double-click, drag,
// triple-click, double-click-then-Shift+arrow), and an attempt passes when
//   - the toolbar appears (within DETECTION_TIMEOUT_MS),
//   - it is classified as the expected kind (when the build exposes the kind),
//   - it sits near the selection,
//   - the text it captured equals the selection (read from the card after clicking Explain,
//     when the build exposes it).
// Attempts where the browser itself did not select the intended text, or the fixture could not be
// located, are "invalid": they are reported, excluded from the rate and asserted to be zero.

let harness: Harness;
const attempts: Attempt[] = [];
// The summary consumes all preceding attempts; a retry must rerun that complete measurement.
test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  harness = await startHarness();
});
test.afterAll(async () => {
  await harness?.close();
});

const expectedAttempts = manifest.fixtures.reduce(
  (sum, fixture) => sum + fixture.targets.reduce((n, target) => n + methodsFor(target).length, 0),
  0,
);

test('the fixture suite has at least 20 pages and plenty of targets of every selection kind', () => {
  expect(manifest.fixtures.length).toBeGreaterThanOrEqual(20);
  const perKind = new Map<string, number>();
  for (const fixture of manifest.fixtures) {
    expect(fixture.targets.length, `${fixture.id} has targets`).toBeGreaterThanOrEqual(2);
    for (const target of fixture.targets) {
      const kind = String(Array.isArray(target.kind) ? target.kind[0] : target.kind);
      perKind.set(kind, (perKind.get(kind) ?? 0) + 1);
    }
  }
  for (const kind of ['word', 'phrase', 'sentence', 'passage']) {
    expect(perKind.get(kind) ?? 0, `targets of kind ${kind}`).toBeGreaterThanOrEqual(15);
  }
  const ids = manifest.fixtures.map((f) => f.id);
  expect(new Set(ids).size).toBe(ids.length);
});

for (const fixture of manifest.fixtures) {
  test(`select every target on ${fixture.id} by every method`, async () => {
    test.setTimeout(180_000);
    const opened = await openFixture(harness.ext.context, harness.server, fixture);
    try {
      let first = true;
      for (const target of fixture.targets) {
        for (const method of methodsFor(target)) {
          const surface = opened.surface(target.frame);
          let attempt: Attempt;
          try {
            attempt = await attemptSelection(
              {
                page: opened.page,
                surface,
                surfaces: opened.surfaces(),
                fixture,
                readCapture: true,
              },
              target,
              method,
            );
          } catch (error) {
            attempt = {
              fixture: fixture.id,
              target: target.id,
              kind: String(target.kind),
              method,
              outcome: 'invalid',
              reason: `harness error: ${String(error).split('\n')[0]}`,
              expected: target.text ?? target.startsWith ?? '',
              selected: '',
              appearMs: null,
              latencyMs: null,
              kindSeen: null,
              captured: 'unavailable',
              capturedText: null,
              covers: false,
              first: false,
            };
          }
          attempts.push({ ...attempt, first });
          first = false;
        }
      }
    } finally {
      await opened.close();
    }
  });
}

function table(rows: Array<Record<string, string | number>>): string {
  if (rows.length === 0) return '(none)';
  const keys = Object.keys(rows[0] as object);
  const line = (cells: Array<string | number>): string => `| ${cells.join(' | ')} |`;
  return [
    line(keys),
    line(keys.map(() => '---')),
    ...rows.map((r) => line(keys.map((k) => r[k] ?? ''))),
  ].join('\n');
}

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;

test(`basic selection detection rate is at least ${DETECTION_RATE_THRESHOLD * 100}% (requirements section 1)`, async () => {
  // Partial data (a worker restarted after an infrastructure error) must never pass.
  expect(attempts.length, 'every fixture x target x method was attempted').toBe(expectedAttempts);
  const overall = summarize(attempts);
  const byMethod = [...groupBy(attempts, (a) => a.method)].map(([method, rows]) => ({
    method,
    ...summarize(rows),
  }));
  const byFixture = [...groupBy(attempts, (a) => a.fixture)].map(([fixture, rows]) => ({
    fixture,
    ...summarize(rows),
  }));
  const byKind = [...groupBy(attempts, (a) => a.kind)].map(([kind, rows]) => ({
    kind,
    ...summarize(rows),
  }));
  const failures = attempts.filter((a) => a.outcome === 'fail');
  const lat = (rows: Attempt[]): number[] =>
    rows.map((a) => a.latencyMs).filter((v): v is number => v !== null);
  const firstLat = lat(attempts.filter((a) => a.first));
  const laterLat = lat(attempts.filter((a) => !a.first));
  const captured = attempts.filter((a) => a.captured !== 'unavailable').length;
  const report = {
    threshold: DETECTION_RATE_THRESHOLD,
    overall,
    byMethod,
    byFixture,
    byKind,
    capture: {
      verified: captured,
      unavailable: attempts.filter((a) => a.outcome !== 'invalid' && a.captured === 'unavailable')
        .length,
    },
    coveringSelection: attempts
      .filter((a) => a.covers)
      .map((a) => `${a.fixture}/${a.target}/${a.method}`),
    latency: {
      firstOnPage: {
        n: firstLat.length,
        p50: percentile(firstLat, 50),
        p95: percentile(firstLat, 95),
        budgetMs: FIRST_TOOLBAR_BUDGET_MS,
      },
      later: {
        n: laterLat.length,
        p50: percentile(laterLat, 50),
        p95: percentile(laterLat, 95),
        budgetMs: LATER_TOOLBAR_BUDGET_MS,
      },
    },
    failures: failures.map((a) => ({
      fixture: a.fixture,
      target: a.target,
      method: a.method,
      reason: a.reason,
    })),
    attempts,
  };
  const file = await writeReport('detection.json', report);
  const markdown = [
    `Detection rate: ${pct(overall.rate)} (${overall.pass} pass, ${overall.fail} fail, ${overall.invalid} invalid of ${overall.total} attempts); threshold ${pct(DETECTION_RATE_THRESHOLD)}`,
    '',
    table(
      byMethod.map((r) => ({
        method: r.method,
        pass: r.pass,
        fail: r.fail,
        invalid: r.invalid,
        rate: pct(r.rate),
      })),
    ),
    '',
    table(
      byFixture.map((r) => ({
        fixture: r.fixture,
        pass: r.pass,
        fail: r.fail,
        invalid: r.invalid,
        rate: pct(r.rate),
      })),
    ),
    '',
    'Failures:',
    table(report.failures),
    '',
    `Full data: ${file}`,
  ].join('\n');
  await test.info().attach('detection-rate.md', { body: markdown, contentType: 'text/markdown' });
  console.log(markdown);

  const invalid = attempts.filter((a) => a.outcome === 'invalid');
  expect
    .soft(
      invalid.map((a) => `${a.fixture}/${a.target}/${a.method}: ${a.reason} (got "${a.selected}")`),
      'invalid attempts are fixture or input problems, not product results',
    )
    .toEqual([]);
  expect(
    overall.rate,
    `${pct(overall.rate)} detected; failures:\n${table(report.failures)}`,
  ).toBeGreaterThanOrEqual(DETECTION_RATE_THRESHOLD);
});
