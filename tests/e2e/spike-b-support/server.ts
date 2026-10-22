import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fixturesDir = fileURLToPath(new URL('../../fixtures/web/', import.meta.url));

export interface FixtureServer {
  /** Same-origin base, e.g. http://127.0.0.1:41234 */
  origin: string;
  /** A different origin served by the same server (localhost vs 127.0.0.1). */
  crossOrigin: string;
  /** Every path requested, in order. */
  requests: string[];
  close(): Promise<void>;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

/**
 * Tiny static server for tests/fixtures/web, bound to 127.0.0.1 only. Content
 * scripts only run on http(s), so fixtures cannot be loaded from file://.
 * `__CROSS_ORIGIN__` in a fixture is replaced with the localhost origin so one
 * page can embed a cross-origin iframe.
 */
export async function startFixtureServer(): Promise<FixtureServer> {
  const requests: string[] = [];
  let port = 0;
  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      requests.push(url.pathname);
      const name = path.basename(url.pathname);
      if (name === '' || name.includes('..') || path.extname(name) === '') {
        res.writeHead(404).end('not found');
        return;
      }
      try {
        const body = (await readFile(path.join(fixturesDir, name), 'utf8')).replaceAll(
          '__CROSS_ORIGIN__',
          `http://localhost:${port}`,
        );
        res
          .writeHead(200, {
            'content-type': TYPES[path.extname(name)] ?? 'application/octet-stream',
            'cache-control': 'no-store',
          })
          .end(body);
      } catch {
        res.writeHead(404).end('not found');
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    crossOrigin: `http://localhost:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
