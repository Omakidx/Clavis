import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { SavedMeaning, WordSource } from '@shared/api-contract/records';
import type { PushChange } from '@shared/api-contract/sync';
import { wordKey } from '../../../shared/api-contract/words';
import { API_ORIGIN, EXTENSION_ID, GOOGLE_ORIGIN } from './stack';

/** Direct API access for seeding and verification (the extension's Bearer flow; never the dashboard's cookie). */
export interface Bearer {
  email: string;
  token: string;
}

const b64url = (b: Buffer): string => b.toString('base64url');

/** Signs `email` in the way the extension does (fake Google code + PKCE, POST /v1/auth/extension/google). */
export async function bearerFor(email: string): Promise<Bearer> {
  // POST /v1/auth/extension/google is limited to 10/min/IP: wait out a 429 instead of failing the test.
  for (let attempt = 0; ; attempt++) {
    const result = await tryBearerFor(email);
    if ('bearer' in result) return result.bearer;
    if (result.status !== 429 || attempt >= 12) throw new Error(result.error);
    await new Promise((r) => setTimeout(r, Math.max(result.retryAfterMs, 500) + 250));
  }
}

async function tryBearerFor(
  email: string,
): Promise<{ bearer: Bearer } | { status: number; retryAfterMs: number; error: string }> {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const redirectUri = `https://${EXTENSION_ID}.chromiumapp.org/`;
  const nonce = b64url(randomBytes(12));
  const auth = new URL(`${GOOGLE_ORIGIN}/authorize`);
  for (const [k, v] of Object.entries({
    client_id: 'fake-client.apps.googleusercontent.com',
    redirect_uri: redirectUri,
    response_type: 'code',
    state: 'e2e',
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    login_hint: email,
  }))
    auth.searchParams.set(k, v);
  const hop = await fetch(auth, { redirect: 'manual' });
  const code = new URL(hop.headers.get('location') ?? '').searchParams.get('code');
  if (!code) throw new Error('fake Google returned no code');
  const res = await fetch(`${API_ORIGIN}/v1/auth/extension/google`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: `chrome-extension://${EXTENSION_ID}` },
    body: JSON.stringify({ code, codeVerifier: verifier, redirectUri, nonce }),
  });
  if (!res.ok) {
    const text = await res.text();
    const retry = Number(
      (JSON.parse(text) as { error?: { retryAfterMs?: number } }).error?.retryAfterMs,
    );
    return {
      status: res.status,
      retryAfterMs: Number.isFinite(retry) ? retry : 5000,
      error: `extension sign-in failed: ${res.status} ${text}`,
    };
  }
  const pair = (await res.json()) as { accessToken: string };
  return { bearer: { email, token: pair.accessToken } };
}

const auth = (b: Bearer): Record<string, string> => ({ authorization: `Bearer ${b.token}` });

