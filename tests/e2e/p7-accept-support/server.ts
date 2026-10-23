import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { acceptDir } from './manifest';

export interface PdfServer {
  origin: string;
  /** Paths requested, in order. */
  requests: string[];
  close(): Promise<void>;
}

/**
 * Serves the acceptance fixtures over http://127.0.0.1 as `application/pdf` (a page that links
 * to a .pdf, and the PDFs themselves), to prove that navigating to a PDF URL is NOT intercepted
 * by the extension (FR-056).
 */
export async function startPdfServer(): Promise<PdfServer> {
  const requests: string[] = [];
  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      requests.push(url.pathname);
      if (url.pathname === '/index.html') {
        res
          .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          .end(
            '<!doctype html><title>PDF links</title><a id="pdf" href="/basic-1page.pdf">a PDF</a>',
          );
        return;
      }
      const name = path.basename(url.pathname);
      if (!name.endsWith('.pdf') || name.includes('..')) {
        res.writeHead(404).end('not found');
        return;
      }
      try {
        const body = await readFile(path.join(acceptDir, name));
        res
          .writeHead(200, { 'content-type': 'application/pdf', 'cache-control': 'no-store' })
          .end(body);
      } catch {
        res.writeHead(404).end('not found');
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
