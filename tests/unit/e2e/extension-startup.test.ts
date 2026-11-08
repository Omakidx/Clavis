import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Worker } from '@playwright/test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { launchExtension, waitForRegistration } from '../../e2e/spike-b-support/extension';

const { launch, makeTemp } = vi.hoisted(() => ({ launch: vi.fn(), makeTemp: vi.fn() }));
vi.mock('@playwright/test', () => ({ chromium: { launchPersistentContext: launch } }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  makeTemp.mockImplementation(fs.mkdtemp);
  return { ...fs, mkdtemp: makeTemp };
});

let buildDir: string;
beforeEach(async () => {
  launch.mockReset();
  makeTemp.mockClear();
  buildDir = await mkdtemp(path.join(os.tmpdir(), 'clavis-startup-test-'));
  await writeFile(path.join(buildDir, 'manifest.json'), '{}');
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(buildDir, { recursive: true, force: true });
});

async function expectProfileRemoved() {
  const [profile, options] = launch.mock.calls[0]! as [string, { timeout: number; args: string[] }];
  expect(options.timeout).toBeGreaterThan(0);
  expect(options.timeout).toBeLessThanOrEqual(40_000);
  const copy = options.args.find((arg) => arg.startsWith('--load-extension='))!.split('=')[1]!;
  await expect(access(profile)).rejects.toThrow();
  await expect(access(path.dirname(copy))).rejects.toThrow();
}

it('removes temporary files when Chromium fails before returning a context', async () => {
  launch.mockRejectedValue(new Error('browser launch timed out'));
  await expect(launchExtension({ buildDir })).rejects.toThrow('browser launch timed out');
  await expectProfileRemoved();
});

it('removes the temporary copy if its manifest cannot be prepared', async () => {
  await writeFile(path.join(buildDir, 'manifest.json'), 'invalid JSON');
  await expect(launchExtension({ buildDir })).rejects.toThrow();
  expect(launch).not.toHaveBeenCalled();
  const copiedRoot = await makeTemp.mock.results[1]!.value;
  await expect(access(copiedRoot)).rejects.toThrow();
});

it('closes Chromium and removes temporary files when installation fails', async () => {
  const close = vi.fn().mockResolvedValue(undefined);
  const waitForEvent = vi.fn().mockRejectedValue(new Error('installation timed out'));
  launch.mockResolvedValue({ serviceWorkers: () => [], waitForEvent, close });
  await expect(launchExtension({ buildDir })).rejects.toThrow('installation timed out');
  expect(close).toHaveBeenCalledOnce();
  expect(waitForEvent.mock.calls[0]?.[1].timeout).toBeLessThanOrEqual(30_000);
  await expectProfileRemoved();
});

it('also cleans up after a successful session', async () => {
  const close = vi.fn().mockResolvedValue(undefined);
  launch.mockResolvedValue({
    serviceWorkers: () => [{ url: () => 'chrome-extension://test-id/background.js' }],
    close,
  });
  const extension = await launchExtension({ buildDir });
  expect(extension.extensionId).toBe('test-id');
  await extension.close();
  expect(close).toHaveBeenCalledOnce();
  await expectProfileRemoved();
});

it('removes temporary files even if closing Chromium rejects', async () => {
  launch.mockResolvedValue({
    serviceWorkers: () => [{ url: () => 'chrome-extension://test-id/background.js' }],
    close: vi.fn().mockRejectedValue(new Error('close failed')),
  });
  const extension = await launchExtension({ buildDir });
  await expect(extension.close()).rejects.toThrow('close failed');
  await expectProfileRemoved();
});

it('enforces the registration deadline even if the worker evaluation never resolves', async () => {
  vi.useFakeTimers();
  const worker = { evaluate: () => new Promise(() => undefined) } as unknown as Worker;
  const registration = waitForRegistration(worker);
  const assertion = expect(registration).rejects.toThrow('observer registration timed out');
  await vi.advanceTimersByTimeAsync(10_000);
  await assertion;
  expect(vi.getTimerCount()).toBe(0);
});
