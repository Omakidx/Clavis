import { describe, expect, it } from 'vitest';
import { LIMITS } from '../../../lib/config/constants';
import {
  parsePublicMessage,
  parseSidePanelMessage,
  sidePanelHandoffSchema,
  sidePanelStateSchema,
  sidePanelUpdatedMessageSchema,
} from '../../../lib/contracts';
import { UUID_A, UUID_B, snapshot } from './fixtures';

const result = (mode: string, over: Record<string, unknown> = {}) => ({
  requestId: UUID_B,
  mode,
  title: 'bank',
  summary: 'A financial institution.',
  provider: 'groq',
  model: 'openai/gpt-oss-20b',
  ...over,
});
const handoff = (over: Record<string, unknown> = {}) => ({
  snapshot: snapshot(),
  results: [result('core')],
  ...over,
});
const open = (over: Record<string, unknown> = {}) => ({
  v: 1,
  type: 'OPEN_SIDE_PANEL',
  handoff: handoff(over),
});

describe('side panel hand-off contract', () => {
  it('accepts a snapshot with its loaded results', () => {
    const parsed = sidePanelHandoffSchema.parse(
      handoff({ results: [result('core'), result('etymology')], active: 'etymology' }),
    );
    expect(parsed.results.map((r) => r.mode)).toEqual(['core', 'etymology']);
  });

  it('requires at least one result, at most one per mode', () => {
    expect(sidePanelHandoffSchema.safeParse(handoff({ results: [] })).success).toBe(false);
    expect(
      sidePanelHandoffSchema.safeParse(handoff({ results: [result('core'), result('core')] }))
        .success,
    ).toBe(false);
  });

  it('is strict: no key, url, cookie or html field can ride along', () => {
    expect(sidePanelHandoffSchema.safeParse(handoff({ apiKey: 'gsk_TESTx' })).success).toBe(false);
    expect(
      sidePanelHandoffSchema.safeParse(handoff({ snapshot: snapshot({ url: 'https://x' }) }))
        .success,
    ).toBe(false);
    expect(
      sidePanelHandoffSchema.safeParse(handoff({ results: [result('core', { html: '<b>' })] }))
        .success,
    ).toBe(false);
  });

  it('keeps the result field bounds of the explanation contract', () => {
    expect(
      sidePanelHandoffSchema.safeParse(
        handoff({ results: [result('core', { summary: 'x'.repeat(601) })] }),
      ).success,
    ).toBe(false);
    expect(
      sidePanelHandoffSchema.safeParse(handoff({ snapshot: snapshot({ text: 'x'.repeat(2001) }) }))
        .success,
    ).toBe(false);
  });

  it('keeps markup-looking text as literal text (validation is not sanitisation)', () => {
    const parsed = sidePanelHandoffSchema.parse(
      handoff({ results: [result('core', { summary: '<img src=x onerror=alert(1)> **bold**' })] }),
    );
    expect(parsed.results[0]?.summary).toBe('<img src=x onerror=alert(1)> **bold**');
  });

  it('the largest legal hand-off (every mode, full-size fields, 3-byte characters) fits the bound', () => {
    const cjk = (n: number) => '字'.repeat(n);
    const full = {
      snapshot: snapshot({ text: cjk(2000), contextBefore: cjk(500), contextAfter: cjk(500) }),
      results: [
        result('core', {
          title: cjk(120),
          summary: cjk(600),
          contextualMeaning: cjk(800),
          definition: cjk(600),
          examples: [
            { sentence: cjk(300), note: cjk(200) },
            { sentence: cjk(300), note: cjk(200) },
          ],
          caveat: cjk(400),
        }),
        result('etymology', {
          title: cjk(120),
          summary: cjk(600),
          etymology: { overview: cjk(1200), confidence: 'known' },
          caveat: cjk(400),
        }),
        result('related_words', {
          title: cjk(120),
          summary: cjk(600),
          synonyms: Array.from({ length: 12 }, () => cjk(60)),
          antonyms: Array.from({ length: 12 }, () => cjk(60)),
        }),
        result('simplify', {
          title: cjk(120),
          summary: cjk(600),
          simplifiedText: cjk(4000),
          caveat: cjk(400),
        }),
        result('grammar', {
          title: cjk(120),
          summary: cjk(600),
          grammar: cjk(2000),
          caveat: cjk(400),
        }),
        result('translate', {
          title: cjk(120),
          summary: cjk(600),
          translation: { language: cjk(64), text: cjk(4000), literal: cjk(4000) },
          caveat: cjk(400),
        }),
      ],
    };
    const message = { v: 1, type: 'OPEN_SIDE_PANEL', handoff: full };
    const bytes = new TextEncoder().encode(JSON.stringify(message)).length;
    expect(bytes).toBeLessThan(LIMITS.maxHandoffBytes);
    expect(parseSidePanelMessage(message).ok).toBe(true);
  });
});

