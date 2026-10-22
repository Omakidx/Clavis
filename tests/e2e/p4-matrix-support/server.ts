import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const matrixDir = fileURLToPath(new URL('../../fixtures/web/matrix/', import.meta.url));

export interface MatrixServer {
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
  '.json': 'application/json; charset=utf-8',
};

/**
 * Static server for tests/fixtures/web/matrix, bound to 127.0.0.1 only (content scripts do
 * not run on file://). Flat namespace: only the basename of the request path is used, and
 * only .html and .json files are served. Nothing else on disk is reachable.
 */
export async function startMatrixServer(): Promise<MatrixServer> {
  const requests: string[] = [];
  let port = 0;
  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      requests.push(url.pathname);
      const name = path.basename(url.pathname);
      const type = TYPES[path.extname(name)];
      if (name === '' || name.includes('..') || type === undefined) {
        res.writeHead(404).end('not found');
        return;
      }
      try {
        const body = (await readFile(path.join(matrixDir, name), 'utf8')).replaceAll(
          '__CROSS_ORIGIN__',
          `http://localhost:${port}`,
        );
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }).end(body);
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
