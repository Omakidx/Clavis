import { expect, test } from './fixtures';

// Spike A (docs/execution-phases.md Phase 2): prove the packaged MV3 service worker can reach
// api.groq.com (host permission, no CORS failure) with a deliberately FAKE key.
// No real secret is involved: Groq rejects the key with 401.
//
// OFFLINE BY DEFAULT: the default suite never contacts api.groq.com. The two live tests (a worker
// fetch with the fake key to the real endpoint) only run when explicitly opted in:
//
//   CLAVIS_E2E_LIVE_GROQ=1 npx playwright test tests/e2e/spike-a-groq.spec.ts
//
// They also need outbound network access, and skip with a reason when it is missing. The manifest
// test needs no network and always runs.

const MODELS_URL = 'https://api.groq.com/openai/v1/models';
const CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';
const FAKE_KEY = 'gsk_TEST_invalid_key_for_cors_check';

type Probe =
  | { outcome: 'response'; status: number; body: string }
  | { outcome: 'error'; name: string; message: string };

/** Runs inside an execution context (worker or page); must stay self-contained. */
async function probeFetch(args: { url: string; key: string; post: boolean }): Promise<Probe> {
  try {
    const response = await fetch(args.url, {
      method: args.post ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${args.key}`,
        ...(args.post ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(args.post
        ? {
            body: JSON.stringify({
              model: 'openai/gpt-oss-20b',
              messages: [{ role: 'user', content: 'ping' }],
              max_completion_tokens: 1,
            }),
          }
        : {}),
    });
    return {
      outcome: 'response',
      status: response.status,
      body: (await response.text()).slice(0, 300),
    };
  } catch (error) {
    const e = error as Error;
    return { outcome: 'error', name: e.name, message: e.message };
  }
}

const LIVE = process.env['CLAVIS_E2E_LIVE_GROQ'] === '1';

test('manifest grants the narrow Groq host permission and nothing broader at install', async ({
  serviceWorker,
}) => {
  const manifest = await serviceWorker.evaluate(() => {
    const m = chrome.runtime.getManifest();
    return { host: m.host_permissions ?? [], optional: m.optional_host_permissions ?? [] };
  });
  expect(manifest.host).toEqual(['https://api.groq.com/*']);
  expect(manifest.optional).toEqual(['http://*/*', 'https://*/*']);
});

test.describe('Spike A (live): Groq reachability from the packaged extension', () => {
  test.skip(!LIVE, 'opt-in: set CLAVIS_E2E_LIVE_GROQ=1 (contacts the real api.groq.com)');

  test.beforeAll(async () => {
    try {
      await fetch(MODELS_URL, { method: 'HEAD', signal: AbortSignal.timeout(8_000) });
    } catch {
      test.skip(true, 'No outbound network access to api.groq.com; cannot verify reachability.');
    }
  });

  test('service worker fetch to the models endpoint returns 401 for a fake key (not CORS-blocked)', async ({
    serviceWorker,
  }) => {
    const probe = await serviceWorker.evaluate(probeFetch, {
      url: MODELS_URL,
      key: FAKE_KEY,
      post: false,
    });
    expect(probe).toMatchObject({ outcome: 'response' });
    if (probe.outcome === 'response') {
      expect([401, 403]).toContain(probe.status);
      expect(probe.body).not.toContain(FAKE_KEY);
    }
  });

  test('service worker POST to chat/completions with a JSON body also reaches Groq (401)', async ({
    serviceWorker,
  }) => {
    // A JSON POST with Authorization triggers a CORS preflight in a normal page; the host
    // permission must make that unnecessary for the worker.
    const probe = await serviceWorker.evaluate(probeFetch, {
      url: CHAT_URL,
      key: FAKE_KEY,
      post: true,
    });
    expect(probe).toMatchObject({ outcome: 'response' });
    if (probe.outcome === 'response') expect([401, 403]).toContain(probe.status);
  });

  // Deliberately absent: a "web page is blocked by CORS" contrast test. It was tried and is not
  // observable: api.groq.com answers the preflight with `access-control-allow-origin: *` and allows
  // the authorization and content-type headers, so an ordinary https page can also read the 401.
  // The host permission therefore is not what makes the call possible today; it keeps the worker's
  // fetch independent of Groq's CORS policy (which can change) and stays the minimal, auditable
  // grant. See docs/decisions/spike-a-groq.md.
});
