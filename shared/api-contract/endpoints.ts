import { z } from 'zod';
import { LIMITS } from './limits';
import { PageCursor, EpochMs, Hex64, Text, pageQuery } from './primitives';
import {
  DocumentStorage,
  documentDataBase,
  highlightDataBase,
  wordDataBase,
  WordSource,
} from './records';
import { PullQuery, PullResponse, PushRequest, PushResponse } from './sync';

// §5.4 REST types.

export const User = z.strictObject({
  id: z.uuid(),
  email: z.string().max(320),
  displayName: z.string().max(200).nullable(),
  createdAt: EpochMs,
});
export type User = z.infer<typeof User>;

export const TokenPair = z.strictObject({
  accessToken: z.string().min(1).max(4096),
  accessTokenExpiresAt: EpochMs,
  refreshToken: z.string().min(1).max(256),
  refreshTokenExpiresAt: EpochMs,
  user: User,
});
export type TokenPair = z.infer<typeof TokenPair>;

export const WordSummary = z.strictObject({
  key: Hex64,
  text: z.string(),
  title: z.string(),
  summary: z.string(),
  source: WordSource,
  createdAt: EpochMs,
  messageCount: z.number().int().nonnegative(),
});
export type WordSummary = z.infer<typeof WordSummary>;

export const WordView = z.strictObject({
  ...wordDataBase.shape,
  key: Hex64,
  clientModifiedAt: EpochMs,
});
export type WordView = z.infer<typeof WordView>;

export const ChatView = z.strictObject({
  id: z.uuid(),
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  model: z.string().nullable(),
  createdAt: EpochMs,
});
export type ChatView = z.infer<typeof ChatView>;

export const DocumentView = z.strictObject({
  ...documentDataBase.shape,
  fingerprint: Hex64,
  clientModifiedAt: EpochMs,
  highlightCount: z.number().int().nonnegative(),
  storage: z.strictObject({
    state: DocumentStorage.shape.state,
    bytes: z.number().int().nullable(),
    storedAt: EpochMs.nullable(),
  }),
});
export type DocumentView = z.infer<typeof DocumentView>;

export const HighlightView = z.strictObject({ ...highlightDataBase.shape, id: z.uuid() });
export type HighlightView = z.infer<typeof HighlightView>;

const page = <T extends z.ZodType>(item: T) =>
  z.strictObject({
    items: z.array(item).max(LIMITS.maxPageLimit),
    nextCursor: PageCursor.nullable(),
  });

// Path params: invalid ones are a 404, not a 400 (design §5.4).
export const KeyParams = z.strictObject({ key: Hex64 });
export const FingerprintParams = z.strictObject({ fp: Hex64 });

export const StatusResponse = z.strictObject({ status: z.literal('ok') });

export const MetaResponse = z.strictObject({
  apiVersion: z.literal(1),
  limits: z.strictObject({
    maxFileBytes: z.number().int(),
    quotaBytes: z.number().int(),
    maxWords: z.number().int(),
    maxMessagesPerWord: z.number().int(),
    maxDocuments: z.number().int(),
    maxHighlightsPerDocument: z.number().int(),
    maxPushChanges: z.number().int(),
    maxPullLimit: z.number().int(),
  }),
});
export type MetaResponse = z.infer<typeof MetaResponse>;

export const ExtensionGoogleRequest = z.strictObject({
  code: z.string().min(1).max(2048),
  codeVerifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
  redirectUri: z.url().max(2048),
  nonce: z.string().min(1).max(64),
});
export type ExtensionGoogleRequest = z.infer<typeof ExtensionGoogleRequest>;

/** `crt_` + 32 random bytes as base64url (43 chars). */
export const RefreshTokenString = z.string().regex(/^crt_[A-Za-z0-9_-]{43}$/);
export const RefreshRequest = z.strictObject({ refreshToken: RefreshTokenString });
export const LogoutRequest = RefreshRequest;
export type RefreshRequest = z.infer<typeof RefreshRequest>;

export const AuthStartQuery = z.strictObject({ reauth: z.literal('1').optional() });
export const AuthCallbackQuery = z.looseObject({
  code: z.string().min(1).max(2048).optional(),
  state: z.string().min(1).max(256).optional(),
  error: z.string().max(200).optional(),
});

export const SessionResponse = z.strictObject({
  user: User,
  csrfToken: z.string().min(1).max(256),
  authenticatedAt: EpochMs,
});
export type SessionResponse = z.infer<typeof SessionResponse>;

export const AccountResponse = z.strictObject({
  user: User,
  usage: z.strictObject({
    storageUsedBytes: z.number().int().nonnegative(),
    storageQuotaBytes: z.number().int().nonnegative(),
    words: z.number().int().nonnegative(),
    documents: z.number().int().nonnegative(),
  }),
});
export type AccountResponse = z.infer<typeof AccountResponse>;

export const DeleteAccountRequest = z.strictObject({ confirm: z.literal('DELETE') });

export const WordsQuery = z.strictObject({
  q: Text(LIMITS.maxSearchChars).optional(),
  ...pageQuery,
});
export const WordsResponse = page(WordSummary);
export const WordDetailResponse = z.strictObject({
  word: WordView,
  messages: z.array(ChatView).max(LIMITS.maxMessagesPerWord),
});

export const PageQuery = z.strictObject(pageQuery);
export const DocumentsResponse = page(DocumentView);
export const DocumentDetailResponse = z.strictObject({
  document: DocumentView,
  highlights: z.array(HighlightView).max(LIMITS.maxHighlightsPerDocument),
});
export const FileUploadResponse = z.strictObject({ document: DocumentView });

