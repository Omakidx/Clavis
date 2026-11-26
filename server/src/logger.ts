import pino from 'pino';

export type Logger = pino.Logger;

/**
 * Structured JSON logs. No PII by construction: request logging records method, route and status only,
 * and the redact list is a second line of defence against secrets in logged objects.
 */
export function createLogger(level: string, destination?: pino.DestinationStream): Logger {
  return pino(
    {
      level,
      base: { service: 'clavis-api' },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      redact: {
        paths: [
          '*.authorization',
          '*.cookie',
          '*.password',
          '*.token',
          '*.accessToken',
          '*.refreshToken',
          '*.code',
          '*.codeVerifier',
          '*.secret',
          '*.email',
          'req.headers',
          'databaseUrl',
        ],
        censor: '[redacted]',
      },
    },
    destination,
  );
}