describe('side panel messages', () => {
  it('parses OPEN_SIDE_PANEL and GET_SIDE_PANEL_STATE', () => {
    expect(parseSidePanelMessage(open())).toMatchObject({
      ok: true,
      message: { type: 'OPEN_SIDE_PANEL' },
    });
    expect(parseSidePanelMessage({ v: 1, type: 'GET_SIDE_PANEL_STATE', tabId: 7 })).toMatchObject({
      ok: true,
      message: { type: 'GET_SIDE_PANEL_STATE', tabId: 7 },
    });
  });

  it('rejects a bad version, an unknown type, extra keys and bad tab ids', () => {
    for (const bad of [
      { ...open(), v: 2 },
      { ...open(), type: 'AI_EXPLAIN' },
      { ...open(), extra: 1 },
      { v: 1, type: 'GET_SIDE_PANEL_STATE', tabId: -1 },
      { v: 1, type: 'GET_SIDE_PANEL_STATE', tabId: 1.5 },
      { v: 1, type: 'GET_SIDE_PANEL_STATE', tabId: '7' },
      { v: 1, type: 'GET_SIDE_PANEL_STATE', tabId: 2 ** 31 },
      { v: 1, type: 'GET_SIDE_PANEL_STATE' },
    ]) {
      expect(parseSidePanelMessage(bad).ok, JSON.stringify(bad).slice(0, 80)).toBe(false);
    }
  });

  it('bounds the message size and never throws on unserializable input', () => {
    const big = open({
      results: [result('core', { summary: 'x'.repeat(600) })],
      snapshot: snapshot({ text: 'x'.repeat(2000) }),
    });
    (big.handoff as Record<string, unknown>)['pad'] = 'y'.repeat(LIMITS.maxHandoffBytes);
    expect(parseSidePanelMessage(big)).toEqual({ ok: false, reason: 'too_large' });
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(parseSidePanelMessage(circular)).toEqual({ ok: false, reason: 'unserializable' });
    expect(parseSidePanelMessage(undefined)).toEqual({ ok: false, reason: 'unserializable' });
  });

  it('the public parser never accepts the side panel routes (they alone may exceed 32 KiB)', () => {
    expect(parsePublicMessage(open()).ok).toBe(false);
    expect(parsePublicMessage({ v: 1, type: 'GET_SIDE_PANEL_STATE', tabId: 1 }).ok).toBe(false);
  });

  it('describes the state reply and the update broadcast', () => {
    expect(sidePanelStateSchema.safeParse({ revision: 0, handoff: null }).success).toBe(true);
    expect(sidePanelStateSchema.safeParse({ revision: 3, handoff: handoff() }).success).toBe(true);
    expect(sidePanelStateSchema.safeParse({ revision: 3, handoff: handoff(), x: 1 }).success).toBe(
      false,
    );
    expect(
      sidePanelUpdatedMessageSchema.safeParse({
        v: 1,
        type: 'SIDE_PANEL_UPDATED',
        tabId: 4,
        revision: 2,
      }).success,
    ).toBe(true);
    // The broadcast carries no text: any extra field is refused.
    expect(
      sidePanelUpdatedMessageSchema.safeParse({
        v: 1,
        type: 'SIDE_PANEL_UPDATED',
        tabId: 4,
        revision: 2,
        text: 'secret',
      }).success,
    ).toBe(false);
    expect(UUID_A).toBeTruthy();
  });
});
