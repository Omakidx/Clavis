import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Design 2.4 rule R1: only lib/account/** references the two token storage keys, and no page-facing
// code can carry a token. A structural guard like tests/unit/p9/logging-static-scan.test.ts.

const ROOT = path.resolve(__dirname, '../../..');
const files = ['entrypoints', 'components', 'lib'].flatMap((dir) =>
  readdirSync(path.join(ROOT, dir), { recursive: true, encoding: 'utf8' })
    .filter((f) => /\.(ts|tsx)$/.test(f))
    .map((f) => path.join(dir, f).split(path.sep).join('/')),
);
const text = (file: string): string => readFileSync(path.join(ROOT, file), 'utf8');

describe('token boundary (R1)', () => {
  it('only lib/account/** and the key table reference accountSession / accountAccess', () => {
    const users = files.filter((f) =>
      /STORAGE_KEYS\.account(?:Session|Access)|clavis\.account-(?:session|access)/.test(text(f)),
    );
    expect(
      users.filter((f) => !f.startsWith('lib/account/') && f !== 'lib/storage/keys.ts'),
    ).toEqual([]);
    expect(users.length).toBeGreaterThan(0);
  });

  it('IndexedDB code, message contracts, route handlers and pages never mention tokens', () => {
    const guarded = files.filter(
      (f) =>
        f.startsWith('lib/data/') ||
        f.startsWith('lib/contracts/') ||
        f.startsWith('lib/router/') ||
        f.startsWith('lib/ui-client/') ||
        f.startsWith('components/') ||
        f.startsWith('entrypoints/'),
    );
    for (const file of guarded) {
      const source = text(file)
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join('\n');
      expect(source, file).not.toMatch(/accessToken|refreshToken|crt_/);
    }
  });

  it('the API client is not imported by pages: only the background composition and lib/account use it', () => {
    const importers = files.filter((f) => /from '[^']*account\/api'/.test(text(f)));
    for (const file of importers) {
      expect(
        file.startsWith('lib/account/') ||
          file.startsWith('lib/sync/') ||
          file === 'lib/router/register.ts' ||
          // Only the ApiRequestError class, to map the server's codes to replies; no client, no token.
          file === 'lib/router/handlers/documents.ts',
        file,
      ).toBe(true);
    }
  });
});