export async function push(b: Bearer, changes: PushChange[]): Promise<void> {
  for (let i = 0; i < changes.length; i += 150) {
    const chunk = changes.slice(i, i + 150);
    const res = await fetch(`${API_ORIGIN}/v1/sync/push`, {
      method: 'POST',
      headers: { ...auth(b), 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      body: JSON.stringify({ changes: chunk }),
    });
    const body = (await res.json()) as { results?: { status: string; code?: string }[] };
    if (!res.ok || body.results?.some((r) => r.status !== 'applied'))
      throw new Error(`push failed: ${res.status} ${JSON.stringify(body)}`);
  }
}

/** A tiny but valid-looking PDF; `tag` makes the bytes (and so the fingerprint) unique. */
export function makePdf(tag: string): { bytes: Buffer; fingerprint: string } {
  const bytes = Buffer.from(
    `%PDF-1.4\n% ${tag}\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n`,
  );
  return { bytes, fingerprint: createHash('sha256').update(bytes).digest('hex') };
}

export async function uploadPdf(
  b: Bearer,
  pdf: { bytes: Buffer; fingerprint: string },
  title: string,
): Promise<Response> {
  return fetch(`${API_ORIGIN}/v1/documents/${pdf.fingerprint}/file`, {
    method: 'PUT',
    headers: {
      ...auth(b),
      'content-type': 'application/pdf',
      'x-clavis-title': encodeURIComponent(title),
    },
    body: new Uint8Array(pdf.bytes),
  });
}

/** True when PUT /v1/documents/:fp/file exists on the running server (the file endpoints land separately). */
export async function probeFileEndpoints(): Promise<boolean> {
  const b = await bearerFor(`probe-${randomBytes(4).toString('hex')}@example.test`);
  const pdf = makePdf('probe');
  const res = await uploadPdf(b, pdf, 'probe');
  if ([404, 405, 501].includes(res.status)) return false;
  if (!res.ok) throw new Error(`file endpoint probe failed: ${res.status} ${await res.text()}`);
  return true;
}

export async function getJson<T>(b: Bearer, path: string): Promise<{ status: number; body: T }> {
  const res = await fetch(`${API_ORIGIN}${path}`, { headers: auth(b) });
  return { status: res.status, body: (await res.json().catch(() => null)) as T };
}

// --- Seed builders ---

const T0 = Date.UTC(2026, 5, 1, 12, 0, 0);

export interface WordSeed {
  text: string;
  summary?: string;
  /** Offset in minutes: later = newer. */
  at?: number;
  source?: WordSource;
  contextBefore?: string;
  contextAfter?: string;
  meaning?: Partial<SavedMeaning>;
  chat?: { role: 'user' | 'assistant'; content: string }[];
}

export async function wordChanges(w: WordSeed): Promise<PushChange[]> {
  const key = await wordKey(w.text);
  const createdAt = T0 + (w.at ?? 0) * 60_000;
  const out: PushChange[] = [
    {
      kind: 'word',
      op: 'upsert',
      key,
      clientModifiedAt: createdAt,
      data: {
        text: w.text,
        language: 'en',
        meaning: {
          title: w.text,
          summary: w.summary ?? `Summary of ${w.text}`,
          model: 'e2e-model',
          ...w.meaning,
        },
        ...(w.contextBefore !== undefined ? { contextBefore: w.contextBefore } : {}),
        ...(w.contextAfter !== undefined ? { contextAfter: w.contextAfter } : {}),
        source: w.source ?? {
          kind: 'webpage',
          url: 'https://example.com/article',
          title: 'Example article',
        },
        createdAt,
      },
    },
  ];
  (w.chat ?? []).forEach((m, i) => {
    out.push({
      kind: 'chat',
      op: 'insert',
      id: randomUUID(),
      data: {
        wordKey: key,
        role: m.role,
        content: m.content,
        ...(m.role === 'assistant' ? { model: 'e2e-model' } : {}),
        createdAt: createdAt + (i + 1) * 1000,
      },
    });
  });
  return out;
}

export interface DocSeed {
  title: string | null;
  fingerprint: string;
  pageCount?: number | null;
  lastPage?: number | null;
  at?: number;
  highlights?: number;
}

export function docChanges(d: DocSeed): PushChange[] {
  const at = T0 + (d.at ?? 0) * 60_000;
  const out: PushChange[] = [
    {
      kind: 'document',
      op: 'upsert',
      key: d.fingerprint,
      clientModifiedAt: at,
      data: {
        title: d.title,
        pageCount: d.pageCount ?? null,
        lastPage: d.lastPage ?? null,
        pageOffset: d.lastPage ? 0.25 : null,
        fileBytes: null,
      },
    },
  ];
  for (let i = 0; i < (d.highlights ?? 0); i++) {
    out.push({
      kind: 'highlight',
      op: 'upsert',
      id: randomUUID(),
      clientModifiedAt: at,
      data: {
        fingerprint: d.fingerprint,
        page: 1,
        start: i * 10,
        end: i * 10 + 5,
        color: 'yellow',
        createdAt: at,
      },
    });
  }
  return out;
}

let counter = 0;
/** A unique, never-reused identity per call (one database per run; unique per test). */
export const uniqueEmail = (label: string): string =>
  `dash-${label}-${Date.now().toString(36)}-${(counter++).toString(36)}-${randomBytes(2).toString('hex')}@example.test`;
