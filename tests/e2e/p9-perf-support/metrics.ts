import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BrowserContext, CDPSession, Page, TestInfo } from '@playwright/test';

/**
 * Measurement helpers shared by the Phase 9 performance specs (tests/e2e/p9-perf-*.spec.ts).
 * Everything here is observation through the DevTools protocol; nothing is added to the extension.
 */

export const MB = 1048576;

export interface MachineLoad {
  cpus: number;
  /** os.loadavg() (1, 5 and 15 minutes). Always 0 on Windows. */
  loadavg: number[];
  freeMemMB: number;
}

export function machineLoad(): MachineLoad {
  return {
    cpus: os.cpus().length,
    loadavg: os.loadavg().map((v) => Math.round(v * 100) / 100),
    freeMemMB: Math.round(os.freemem() / MB),
  };
}

/** A CDP session with the Performance and HeapProfiler domains on, for one page. */
export class HeapProbe {
  private constructor(private readonly cdp: CDPSession) {}

  static async attach(context: BrowserContext, page: Page): Promise<HeapProbe> {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');
    await cdp.send('HeapProfiler.enable');
    return new HeapProbe(cdp);
  }

  /** Force a full collection (twice: finalizers can free a second wave). */
  async collect(): Promise<void> {
    await this.cdp.send('HeapProfiler.collectGarbage');
    await this.cdp.send('HeapProfiler.collectGarbage');
  }

  /** JS heap in use by the page's main-thread isolate (all worlds, so content scripts count), MB. */
  async heapMB({ gc }: { gc: boolean }): Promise<number> {
    if (gc) await this.collect();
    const { metrics } = await this.cdp.send('Performance.getMetrics');
    return (metrics.find((m) => m.name === 'JSHeapUsedSize')?.value ?? 0) / MB;
  }

  /** Live DOM nodes, documents and event listeners of the page (Blink counters). */
  async dom(): Promise<{ nodes: number; documents: number; listeners: number }> {
    const counters = await this.cdp.send('Memory.getDOMCounters');
    return {
      nodes: counters.nodes,
      documents: counters.documents,
      listeners: counters.jsEventListeners,
    };
  }

  async detach(): Promise<void> {
    await this.cdp.detach().catch(() => undefined);
  }
}

export const round = (value: number, digits = 1): number => {
  const k = 10 ** digits;
  return Math.round(value * k) / k;
};

export const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? NaN)
    : ((sorted[mid - 1] ?? NaN) + (sorted[mid] ?? NaN)) / 2;
};

/**
 * Write a result file into the run's own Playwright output directory (so a run started with
 * `--output <dir>` never touches anyone else's test-results) and echo it to the log.
 */
export function writeResult(testInfo: TestInfo, name: string, data: unknown): void {
  const dir = testInfo.project.outputDir;
  mkdirSync(dir, { recursive: true });
  const text = JSON.stringify(
    { machine: machineLoad(), node: process.version, ...(data as object) },
    null,
    2,
  );
  writeFileSync(path.join(dir, `${name}.json`), text);
  console.log(`[p9-perf] ${name}\n${text}`);
}
