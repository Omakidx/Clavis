import {
  CONTENT_SCRIPT_ID,
  EXTENSION_PAGES,
  GROQ,
  LIMITS,
  MESSAGE_VERSION,
  MODEL_CANDIDATES,
  OPTIONAL_SITE_ORIGINS,
  REQUEST_TIMEOUT_MS,
  TTS_RATES,
} from '../../../lib/config/constants';

describe('config constants', () => {
  it('pins the normative selection limits', () => {
    expect(LIMITS.maxSelectionChars).toBe(2000);
    expect(LIMITS.maxContextChars).toBe(1000);
    expect(LIMITS.maxMessageBytes).toBeGreaterThan(
      (LIMITS.maxSelectionChars + LIMITS.maxContextChars) * 4,
    );
  });

  it('keeps Groq endpoints https-only and consistent with the API base', () => {
    for (const url of [GROQ.apiBase, GROQ.chatCompletionsUrl, GROQ.modelsUrl]) {
      expect(new URL(url).protocol).toBe('https:');
      expect(new URL(url).host).toBe('api.groq.com');
    }
    expect(GROQ.chatCompletionsUrl).toBe(`${GROQ.apiBase}/chat/completions`);
    expect(GROQ.modelsUrl).toBe(`${GROQ.apiBase}/models`);
    expect(GROQ.hostPermission).toBe('https://api.groq.com/*');
  });

  it('exposes model candidates, not secrets', () => {
    expect(MODEL_CANDIDATES).toEqual({ quick: 'openai/gpt-oss-20b', deep: 'openai/gpt-oss-120b' });
  });

  it('has TTS rates that sit inside their own bounds', () => {
    expect(TTS_RATES.normal).toBe(1.0);
    expect(TTS_RATES.slow).toBe(0.75);
    for (const rate of [TTS_RATES.normal, TTS_RATES.slow]) {
      expect(rate).toBeGreaterThanOrEqual(TTS_RATES.min);
      expect(rate).toBeLessThanOrEqual(TTS_RATES.max);
    }
  });

  it('uses extension-ID independent, root-relative page routes', () => {
    expect(EXTENSION_PAGES).toEqual({
      popup: '/popup.html',
      onboarding: '/onboarding.html',
      options: '/options.html',
      reader: '/reader.html',
    });
    for (const route of Object.values(EXTENSION_PAGES)) {
      expect(route).toMatch(/^\/[a-z]+\.html$/);
      expect(route).not.toContain('chrome-extension');
    }
  });

  it('declares optional site origins, script id, message version and bounded timeouts', () => {
    expect(OPTIONAL_SITE_ORIGINS).toEqual(['http://*/*', 'https://*/*']);
    expect(CONTENT_SCRIPT_ID).toBe('clavis-observer');
    expect(MESSAGE_VERSION).toBe(1);
    expect(REQUEST_TIMEOUT_MS.default).toBeGreaterThan(0);
    expect(REQUEST_TIMEOUT_MS.keyValidation).toBeGreaterThan(0);
  });
});
