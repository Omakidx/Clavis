import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { MiddlewareHandler } from 'hono';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** Paths owned by the API. The SPA fallback and static files must never answer them. */
export const API_PREFIXES = ['/v1', '/auth', '/healthz', '/readyz'] as const;
export function isApiPath(p: string): boolean {
  return API_PREFIXES.some((prefix) => p === prefix || p.startsWith(`${prefix}/`));
}

// Design §8: dashboard security headers. HSTS is added only when the origin is https.
function securityHeaders(https: boolean): Record<string, string> {
  return {
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    ...(https ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
  };
}

async function readFileIfFile(file: string): Promise<Buffer | null> {
  try {
    const s = await stat(file);
    return s.isFile() ? await readFile(file) : null;
  } catch {
    return null;
  }
}

/**
 * Serves the built dashboard from `root` with an SPA fallback to index.html. GET/HEAD only.
 * API paths fall through (to the JSON 404), and a missing file with an extension is a 404, not index.html.
 */
export function dashboardStatic(root: string, https: boolean): MiddlewareHandler {
  const absRoot = path.resolve(root);
  const headers = securityHeaders(https);
  return async (c, next) => {
    const method = c.req.method;
    const reqPath = c.req.path;
    if ((method !== 'GET' && method !== 'HEAD') || isApiPath(reqPath)) return next();

    let decoded: string;
    try {
      decoded = decodeURIComponent(reqPath);
    } catch {
      return next();
    }
    if (decoded.includes('\0')) return next();

    // /privacy is a static page generated at build time (dashboard/build/privacy-page.ts), not an SPA route.
    const isPrivacy = decoded === '/privacy' || decoded === '/privacy/';
    const rel =
      decoded === '/'
        ? 'index.html'
        : isPrivacy
          ? 'privacy/index.html'
          : decoded.replace(/^\/+/, '');
    const candidate = path.resolve(absRoot, rel);
    if (candidate !== absRoot && !candidate.startsWith(absRoot + path.sep)) return next();

    let file = candidate;
    let body = await readFileIfFile(file);
    // A missing privacy page is a 404, never the SPA shell.
    if (!body && !isPrivacy && path.extname(rel) === '') {
      file = path.join(absRoot, 'index.html');
      body = await readFileIfFile(file);
    }
    if (!body) return next();

    const ext = path.extname(file).toLowerCase();
    const isIndex = path.basename(file) === 'index.html';
    const res = new Response(method === 'HEAD' ? null : new Uint8Array(body), {
      headers: {
        ...headers,
        'Content-Type': TYPES[ext] ?? 'application/octet-stream',
        'Content-Length': String(body.length),
        // Vite emits content-hashed names under /assets; everything else (index.html) must revalidate.
        'Cache-Control': isPrivacy
          ? 'public, max-age=300'
          : !isIndex && reqPath.startsWith('/assets/')
            ? 'public, max-age=31536000, immutable'
            : 'no-cache',
      },
    });
    return res;
  };
}
