import { Hono } from 'hono';
import {
  ExtensionGoogleRequest,
  LogoutRequest,
  RefreshRequest,
} from '../../../shared/api-contract';
import { ApiException, parseJsonBody } from '../http/errors';
import { ipRateLimit, perMinute } from '../http/rate-limit';
import type { AppEnv } from '../http/types';
import type { AuthRuntime } from './runtime';

/** `/v1/auth/extension/*`: Bearer-style API for the extension (CORS applied by the caller). */
export function extensionRoutes(rt: AuthRuntime): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const trust = rt.config.trustProxy;
  const ip = (name: string, limit: number) =>
    ipRateLimit(rt.limiter, name, perMinute(limit), trust);

  app.post('/google', ip('ext-google', 10), async (c) => {
    // CORS alone does not stop non-browser clients, so the Origin is checked explicitly (design §2.2).
    const origin = c.req.header('origin');
    if (!origin || !rt.config.allowedExtensionOrigins.includes(origin)) {
      throw new ApiException('FORBIDDEN', 'Origin is not an allowed extension');
    }
    const body = await parseJsonBody(c, ExtensionGoogleRequest);
    if (!rt.config.allowedExtensionRedirects.includes(body.redirectUri)) {
      throw new ApiException('OAUTH_FAILED', 'redirectUri is not allowed');
    }
    const pair = await rt.service.signInWithGoogle(
      body.code,
      body.codeVerifier,
      body.redirectUri,
      body.nonce,
    );
    return c.json(pair);
  });

  app.post('/refresh', ip('ext-refresh', 30), async (c) => {
    const body = await parseJsonBody(c, RefreshRequest);
    return c.json(await rt.service.refresh(body.refreshToken));
  });

  app.post('/logout', ip('ext-logout', 30), async (c) => {
    const body = await parseJsonBody(c, LogoutRequest);
    await rt.service.logout(body.refreshToken);
    return c.body(null, 204);
  });

  return app;
}
