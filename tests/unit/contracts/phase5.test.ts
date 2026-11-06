import { describe, expect, it } from 'vitest';
import {
  aiExplainMessageSchema,
  errorEnvelopeSchema,
  etymologyModelOutputSchema,
  explainResultSchema,
  loadExplainCardMessageSchema,
  loadToolbarMessageSchema,
  messageReplySchema,
  openSettingsMessageSchema,
  parsePrivilegedMessage,
  parsePublicMessage,
  simplifyOutputSchema,
  translateOutputSchema,
} from '../../../lib/contracts';
import { explainRequest } from './fixtures';

const base = { v: 1, type: 'AI_EXPLAIN', payload: explainRequest() };

describe('Phase 5 contract additions', () => {
  it('AI_EXPLAIN accepts the acknowledgement flag only as literal true', () => {
    expect(aiExplainMessageSchema.safeParse(base).success).toBe(true);
    expect(aiExplainMessageSchema.safeParse({ ...base, acknowledgeDisclosure: true }).success).toBe(
      true,
    );
    for (const bad of [false, 'true', 1, null]) {
      expect(
        aiExplainMessageSchema.safeParse({ ...base, acknowledgeDisclosure: bad }).success,
      ).toBe(false);
    }
    // The flag belongs on the message, not the payload (the payload stays strict).
    expect(
      aiExplainMessageSchema.safeParse({
        ...base,
        payload: { ...explainRequest(), acknowledgeDisclosure: true },
      }).success,
    ).toBe(false);
  });

  it('LOAD_EXPLAIN_CARD, LOAD_TOOLBAR and OPEN_SETTINGS are public routes with strict shapes', () => {
    expect(
      loadExplainCardMessageSchema.safeParse({ v: 1, type: 'LOAD_EXPLAIN_CARD' }).success,
    ).toBe(true);
    expect(
      loadExplainCardMessageSchema.safeParse({ v: 1, type: 'LOAD_EXPLAIN_CARD', tabId: 1 }).success,
    ).toBe(false);
    for (const section of [undefined, 'key', 'model', 'privacy']) {
      expect(
        openSettingsMessageSchema.safeParse({
          v: 1,
          type: 'OPEN_SETTINGS',
          ...(section ? { section } : {}),
        }).success,
      ).toBe(true);
    }
    expect(
      openSettingsMessageSchema.safeParse({ v: 1, type: 'OPEN_SETTINGS', section: 'other' })
        .success,
    ).toBe(false);
    expect(parsePublicMessage({ v: 1, type: 'LOAD_TOOLBAR' }).ok).toBe(true);
    expect(
      loadToolbarMessageSchema.safeParse({ v: 1, type: 'LOAD_TOOLBAR', files: ['bad.js'] }).success,
    ).toBe(false);
    expect(parsePublicMessage({ v: 1, type: 'LOAD_EXPLAIN_CARD' }).ok).toBe(true);
    expect(parsePublicMessage({ v: 1, type: 'OPEN_SETTINGS' }).ok).toBe(true);
    // Never part of the privileged union.
    expect(parsePrivilegedMessage({ v: 1, type: 'LOAD_EXPLAIN_CARD' }).ok).toBe(false);
    expect(parsePrivilegedMessage({ v: 1, type: 'OPEN_SETTINGS' }).ok).toBe(false);
  });

  it('the error envelope carries an optional reason, and only the known one', () => {
    const envelope = { code: 'SETUP_REQUIRED', message: 'm' };
    expect(errorEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(errorEnvelopeSchema.safeParse({ ...envelope, reason: 'disclosure' }).success).toBe(true);
    expect(errorEnvelopeSchema.safeParse({ ...envelope, reason: 'other' }).success).toBe(false);
    const parsed = messageReplySchema(explainResultSchema).safeParse({
      ok: false,
      error: { ...envelope, reason: 'disclosure' },
    });
    expect(parsed.success).toBe(true);
  });

  it('lazy-mode outputs accept an optional caveat; translation an optional literal', () => {
    expect(
      etymologyModelOutputSchema.safeParse({ overview: 'o', confidence: 'known' }).success,
    ).toBe(true);
    expect(
      etymologyModelOutputSchema.safeParse({ overview: 'o', confidence: 'uncertain', caveat: 'c' })
        .success,
    ).toBe(true);
    expect(simplifyOutputSchema.safeParse({ simplifiedText: 's', caveat: 'c' }).success).toBe(true);
    expect(
      translateOutputSchema.safeParse({ language: 'French', text: 't', literal: 'l' }).success,
    ).toBe(true);
    expect(translateOutputSchema.safeParse({ language: 'French', text: 't' }).success).toBe(true);
  });

  it('ExplainResult.translation accepts the optional literal rendering', () => {
    const result = {
      requestId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
      selectedText: 'x',
      mode: 'translate',
      title: 't',
      summary: 's',
      translation: { language: 'French', text: 'x', literal: 'y' },
      provider: 'groq',
      model: 'm',
    };
    expect(explainResultSchema.safeParse(result).success).toBe(true);
  });
});
