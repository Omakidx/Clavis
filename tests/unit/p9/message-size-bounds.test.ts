import { beforeEach, describe, expect, it } from 'vitest';
import { LIMITS } from '../../../lib/config/constants';
import {
  REQ_A,
  REQ_B,
  contentSender,
  createHarness,
  makeReady,
  type Harness,
} from '../router/harness';

// Phase 9, section 9 "Security: oversized messages" (abuse case 7: "selected/context character
// ceilings"). The size bound on one inbound message (32 KiB, `LIMITS.maxMessageBytes`) is measured on
// the serialized bytes, so the worst LEGAL message must still fit: a full selection and full context
// made of the characters that grow most when serialized (control characters become `\u00XX`, six
// bytes each; quotes and backslashes two), and one character more must be refused.

const explain = (text: string, contextBefore?: string, contextAfter?: string) => ({
  v: 1,
  type: 'AI_EXPLAIN',
  payload: {
    requestId: REQ_A,
    snapshot: {
      selectionId: REQ_B,
      source: 'webpage',
      kind: 'passage',
      text,
      ...(contextBefore === undefined ? {} : { contextBefore }),
      ...(contextAfter === undefined ? {} : { contextAfter }),
    },
    mode: 'core',
    detailLevel: 'standard',
  },
});

let h: Harness;
beforeEach(async () => {
  h = createHarness();
  await makeReady(h);
});

const bytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;

describe('the largest legal Explain message', () => {
  // `.trim()` in the schema removes surrounding whitespace, so the fill characters are not spaces.
  const WORST: [string, string][] = [
    ['control characters (6 bytes each when serialized)', '\u0001'],
    ['double quotes (2 bytes each)', '"'],
    ['backslashes (2 bytes each)', '\\'],
    ['4-byte characters (an emoji is two UTF-16 units: one per unit)', '\u{1F600}'],
    ['3-byte characters (CJK)', '日'],
  ];

  for (const [name, ch] of WORST) {
    it(`2,000 selected + 1,000 context characters of ${name} is below the bound and answered`, async () => {
      const unit = ch.length;
      const text = ch.repeat(Math.floor(LIMITS.maxSelectionChars / unit));
      const before = ch.repeat(Math.floor(600 / unit));
      const after = ch.repeat(Math.floor(400 / unit));
      const message = explain(text, before, after);
      expect(bytes(message)).toBeLessThan(LIMITS.maxMessageBytes);
      expect(await h.call(message, contentSender())).toMatchObject({ ok: true });
    });
  }

  it('one character over the selection limit, or over the combined context limit, is refused before anything is sent', async () => {
    const calls = h.provider.explain.mock.calls.length;
    expect(
      await h.call(explain('a'.repeat(LIMITS.maxSelectionChars + 1)), contentSender()),
    ).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    expect(
      await h.call(explain('bank', 'a'.repeat(600), 'b'.repeat(401)), contentSender()),
    ).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    expect(h.provider.explain.mock.calls.length).toBe(calls);
  });

  it('a message over the byte bound is refused whatever it contains, without being parsed, and echoes nothing', async () => {
    const huge = { ...explain('bank'), padding: 'x'.repeat(LIMITS.maxMessageBytes) };
    const reply = await h.call(huge, contentSender());
    expect(reply).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    expect(JSON.stringify(reply)).not.toContain('xxxx');
  });
});
