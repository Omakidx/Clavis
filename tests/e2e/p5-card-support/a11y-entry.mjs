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
  const [scenario, detail] = options.scenario.split(':');
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
    explanationLanguage: () => Promise.resolve('en'),
  };
  const result = (request) => ({ kind: 'result', result: RESULTS[request.mode](request) });
  if (scenario === 'loading') answer = () => 'never';
  else if (scenario === 'core' || scenario === 'roots') answer = result;
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
    newId: () => `id-${(counter += 1)}`,
    features: { grammarTab: false, translateTab: false },
  });
  mountCard(slot, {
    session,
    host: {
      keyboard: options.keyboard === true,
      reposition: () => undefined,
      close: () => undefined,
      openSettings: () => Promise.resolve(true),
      copy: () => Promise.resolve(true),
      now: Date.now,
    },
  });
  session.attach();
  if (scenario === 'roots') {
    await new Promise((resolve) => setTimeout(resolve, 20));
    session.selectTab('etymology');
  }
  // Let promises, effects and the live region's arming delay settle.
  await new Promise((resolve) => setTimeout(resolve, 200));
  window.__session = session;
}
