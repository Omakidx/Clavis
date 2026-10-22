import {
  LOG_METADATA_FIELDS,
  MAX_LOG_STRING_CHARS,
  logger,
  sanitizeMetadata,
} from '../../../lib/security/logger';

describe('logger', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('only allowlists metadata fields', () => {
    expect([...LOG_METADATA_FIELDS]).toEqual([
      'requestId',
      'mode',
      'status',
      'durationMs',
      'errorCode',
    ]);
  });

  it('drops non-allowlisted fields, including text, keys and URLs', () => {
    const out = sanitizeMetadata({
      requestId: 'abc',
      mode: 'core',
      status: 429,
      durationMs: 12,
      errorCode: 'RATE_LIMITED',
      text: 'selected words',
      apiKey: 'gsk_secret',
      url: 'https://example.com/?token=1',
    });
    expect(out).toEqual({
      requestId: 'abc',
      mode: 'core',
      status: 429,
      durationMs: 12,
      errorCode: 'RATE_LIMITED',
    });
  });

  it('drops non-primitive, non-finite and inherited values and tolerates junk input', () => {
    expect(
      sanitizeMetadata({
        requestId: { toString: () => 'x' },
        status: NaN,
        durationMs: Infinity,
        mode: ['core'],
      }),
    ).toEqual({});
    expect(sanitizeMetadata(Object.create({ requestId: 'inherited' }))).toEqual({});
    for (const junk of [null, undefined, 'str', 5]) expect(sanitizeMetadata(junk)).toEqual({});
  });

  it('truncates long strings to at most 64 characters', () => {
    const out = sanitizeMetadata({ requestId: 'a'.repeat(500) });
    expect(String(out.requestId).length).toBe(MAX_LOG_STRING_CHARS);
    expect(String(out.requestId).endsWith('…')).toBe(true);
    expect(sanitizeMetadata({ requestId: 'a'.repeat(64) }).requestId).toBe('a'.repeat(64));
  });

  it('replaces control characters to prevent log injection', () => {
    expect(sanitizeMetadata({ mode: 'core\nFAKE LINE\r\u0000' }).mode).toBe('core FAKE LINE ');
  });

  it('error always logs via console.error with sanitized metadata', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('DEV', false);
    logger.error('explain_failed', {
      errorCode: 'TIMEOUT',
      durationMs: 30000,
      text: 'leak',
    } as never);
    expect(spy).toHaveBeenCalledWith('[clavis] explain_failed', {
      errorCode: 'TIMEOUT',
      durationMs: 30000,
    });
  });

  it('warn always logs via console.warn, even in production', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('DEV', false);
    logger.warn('retrying', { status: 503 });
    expect(spy).toHaveBeenCalledWith('[clavis] retrying', { status: 503 });
  });

  it('debug logs in development and is a no-op in production', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('DEV', true);
    logger.debug('selection_seen', { mode: 'core' });
    expect(spy).toHaveBeenCalledTimes(1);
    vi.stubEnv('DEV', false);
    logger.debug('selection_seen', { mode: 'core' });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('never calls console.log and neutralizes unsafe event names', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logger.warn('selected text: <b>hello</b>\nsecond line');
    expect(warn).toHaveBeenCalledWith('[clavis] invalid_event', {});
    expect(log).not.toHaveBeenCalled();
  });
});
