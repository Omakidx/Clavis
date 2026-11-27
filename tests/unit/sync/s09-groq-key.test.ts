import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { toChange, toPushRequest } from '../../../lib/sync/payload';
import { FakeServer } from './fake-server';
import { FP, createClient, createClock } from './client';

// S-09 (docs/decisions/clavis-sync-decisions.md): the Groq key is never synced or sent to the
// Clavis server. The serialized push is built only from the shared strict schemas.

const KEY = 'gsk_TESTs09abcdefghijklmnopqrstuvwxyz0123456789';
const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('S-09: the Groq key never reaches the Clavis API', () => {
  it('no request body, header or URL contains the stored key, whatever is synced', async () => {
    const clock = createClock();
    const server = new FakeServer({ now: clock.now });
    const client = createClient(server, { clock });
    // The key sits in the same extension storage the engine's state lives in.
    client.local.data.set('clavis.api-key', { v: 1, data: { apiKey: KEY } });
    client.session.data.set('clavis.api-key', { v: 1, data: { apiKey: KEY } });

    await client.signIn();
    const word = await client.saveWord('bank');
    await client.chat(word, UUID(1));
    await client.progress(FP, 3);
    await client.highlight(FP, UUID(2));
    await client.sync();
    await client.service.signOut(false);

    expect(server.requests.length).toBeGreaterThan(5);
    for (const request of server.requests) {
      expect(request.body ?? '').not.toContain(KEY);
      expect(request.body ?? '').not.toContain('gsk_');
      expect(JSON.stringify(request.headers)).not.toContain(KEY);
      expect(request.path + request.query.toString()).not.toContain(KEY);
    }
    expect([...server.requests].some((r) => r.path === '/v1/sync/push')).toBe(true);
  });

  it('a local-only field on a record can never be serialized: the payload is rebuilt field by field', async () => {
    const record = {
      wordKey: 'a'.repeat(64),
      text: 'bank',
      meaning: { title: 'bank', summary: 's', model: 'm' },
      source: { kind: 'webpage' as const, url: null, title: null },
      createdAt: 1_700_000_000_000,
      clientModifiedAt: 1_700_000_000_000,
      seq: null,
      dirty: 1 as const,
      rev: 1,
      deleted: 0 as const,
      apiKey: KEY,
      groqKey: KEY,
    };
    const change = toChange({ kind: 'word', key: record.wordKey, rev: 1, record });
    expect(change).not.toBeNull();
    const body = JSON.stringify(toPushRequest([change!]));
    expect(body).not.toContain(KEY);
    expect(body).not.toContain('apiKey');
    expect(body).not.toContain('groqKey');
    // And the shared schema itself refuses a smuggled field.
    expect(() => toPushRequest([{ ...change!, apiKey: KEY } as never])).toThrow();
  });

  it('sync and account code never import the key store', () => {
    const root = path.resolve(__dirname, '../../../lib');
    const files = ['sync', 'account'].flatMap((dir) =>
      readdirSync(path.join(root, dir), { recursive: true, encoding: 'utf8' })
        .filter((f) => f.endsWith('.ts') && statSync(path.join(root, dir, f)).isFile())
        .map((f) => path.join(root, dir, f)),
    );
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(
        /storage\/api-key|createApiKeyStore|STORAGE_KEYS\.apiKey|keyMeta/,
      );
    }
  });
});
