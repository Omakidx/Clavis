import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { extensionPath } from './fixtures';
import { ALL_STATES } from './p8-accept-support/states';
import { startWorld } from './p8-accept-support/world';

// Phase 8, "Remove all placeholder controls that do nothing in final ZIP" and "End-to-end tasks
// completed without developer-only instructions": the built ZIP is unpacked and swept. Static part:
// the strings and pages inside the ZIP. Dynamic part: every screen of the extension's own pages,
// in every state (p8-accept-support/states.ts), for visible wording and for every link.
//
//   WXT_OUT_DIR=.output-p8-accept npx wxt build && WXT_OUT_DIR=.output-p8-accept npx wxt zip
//   CLAVIS_EXTENSION_DIR=.output-p8-accept/chrome-mv3 npx playwright test tests/e2e/p8-accept-placeholders.spec.ts
//   (the ZIP is found next to the build directory, or set CLAVIS_EXTENSION_ZIP)
test.describe.configure({ mode: 'serial', timeout: 300_000 });

/** Words that only a developer should ever see in a product: none may reach a person. */
const DEVELOPER_TEXT = new RegExp(
  [
    'coming soon',
    'not (yet )?implemented',
    '\\bTODO\\b',
    '\\bFIXME\\b',
    '\\bTBD\\b',
    'lorem ipsum',
    '\\bspike\\b',
    '\\bphase \\d',
    '\\bnpm\\b',
    '\\bnpx\\b',
    '\\bwxt\\b',
    'devtools',
    'developer mode',
    'localhost',
    '\\bplaceholder\\b',
    '\\bmock\\b',
    '\\bstub\\b',
    '\\bdebug\\b',
    'feature flag',
    'work in progress',
    'under construction',
    'for testing',
    '\\bFR-\\d{3}\\b',
    '\\bD-\\d{2}\\b',
    '\\bgsk_TEST',
  ].join('|'),
  'i',
);

/** Hosts a shipped link may point at: Groq's own key and privacy pages. */
const VERIFIED_HOSTS = ['console.groq.com', 'groq.com'];

function findZip(): string | undefined {
  const given = process.env['CLAVIS_EXTENSION_ZIP'];
  if (given !== undefined) return path.resolve(given);
  const parent = path.dirname(extensionPath);
  // Newest first: an older version's ZIP may still sit next to the build.
  const zips = readdirSync(parent)
    .filter((n) => n.endsWith('-chrome.zip'))
    .map((n) => path.join(parent, n))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return zips[0];
}

function walk(dir: string, base = dir): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full, base) : [path.relative(base, full)];
  });
}

const zipPath = findZip();
let unpacked = '';

test.beforeAll(() => {
  if (zipPath === undefined) return;
  unpacked = mkdtempSync(path.join(tmpdir(), 'clavis-zip-'));
  execFileSync('unzip', ['-q', zipPath, '-d', unpacked]);
});
test.afterAll(() => {
  if (unpacked !== '') rmSync(unpacked, { recursive: true, force: true });
});

