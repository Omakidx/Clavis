import { z } from 'zod';

// Environment validation (docs/clavis-sync-design.md §9). Fails fast with variable NAMES and
// reasons only: values are never echoed, because many of them are secrets.

const flag = (def: '0' | '1') =>
  z
    .enum(['0', '1'])
    .default(def)
    .transform((v) => v === '1');
const optionalString = z.string().min(1).optional();

/** >= 32 random bytes, base64 or base64url. */
const secret = z
  .string()
  .regex(/^[A-Za-z0-9+/_-]+={0,2}$/, 'must be base64 or base64url')
  .refine((v) => Buffer.from(v, 'base64').length >= 32, 'must decode to at least 32 bytes');

const extensionId = z.string().regex(/^[a-p]{32}$/, 'extension IDs are 32 characters a-p');

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(8787),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    DATABASE_URL: z
      .string()
      .regex(/^postgres(ql)?:\/\//, 'must be a postgres:// or postgresql:// URL')
      .optional(),
    PUBLIC_ORIGIN: z.url().optional(),
    GOOGLE_CLIENT_ID: optionalString,
    GOOGLE_CLIENT_SECRET: optionalString,
    ALLOWED_EXTENSION_IDS: z.string().optional(),
    TOKEN_SIGNING_SECRET: secret.optional(),
    TOKEN_SIGNING_SECRET_PREVIOUS: secret.optional(),
    STATE_COOKIE_SECRET: secret.optional(),
    S3_ENDPOINT: z.url().optional(),
    S3_REGION: optionalString,
    S3_BUCKET: optionalString,
    S3_ACCESS_KEY_ID: optionalString,
    S3_SECRET_ACCESS_KEY: optionalString,
    S3_FORCE_PATH_STYLE: flag('0'),
    TRUST_PROXY: flag('0'),
    JOBS_ENABLED: flag('1'),
    STORAGE_ALERT_BYTES: z.coerce.number().int().positive().optional(),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production') {
      if (!env.PUBLIC_ORIGIN) {
        ctx.addIssue({
          code: 'custom',
          path: ['PUBLIC_ORIGIN'],
          message: 'is required in production',
        });
      } else if (!env.PUBLIC_ORIGIN.startsWith('https://')) {
        ctx.addIssue({
          code: 'custom',
          path: ['PUBLIC_ORIGIN'],
          message: 'must be https:// in production',
        });
      }
    }
    if (env.NODE_ENV === 'production') {
      // Sign-in cannot work without these, so a production boot must fail fast instead of serving 503s.
      const required: Array<[string, unknown]> = [
        ['DATABASE_URL', env.DATABASE_URL],
        ['GOOGLE_CLIENT_ID', env.GOOGLE_CLIENT_ID],
        ['GOOGLE_CLIENT_SECRET', env.GOOGLE_CLIENT_SECRET],
        ['ALLOWED_EXTENSION_IDS', env.ALLOWED_EXTENSION_IDS?.split(',').some((s) => s.trim())],
        ['TOKEN_SIGNING_SECRET', env.TOKEN_SIGNING_SECRET],
        ['STATE_COOKIE_SECRET', env.STATE_COOKIE_SECRET],
      ];
      for (const [name, value] of required) {
        if (!value)
          ctx.addIssue({ code: 'custom', path: [name], message: 'is required in production' });
      }
    }
    if (env.TOKEN_SIGNING_SECRET && env.TOKEN_SIGNING_SECRET === env.STATE_COOKIE_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['STATE_COOKIE_SECRET'],
        message: 'must differ from TOKEN_SIGNING_SECRET',
      });
    }
    if (env.PUBLIC_ORIGIN) {
      const u = new URL(env.PUBLIC_ORIGIN);
      if (u.pathname !== '/' || u.search || u.hash || u.username) {
        ctx.addIssue({
          code: 'custom',
          path: ['PUBLIC_ORIGIN'],
          message: 'must be a bare origin without path or credentials',
        });
      }
    }
    const s3 = [env.S3_ENDPOINT, env.S3_BUCKET, env.S3_ACCESS_KEY_ID, env.S3_SECRET_ACCESS_KEY];
    if (s3.some(Boolean) && !s3.every(Boolean)) {
      ctx.addIssue({
        code: 'custom',
        path: ['S3_ENDPOINT'],
        message:
          'S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be set together',
      });
    }
  });

export interface Config {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  logLevel: string;
  databaseUrl: string | undefined;
  publicOrigin: string | undefined;
  googleClientId: string | undefined;
  googleClientSecret: string | undefined;
  allowedExtensionIds: string[];
  /** `chrome-extension://<id>` */
  allowedExtensionOrigins: string[];
  /** `https://<id>.chromiumapp.org/` */
  allowedExtensionRedirects: string[];
  tokenSigningSecret: string | undefined;
  tokenSigningSecretPrevious: string | undefined;
  stateCookieSecret: string | undefined;
  s3:
    | {
        endpoint: string;
        region: string;
        bucket: string;
        accessKeyId: string;
        secretAccessKey: string;
        forcePathStyle: boolean;
      }
    | undefined;
  trustProxy: boolean;
  jobsEnabled: boolean;
  storageAlertBytes: number | undefined;
}

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid environment configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/** Parse and validate `env`. Throws ConfigError listing variable names and reasons, never values. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  // Treat empty strings (an unset Railway reference, a blank .env line) as unset.
  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && v !== '') cleaned[k] = v;

  const parsed = EnvSchema.safeParse(cleaned);
  const problems: string[] = [];
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      problems.push(`${issue.path.join('.') || '(env)'}: ${issue.message}`);
    }
  }

  const ids = (cleaned['ALLOWED_EXTENSION_IDS'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const id of ids) {
    if (!extensionId.safeParse(id).success) {
      problems.push(
        'ALLOWED_EXTENSION_IDS: contains an entry that is not a 32-character a-p extension ID',
      );
      break;
    }
  }
  if (!parsed.success || problems.length > 0) throw new ConfigError(problems);

  const e = parsed.data;
  const uniqueIds = [...new Set(ids)];
  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    databaseUrl: e.DATABASE_URL,
    publicOrigin: e.PUBLIC_ORIGIN ? new URL(e.PUBLIC_ORIGIN).origin : undefined,
    googleClientId: e.GOOGLE_CLIENT_ID,
    googleClientSecret: e.GOOGLE_CLIENT_SECRET,
    allowedExtensionIds: uniqueIds,
    allowedExtensionOrigins: uniqueIds.map((id) => `chrome-extension://${id}`),
    allowedExtensionRedirects: uniqueIds.map((id) => `https://${id}.chromiumapp.org/`),
    tokenSigningSecret: e.TOKEN_SIGNING_SECRET,
    tokenSigningSecretPrevious: e.TOKEN_SIGNING_SECRET_PREVIOUS,
    stateCookieSecret: e.STATE_COOKIE_SECRET,
    s3:
      e.S3_ENDPOINT && e.S3_BUCKET && e.S3_ACCESS_KEY_ID && e.S3_SECRET_ACCESS_KEY
        ? {
            endpoint: e.S3_ENDPOINT,
            region: e.S3_REGION ?? 'auto',
            bucket: e.S3_BUCKET,
            accessKeyId: e.S3_ACCESS_KEY_ID,
            secretAccessKey: e.S3_SECRET_ACCESS_KEY,
            forcePathStyle: e.S3_FORCE_PATH_STYLE,
          }
        : undefined,
    trustProxy: e.TRUST_PROXY,
    jobsEnabled: e.JOBS_ENABLED,
    storageAlertBytes: e.STORAGE_ALERT_BYTES,
  };
}
