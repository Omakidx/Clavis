import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserContext, Page } from '@playwright/test';
import {
  launchExtension,
  waitForRegistration,
  type ExtensionOptions,
  type LaunchedExtension,
} from '../spike-b-support/extension';
import type { Fixture } from './manifest';
import { frameByPath, installProbe, observerGate, type ObserverGate, type Surface } from './page';
import { startMatrixServer, type MatrixServer } from './server';

export interface Harness {
  ext: LaunchedExtension;
  server: MatrixServer;
  /** Every request to api.groq.com seen anywhere in the browser (pages, frames, service worker). */
  groqRequests: string[];
  /** Every request URL seen by the browser context (all pages, frames and workers). */
  allRequests: string[];
  close(): Promise<void>;
}

export interface HarnessOptions extends ExtensionOptions {
  /** Wait for the observer registration (only with granted site access). */
  waitRegistration?: boolean;
}

/** A browser with the built extension, a matrix fixture server, the timing probe and request tracking. */
export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const { waitRegistration, ...extensionOptions } = options;
  const server = await startMatrixServer();
  const ext = await launchExtension({ grantedSiteAccess: true, ...extensionOptions });
  if (waitRegistration !== false && extensionOptions.grantedSiteAccess !== false) {
    await waitForRegistration(ext.serviceWorker);
  }
  await installProbe(ext.context);
  const groqRequests: string[] = [];
  const allRequests: string[] = [];
  ext.context.on('request', (request) => {
    allRequests.push(request.url());
    if (request.url().includes('api.groq.com')) groqRequests.push(request.url());
  });
  return {
    ext,
    server,
    groqRequests,
    allRequests,
    async close() {
      await ext.close();
      await server.close();
    },
  };
}

export interface OpenedFixture {
  page: Page;
  /** Main page, and one entry per named frame of the fixture. */
  surface(name?: string): Surface;
  surfaces(): Surface[];
  gate: ObserverGate;
  close(): Promise<void>;
}

export interface OpenOptions {
  viewport?: { width: number; height: number };
  /** Skip waiting for the observer (pages where none is expected). */
  noObserver?: boolean;
}

export async function openPath(
  context: BrowserContext,
  server: MatrixServer,
  file: string,
  fixture?: Fixture,
  options: OpenOptions = {},
): Promise<OpenedFixture> {
  const page = await context.newPage();
  const viewport = options.viewport ?? fixture?.viewport;
  if (viewport !== undefined) await page.setViewportSize(viewport);
  const gate = await observerGate(page);
  await page.goto(`${server.origin}/${file}`);
  if (options.noObserver !== true) await gate.waitReady();
  if (fixture?.ready !== undefined)
    await page.waitForSelector(fixture.ready, { state: 'attached' });
  const frames = fixture?.frames ?? {};
  return {
    page,
    gate,
    surface(name) {
      return name === undefined ? page : frameByPath(page, frames[name] ?? '/__missing__');
    },
    surfaces() {
      return [page, ...Object.values(frames).map((p) => frameByPath(page, p))];
    },
    async close() {
      await gate.dispose();
      await page.close().catch(() => undefined);
    },
  };
}

export const openFixture = (
  context: BrowserContext,
  server: MatrixServer,
  fixture: Fixture,
  options: OpenOptions = {},
): Promise<OpenedFixture> => openPath(context, server, fixture.file, fixture, options);

const reportDir = path.resolve(
  fileURLToPath(new URL('../../../', import.meta.url)),
  'test-results/p4-matrix-reports',
);

/** Persist a result so the acceptance report can quote it (outside Playwright's cleaned output dir). */
export async function writeReport(name: string, data: unknown): Promise<string> {
  await mkdir(reportDir, { recursive: true });
  const file = path.join(reportDir, name);
  await writeFile(file, JSON.stringify(data, null, 2));
  return file;
}