test('the ZIP exists and holds the same files as the build, with no developer artifacts', async () => {
  expect(
    zipPath,
    'no ZIP next to the build: run `wxt zip` with the same WXT_OUT_DIR',
  ).toBeDefined();
  const inZip = walk(unpacked).sort();
  const inBuild = walk(extensionPath).sort();
  expect(inZip).toEqual(inBuild);
  for (const file of inZip) {
    expect(file, 'developer artifact in the ZIP').not.toMatch(
      /\.map$|\.env|\.ts$|\.tsx$|spike|fixtures|test|\.md$|node_modules|\.git/i,
    );
  }
  for (const page of ['popup', 'options', 'onboarding', 'practice', 'reader', 'sidepanel']) {
    expect(inZip, `${page}.html`).toContain(`${page}.html`);
  }
  const manifest = JSON.parse(readFileSync(path.join(unpacked, 'manifest.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  expect(manifest['permissions']).toContain('sidePanel');
  expect(manifest).not.toHaveProperty('side_panel');
});

test('every string a person can read in the ZIP is free of developer wording', async () => {
  const catalog = JSON.parse(
    readFileSync(path.join(unpacked, '_locales/en/messages.json'), 'utf8'),
  ) as Record<string, { message: string }>;
  const offenders = Object.entries(catalog)
    .filter(([, v]) => DEVELOPER_TEXT.test(v.message))
    .map(([key, v]) => `${key}: ${v.message.slice(0, 80)}`);
  expect(offenders).toEqual([]);
  // The pages' own markup and our scripts (the bundled PDF engine is third-party code).
  const ours = walk(unpacked).filter(
    (f) => /\.(html|js|css)$/.test(f) && !/pdfjs|pdf\.worker|pdf_viewer|chunks\/pdf-/.test(f),
  );
  for (const file of ours) {
    const text = readFileSync(path.join(unpacked, file), 'utf8');
    for (const word of [
      'coming soon',
      'lorem ipsum',
      'not implemented',
      'CLAVIS_FORCED_FEATURES',
    ]) {
      expect(text.toLowerCase(), `${file} contains "${word}"`).not.toContain(word.toLowerCase());
    }
    expect(text, `${file} names a spike or phase`).not.toMatch(/\bspike\b|Phase \d/i);
  }
});

test('every page of the ZIP loads only files that are in the ZIP', async () => {
  const files = new Set(walk(unpacked));
  for (const html of [...files].filter((f) => f.endsWith('.html'))) {
    const source = readFileSync(path.join(unpacked, html), 'utf8');
    const refs = [...source.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1] as string);
    for (const ref of refs) {
      expect(ref, `${html}: remote reference`).not.toMatch(/^(?:https?:)?\/\//);
      const target = ref.replace(/^\//, '').split(/[?#]/)[0] as string;
      expect(
        files.has(target) || existsSync(path.join(unpacked, target)),
        `${html} -> ${ref}`,
      ).toBe(true);
    }
  }
});

// What a person sees and every link, on every screen, in the unpacked build.
interface Seen {
  text: string;
  attrs: string[];
  links: { href: string; target: string | null; rel: string | null; text: string }[];
  ids: string[];
}

async function collect(page: Page): Promise<Seen> {
  return page.evaluate(() => {
    // Open every folded help block so its text counts.
    document.querySelectorAll('details').forEach((d) => d.setAttribute('open', ''));
    const attrs = Array.from(
      document.querySelectorAll('[aria-label],[title],[alt],[placeholder]'),
    ).flatMap((el) =>
      ['aria-label', 'title', 'alt', 'placeholder']
        .map((a) => el.getAttribute(a))
        .filter((v): v is string => v !== null),
    );
    return {
      text: document.body.innerText,
      attrs,
      links: Array.from(document.querySelectorAll('a')).map((a) => ({
        href: a.getAttribute('href') ?? '',
        target: a.getAttribute('target'),
        rel: a.getAttribute('rel'),
        text: (a.textContent ?? '').trim(),
      })),
      ids: Array.from(document.querySelectorAll('[id]')).map((el) => el.id),
    };
  });
}

test('every screen reads like a product, and every link on it resolves', async () => {
  const world = await startWorld({ granted: false });
  try {
    await world.onboarding.close();
    const wording: string[] = [];
    const broken: string[] = [];
    const external = new Map<string, string>();
    const files = new Set(walk(extensionPath));
    let optionsIds: string[] = [];
    const hashLinks: string[] = [];
    for (const state of ALL_STATES) {
      const page = await state.open(world);
      await page.waitForTimeout(500);
      const seen = await collect(page);
      if (state.name.startsWith('Settings'))
        optionsIds = [...new Set([...optionsIds, ...seen.ids])];
      for (const piece of [seen.text, ...seen.attrs]) {
        const hit = DEVELOPER_TEXT.exec(piece);
        if (hit !== null) wording.push(`${state.name}: "${hit[0]}" in "${piece.slice(0, 80)}"`);
      }
      for (const link of seen.links) {
        const where = `${state.name}: "${link.text}" -> ${link.href}`;
        if (link.href === '' || link.href === '#' || /^javascript:/i.test(link.href)) {
          broken.push(`${where} (does not go anywhere)`);
        } else if (/^https:\/\//.test(link.href)) {
          external.set(link.href, where);
          if (link.target !== '_blank' || !/noopener/.test(link.rel ?? '')) {
            broken.push(`${where} (external link must open a new tab with rel=noopener)`);
          }
        } else if (/^[a-z]+:/i.test(link.href)) {
          broken.push(`${where} (unexpected scheme)`);
        } else {
          const [file = '', hash = ''] = link.href.replace(/^\//, '').split('#');
          if (file !== '' && !files.has(file)) broken.push(`${where} (no such page in the build)`);
          if (hash !== '' && file === '' && !seen.ids.includes(hash)) {
            broken.push(`${where} (nothing on this screen has the id "${hash}")`);
          }
          if (hash !== '' && file === 'options.html') hashLinks.push(`${where}|${hash}`);
        }
      }
      await page.close();
    }
    // Links to a place inside Settings point at a section that exists.
    for (const entry of hashLinks) {
      const [where, hash] = entry.split('|') as [string, string];
      if (!optionsIds.includes(hash))
        broken.push(`${where} (no section "${hash}" on the Settings page)`);
    }
    expect(wording, 'developer wording on screen').toEqual([]);
    expect(broken, 'links that do not resolve').toEqual([]);
    // Every external link goes to a host whose page is known to exist.
    const unverified = [...external]
      .filter(([href]) => !VERIFIED_HOSTS.includes(new URL(href).hostname))
      .map(([href, where]) => `${href}  (${where})`);
    // Reported separately (DEFECT P3) so the rest of this sweep stays a clean pass/fail.
    expect(
      unverified.filter((u) => !u.startsWith('https://omakidx.github.io/clavis/privacy/')),
    ).toEqual([]);
    expect([...external.keys()]).toEqual(
      expect.arrayContaining(['https://console.groq.com/keys', 'https://groq.com/privacy-policy/']),
    );
  } finally {
    await world.close();
  }
});

// DEFECT P3: Settings > Privacy and data > "Clavis privacy policy" links to
// https://omakidx.github.io/clavis/privacy/, a URL that is not published yet (lib/ui-client/links.ts:
// "PLACEHOLDER (D-15) ... Replace with the real URL in Phase 10"). Repro: open Settings, press the link.
// FR-074 asks for a public, accurate policy; until it is published the shipped link leads nowhere.
test.fail('the privacy-policy link does not point at a placeholder address', async () => {
  const world = await startWorld({ granted: false });
  try {
    await world.onboarding.close();
    const page = await world.ext.context.newPage();
    await page.goto(`chrome-extension://${world.ext.extensionId}/options.html`);
    await page.getByRole('link', { name: 'Privacy & help' }).click();
    const link = page.getByRole('link', { name: /Clavis privacy policy/ });
    await expect(link).toBeVisible();
    const href = (await link.getAttribute('href')) ?? '';
    expect(VERIFIED_HOSTS).toContain(new URL(href).hostname);
  } finally {
    await world.close();
  }
});
