import { describe, expect, it } from 'vitest';
import { httpsOrigin, resolveAccountConfig } from '../../../lib/account/config';
import { devOrigin } from '../../../lib/account/dev-config';

const PROD = 'https://clavis-api-production.up.railway.app';
const GOOGLE = 'https://accounts.google.com/o/oauth2/v2/auth';

describe('account configuration', () => {
  it('defaults to the production host and Google', () => {
    expect(resolveAccountConfig({}, false)).toEqual({
      apiOrigin: PROD,
      googleClientId: '',
      googleAuthUrl: GOOGLE,
      googleLoginHint: undefined,
    });
  });

  it('a store build ignores every dev override and never takes http', () => {
    const env = {
      WXT_CLAVIS_API_ORIGIN: 'http://localhost:8787',
      WXT_CLAVIS_GOOGLE_AUTH_URL: 'http://127.0.0.1:8788/authorize',
      WXT_CLAVIS_GOOGLE_LOGIN_HINT: 'e2e-user-a@example.test',
      WXT_CLAVIS_GOOGLE_CLIENT_ID: ' client ',
    };
    const config = resolveAccountConfig(env, false);
    expect(config.apiOrigin).toBe(PROD);
    expect(config.googleAuthUrl).toBe(GOOGLE);
    expect(config.googleLoginHint).toBeUndefined();
    expect(config.googleClientId).toBe('client');
    // A different https API origin is a build-time choice and allowed.
    expect(
      resolveAccountConfig({ WXT_CLAVIS_API_ORIGIN: 'https://api.example.org/x' }, false).apiOrigin,
    ).toBe('https://api.example.org');
  });

  it('a dev build takes a local API, a fake Google and a login hint', () => {
    const config = resolveAccountConfig(
      {
        WXT_CLAVIS_API_ORIGIN: 'http://localhost:8787',
        WXT_CLAVIS_GOOGLE_AUTH_URL: 'http://127.0.0.1:8788/authorize',
        WXT_CLAVIS_GOOGLE_LOGIN_HINT: 'e2e-user-b@example.test',
        WXT_CLAVIS_GOOGLE_CLIENT_ID: 'fake-client.apps.googleusercontent.com',
      },
      true,
    );
    expect(config).toEqual({
      apiOrigin: 'http://localhost:8787',
      googleClientId: 'fake-client.apps.googleusercontent.com',
      googleAuthUrl: 'http://127.0.0.1:8788/authorize',
      googleLoginHint: 'e2e-user-b@example.test',
    });
  });

  it('http is only for the local machine, never credentials in the origin, junk falls back', () => {
    expect(devOrigin('http://evil.example')).toBeNull();
    expect(httpsOrigin('http://localhost:1')).toBeNull();
    expect(devOrigin('https://u:p@api.example')).toBeNull();
    expect(devOrigin('ftp://x')).toBeNull();
    expect(
      resolveAccountConfig(
        {
          WXT_CLAVIS_API_ORIGIN: 'http://evil.example',
          WXT_CLAVIS_GOOGLE_AUTH_URL: 'http://evil.example/a',
          WXT_CLAVIS_GOOGLE_LOGIN_HINT: 'a b@c',
        },
        true,
      ),
    ).toMatchObject({ apiOrigin: PROD, googleAuthUrl: GOOGLE, googleLoginHint: undefined });
  });
});
