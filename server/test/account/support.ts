import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import yauzl from 'yauzl';
import { ORIGIN, bearer, webLogin, type WebLogin } from '../auth/harness';
import { Api, chatIns, docUp, hlUp, makeWord, rows, type World } from '../sync/helpers';
import { makePdf } from '../storage/support';
import type { DbHandle } from '../../src/db/client';

/** Test-only unzip: entry name -> bytes (yauzl validates CRCs and sizes). */
export function unzip(buf: Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zf) => {
      if (err) return reject(err);
      const out = new Map<string, Buffer>();
      zf.on('error', reject);
      zf.on('end', () => resolve(out));
      zf.on('entry', (e: yauzl.Entry) => {
        zf.openReadStream(e, (err2, rs) => {
          if (err2) return reject(err2);
          const parts: Buffer[] = [];
          rs.on('data', (c: Buffer) => parts.push(c));
          rs.on('error', reject);
          rs.on('end', () => {
            out.set(e.fileName, Buffer.concat(parts));
            zf.readEntry();
          });
        });
      });
      zf.readEntry();
    });
  });
}

export const putPdf = (a: Api, fp: string, bytes: Buffer, title: string) =>
  a.h.app.request(`/v1/documents/${fp}/file`, {
    method: 'PUT',
    headers: {
      ...bearer(a.pair),
      'content-type': 'application/pdf',
      'content-length': String(bytes.length),
      'x-clavis-title': encodeURIComponent(title),
    },
    body: new Uint8Array(bytes),
  });

/** Ordinary Google login for `a`'s account (authenticated_at stays epoch 0). */
export const plainLogin = (w: World, a: Api) =>
  webLogin(w.h, { sub: a.sub, email: a.pair.user.email });

/** Plain login followed by a forced re-auth login: the session may delete the account. */
export async function freshLogin(w: World, a: Api): Promise<WebLogin> {
  const plain = await plainLogin(w, a);
  const fresh = await webLogin(
    w.h,
    { sub: a.sub, email: a.pair.user.email },
    { reauth: true, cookie: plain.cookie },
  );
  if (!fresh.session) throw new Error('re-auth login failed');
  return fresh;
}

export interface Seeded {
  a: Api;
  web: WebLogin;
  tag: string;
  /** Live words: text -> key. */
  words: Map<string, string>;
  /** Documents with a stored PDF. */
  stored: { fp: string; bytes: Buffer; title: string }[];
  /** Live document without a file. */
  plainFp: string;
  tombWord: string;
  tombDocFp: string;
}

const CMA = Date.parse('2026-03-01T00:00:00Z');