/** `X-Clavis-Title` header: percent-encoded text, at most 300 characters once decoded. */
export const FILE_TITLE_HEADER = 'X-Clavis-Title';
export const FileTitleHeader = z
  .string()
  .max(1800)
  .transform((raw, ctx) => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'X-Clavis-Title is not valid percent-encoding' });
      return z.NEVER;
    }
    if (decoded.length > 300) {
      ctx.addIssue({ code: 'custom', message: 'X-Clavis-Title exceeds 300 characters' });
      return z.NEVER;
    }
    return decoded;
  });

type Auth = 'none' | 'bearer' | 'cookie' | 'bearer-or-cookie' | 'oauth-cookie';
interface EndpointSpec {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  auth: Auth;
  /** Zod schemas for the parts of the request that are validated. */
  params?: z.ZodType;
  query?: z.ZodType;
  body?: z.ZodType;
  /** Schema of the 2xx JSON body; absent for 204/302/binary. */
  response?: z.ZodType;
  /** 2xx status; 302 means redirect. */
  status: 200 | 204 | 302;
}

/** Machine-readable endpoint table for §5.4. Rate limits are server policy and live in the server. */
export const ENDPOINTS = {
  healthz: { method: 'GET', path: '/healthz', auth: 'none', status: 200, response: StatusResponse },
  readyz: { method: 'GET', path: '/readyz', auth: 'none', status: 200, response: StatusResponse },
  meta: { method: 'GET', path: '/v1/meta', auth: 'none', status: 200, response: MetaResponse },
  extensionGoogle: {
    method: 'POST',
    path: '/v1/auth/extension/google',
    auth: 'none',
    status: 200,
    body: ExtensionGoogleRequest,
    response: TokenPair,
  },
  extensionRefresh: {
    method: 'POST',
    path: '/v1/auth/extension/refresh',
    auth: 'none',
    status: 200,
    body: RefreshRequest,
    response: TokenPair,
  },
  extensionLogout: {
    method: 'POST',
    path: '/v1/auth/extension/logout',
    auth: 'none',
    status: 204,
    body: LogoutRequest,
  },
  googleStart: {
    method: 'GET',
    path: '/auth/google/start',
    auth: 'none',
    status: 302,
    query: AuthStartQuery,
  },
  googleCallback: {
    method: 'GET',
    path: '/auth/google/callback',
    auth: 'oauth-cookie',
    status: 302,
    query: AuthCallbackQuery,
  },
  webLogout: { method: 'POST', path: '/auth/logout', auth: 'cookie', status: 204 },
  session: {
    method: 'GET',
    path: '/v1/session',
    auth: 'cookie',
    status: 200,
    response: SessionResponse,
  },
  account: {
    method: 'GET',
    path: '/v1/account',
    auth: 'bearer-or-cookie',
    status: 200,
    response: AccountResponse,
  },
  logoutAll: {
    method: 'POST',
    path: '/v1/account/logout-all',
    auth: 'bearer-or-cookie',
    status: 204,
  },
  accountExport: { method: 'GET', path: '/v1/account/export', auth: 'cookie', status: 200 },
  accountDelete: {
    method: 'DELETE',
    path: '/v1/account',
    auth: 'cookie',
    status: 204,
    body: DeleteAccountRequest,
  },
  syncPush: {
    method: 'POST',
    path: '/v1/sync/push',
    auth: 'bearer',
    status: 200,
    body: PushRequest,
    response: PushResponse,
  },
  syncPull: {
    method: 'GET',
    path: '/v1/sync/pull',
    auth: 'bearer',
    status: 200,
    query: PullQuery,
    response: PullResponse,
  },
  wordsList: {
    method: 'GET',
    path: '/v1/words',
    auth: 'bearer-or-cookie',
    status: 200,
    query: WordsQuery,
    response: WordsResponse,
  },
  wordGet: {
    method: 'GET',
    path: '/v1/words/:key',
    auth: 'bearer-or-cookie',
    status: 200,
    params: KeyParams,
    response: WordDetailResponse,
  },
  wordDelete: {
    method: 'DELETE',
    path: '/v1/words/:key',
    auth: 'bearer-or-cookie',
    status: 204,
    params: KeyParams,
  },
  documentsList: {
    method: 'GET',
    path: '/v1/documents',
    auth: 'bearer-or-cookie',
    status: 200,
    query: PageQuery,
    response: DocumentsResponse,
  },
  documentGet: {
    method: 'GET',
    path: '/v1/documents/:fp',
    auth: 'bearer-or-cookie',
    status: 200,
    params: FingerprintParams,
    response: DocumentDetailResponse,
  },
  documentDelete: {
    method: 'DELETE',
    path: '/v1/documents/:fp',
    auth: 'bearer-or-cookie',
    status: 204,
    params: FingerprintParams,
  },
  fileUpload: {
    method: 'PUT',
    path: '/v1/documents/:fp/file',
    auth: 'bearer',
    status: 200,
    params: FingerprintParams,
    response: FileUploadResponse,
  },
  fileDownload: {
    method: 'GET',
    path: '/v1/documents/:fp/file',
    auth: 'bearer-or-cookie',
    status: 200,
    params: FingerprintParams,
  },
  fileDelete: {
    method: 'DELETE',
    path: '/v1/documents/:fp/file',
    auth: 'bearer-or-cookie',
    status: 204,
    params: FingerprintParams,
  },
} as const satisfies Record<string, EndpointSpec>;
