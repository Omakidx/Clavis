/* global CSSStyleSheet, document, window */
// TEST-ONLY bundle entry (never part of the extension). Renders the REAL explanation card (view,
// session and stylesheet) inside the toolbar's panel structure in an OPEN shadow root, so axe can
// see it: in the extension the root is closed (security review HIGH-1) and axe cannot enter.
// Plain .mjs on purpose (see tests/e2e/p4-toolbar-support/a11y-entry.mjs); esbuild bundles it with
// 'wxt/browser' aliased to the i18n stub and automatic JSX for Preact.
import { mountCard } from '../../../components/explanation/ExplanationCard.tsx';
import { ExplainSession } from '../../../components/explanation/session.ts';

const RESULTS = {
  core: (request) => ({
    requestId: request.requestId,
    selectedText: request.snapshot.text,
    mode: 'core',
    title: 'bank (noun)',
    summary: 'The land beside a river.',
    contextualMeaning: 'Here it means the edge of the river, not a money bank.',
    definition: 'Sloping ground along the side of a river.',
    examples: [
      { sentence: 'We fished from the bank.', note: 'riverside' },
      { sentence: 'The grass on the bank was wet.' },
    ],
    caveat: 'Other senses exist.',
    provider: 'groq',
    model: 'openai/gpt-oss-20b',
  }),
  etymology: (request) => ({
    requestId: request.requestId,
    selectedText: request.snapshot.text,
    mode: 'etymology',
    title: 'Roots of bank',
    summary: 'From Old Norse.',
    etymology: { overview: 'From Old Norse "bakki".', confidence: 'uncertain' },
    provider: 'groq',
    model: 'openai/gpt-oss-20b',
  }),
};

// Phase 8 scenarios: a long answer, right-to-left text, and the Should tabs with their flags forced on.
const LONG = 'Long text that keeps going. '.repeat(40);
RESULTS.coreLong = (request) => ({
  ...RESULTS.core(request),
  summary: LONG.slice(0, 600),
  contextualMeaning: LONG.slice(0, 800),
  definition: LONG.slice(0, 600),
});
RESULTS.coreRtl = (request) => ({
  ...RESULTS.core(request),
  title: 'ضفة',
  summary: 'الأرض بجانب النهر.',
  contextualMeaning: 'هنا تعني حافة النهر وليس مصرف الأموال (bank).',
  definition: 'أرض منحدرة على جانب النهر.',
  examples: [{ sentence: 'صدنا السمك من الضفة.' }, { sentence: 'Say ضفة to her.' }],
});
RESULTS.simplify = (request) => ({
  requestId: request.requestId,
  selectedText: request.snapshot.text,
  mode: 'simplify',
  title: 'bank',
  summary: 'x',
  simplifiedText: 'A simpler way to say it.',
  provider: 'groq',
  model: 'openai/gpt-oss-20b',
});
RESULTS.grammar = (request) => ({
  requestId: request.requestId,
  selectedText: request.snapshot.text,
  mode: 'grammar',
  title: 'bank',
  summary: 'x',
  grammar: 'Subject: she\nVerb: broke (past simple)\nObject: the ice (idiom)',
  caveat: 'An idiom: the parts do not add up.',
  provider: 'groq',
  model: 'openai/gpt-oss-20b',
});
RESULTS.translate = (request) => ({
  requestId: request.requestId,
  selectedText: request.snapshot.text,
  mode: 'translate',
  title: 'bank',
  summary: 'x',
  translation: { language: 'Arabic', text: 'كسرت الجليد أخيراً.', literal: 'كسرت الثلج.' },
  provider: 'groq',
  model: 'openai/gpt-oss-20b',
});

let counter = 0;

/**
 * @param {ShadowRoot} root
 * @param {{ scenario: string, kind?: string, css: string[], keyboard?: boolean }} options
 */
export async function show(root, options) {
  root.replaceChildren();
  if (root.adoptedStyleSheets.length === 0) {
    root.adoptedStyleSheets = options.css.map((text) => {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(text);
      return sheet;
    });
  }
  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.dataset.card = 'explain';
  panel.style.left = '8px';
  panel.style.top = '24px';
  const slot = document.createElement('section');
  slot.className = 'card-slot';
  panel.append(slot);
  root.append(panel);

  const pending = [];
  /** @type {(r: any, c: number) => any} */
  let answer = () => ({ kind: 'result' });
  const [scenario, detail, extra] = options.scenario.split(':');
  const error = (code, retryAfterMs) => ({ kind: 'error', code, retryAfterMs });
  const backend = {
    explain: (request, acknowledge) =>
      new Promise((resolve) => {
        const reply = answer(request, acknowledge);
        if (reply === 'never') pending.push(resolve);
        else resolve(reply);
      }),
    cancel: () => undefined,
    openSettings: () => Promise.resolve(true),
    openSidePanel: () => Promise.resolve(true),
    explanationLanguage: () => Promise.resolve('en'),
  };
  const result = (request) => ({ kind: 'result', result: RESULTS[request.mode](request) });
  if (scenario === 'loading') answer = () => 'never';
  else if (['core', 'roots', 'coreLong', 'coreRtl', 'flags', 'translate'].includes(scenario))
    answer = result;
  else if (scenario === 'disclosure') answer = () => ({ kind: 'disclosure' });
  else if (scenario === 'error')
    answer = () => error(detail, detail === 'RATE_LIMITED' ? 3_600_000 : undefined);

  const session = new ExplainSession({
    snapshot: {
      selectionId: `00000000-0000-4000-8000-${String((counter += 1)).padStart(12, '0')}`,
      source: 'webpage',
      kind: options.kind ?? 'word',
      text: 'bank',
    },
    backend,
    newId: () => `00000000-0000-4000-8000-${String((counter += 1)).padStart(12, '0')}`,
    features:
      scenario === 'flags'
        ? { grammarTab: true, translateTab: true }
        : // The shipped flags: Translate on (FR-037), Grammar off (FR-036).
          { grammarTab: false, translateTab: true },
    targetLanguage: 'ar',
  });
  mountCard(slot, {
    session,
    host: {
      keyboard: options.keyboard === true,
      reposition: () => undefined,
      close: () => undefined,
      openSettings: () => Promise.resolve(true),
      openSidePanel: () => Promise.resolve(true),
      online: () => extra !== 'offline',
      copy: () => Promise.resolve(true),
      now: Date.now,
    },
  });
  session.attach();
  if (scenario === 'flags') {
    for (const mode of ['simplify', 'grammar', 'translate']) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      session.selectTab(mode);
    }
  }
  if (scenario === 'translate') {
    await new Promise((resolve) => setTimeout(resolve, 20));
    session.selectTab('translate');
  }
  if (scenario === 'roots') {
    await new Promise((resolve) => setTimeout(resolve, 20));
    session.selectTab('etymology');
  }
  // Let promises, effects and the live region's arming delay settle.
  await new Promise((resolve) => setTimeout(resolve, 200));
  window.__session = session;
}