/** A signed-in user (Bearer and cookie) with every kind of row: words, chat, documents, highlights, PDFs, a pending upload. */
export async function seedUser(w: World, tag: string, pdfs = 2): Promise<Seeded> {
  const a = await w.user();
  const web = await freshLogin(w, a);
  const words = new Map<string, string>();
  const texts = [`${tag}-alpha`, `${tag}-beta`, `${tag}-gamma`];
  const wordChanges = await Promise.all(texts.map((t, i) => makeWord(t, CMA + i)));
  const tombWord = `${tag}-tomb`;
  const tombChange = await makeWord(tombWord, CMA + 10);
  await a.pushOk([...wordChanges, tombChange]);
  for (const c of wordChanges) words.set(c.data.text, c.key);
  const first = words.get(texts[0] as string) as string;
  await a.pushOk([
    chatIns(randomUUID(), first, CMA + 100, { content: `${tag} chat one` }),
    chatIns(randomUUID(), first, CMA + 101, {
      role: 'assistant',
      content: `${tag} chat two`,
      model: 'test-model',
    }),
    chatIns(randomUUID(), first, CMA + 102, { content: `${tag} chat three` }),
    chatIns(randomUUID(), tombChange.key, CMA + 103, { content: `${tag} dies with its word` }),
  ]);
  await a.pushOk([
    { kind: 'word', op: 'delete', key: tombChange.key, clientModifiedAt: CMA + 5000 },
  ]);

  const stored: Seeded['stored'] = [];
  for (let i = 0; i < pdfs; i++) {
    const pdf = makePdf(20_000 + i * 7000, `${tag}-${i}`);
    const title = `${tag} stored doc ${i}`;
    await a.pushOk([docUp(pdf.fp, CMA + 200 + i, { title, fileBytes: pdf.bytes.length })]);
    const res = await putPdf(a, pdf.fp, pdf.bytes, title);
    if (res.status !== 200) throw new Error(`seed upload failed: ${res.status}`);
    stored.push({ fp: pdf.fp, bytes: pdf.bytes, title });
  }
  const plainFp = makePdf(3000, `${tag}-plain`).fp;
  const tombDocFp = makePdf(3000, `${tag}-tombdoc`).fp;
  const hl1 = randomUUID();
  const hlTomb = randomUUID();
  await a.pushOk([
    docUp(plainFp, CMA + 300, { title: `${tag} plain doc` }),
    docUp(tombDocFp, CMA + 301, { title: `${tag} doomed doc` }),
  ]);
  await a.pushOk([
    ...(stored[0]
      ? [
          hlUp(hl1, stored[0].fp, CMA + 400),
          hlUp(hlTomb, stored[0].fp, CMA + 401, { start: 9, end: 20 }),
        ]
      : []),
    hlUp(randomUUID(), plainFp, CMA + 402),
  ]);
  if (stored[0]) {
    await a.pushOk([
      {
        kind: 'highlight',
        op: 'delete',
        id: hlTomb,
        fingerprint: stored[0].fp,
        clientModifiedAt: CMA + 9000,
      },
    ]);
  }
  await a.pushOk([
    { kind: 'document', op: 'delete', key: tombDocFp, clientModifiedAt: CMA + 9001 },
  ]);

  // A pending quota reservation row (the upload-in-progress table).
  await w.db.db.execute(sql`
    INSERT INTO uploads (user_id, fingerprint, reserved_bytes, object_key, status, expires_at)
    VALUES (${a.userId}, ${makePdf(2000, `${tag}-pend`).fp}, 2000, ${`u/${a.userId}/${randomUUID()}.pdf`},
            'pending', now() + interval '10 minutes')`);
  return { a, web, tag, words, stored, plainFp, tombWord, tombDocFp };
}

/** Every public table that carries a user_id, plus `users` itself (keyed by id). Future tables are caught. */
export async function userTables(db: DbHandle): Promise<{ table: string; col: string }[]> {
  const r = await rows<{ table_name: string }>(
    db,
    sql`SELECT DISTINCT table_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'user_id' ORDER BY table_name`,
  );
  return [
    { table: 'users', col: 'id' },
    ...r.map((x) => ({ table: x.table_name, col: 'user_id' })),
  ];
}

export async function rowCounts(db: DbHandle, userId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const { table, col } of await userTables(db)) {
    const r = await rows<{ n: number }>(
      db,
      sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE ${sql.identifier(col)} = ${userId}`,
    );
    out[table] = r[0]?.n ?? 0;
  }
  return out;
}

export const authHeaders = (s: WebLogin, extra: Record<string, string> = {}) => ({
  cookie: s.cookie,
  origin: ORIGIN,
  'x-csrf-token': s.csrf,
  ...extra,
});

export const deleteAccountReq = (
  w: World,
  s: WebLogin,
  body: unknown = { confirm: 'DELETE' },
  headers: Record<string, string> = {},
) =>
  w.h.app.request('/v1/account', {
    method: 'DELETE',
    headers: authHeaders(s, { 'content-type': 'application/json', ...headers }),
    body: JSON.stringify(body),
  });

export const exportReq = (w: World, s: WebLogin) =>
  w.h.app.request('/v1/account/export', { headers: { cookie: s.cookie } });
