import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import GithubSlugger from 'github-slugger';
import { Marked, type Tokens } from 'marked';
import type { Plugin } from 'vite';

/** Unresolved-placeholder markers that must not ship (docs/privacy-policy.md). */
export const PLACEHOLDERS = [
  '[[OWNER:',
  '[PUBLISHER]',
  '[SUPPORT_EMAIL]',
  '[EFFECTIVE_DATE]',
  '[POLICY_URL]',
] as const;

/** Set to "1" (the production Docker build does) to FAIL the build while placeholders remain. */
export const STRICT_ENV = 'CLAVIS_POLICY_STRICT';

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function findPlaceholders(markdown: string): string[] {
  return PLACEHOLDERS.filter((p) => markdown.includes(p));
}

/** Renders the policy to a complete, CSP-clean HTML document (no inline style or script). */
export function renderPrivacyPage(markdown: string): string {
  const slugger = new GithubSlugger();
  const marked = new Marked({ gfm: true, async: false });
  marked.use({
    renderer: {
      heading(this, { tokens, depth }: Tokens.Heading) {
        const text = this.parser.parseInline(tokens);
        // GitHub-style anchors computed from the rendered heading's plain text.
        const id = slugger.slug(text.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&'));
        return `<h${depth} id="${id}">${text}</h${depth}>\n`;
      },
      link(this, { href, title, tokens }: Tokens.Link) {
        const text = this.parser.parseInline(tokens);
        const external = /^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('mailto:');
        const rel = external ? ' rel="noopener noreferrer"' : '';
        const t = title ? ` title="${escapeHtml(title)}"` : '';
        return `<a href="${escapeHtml(href)}"${t}${rel}>${text}</a>`;
      },
      // Raw HTML in the source is shown as text, never emitted.
      html({ text }: Tokens.HTML | Tokens.Tag) {
        return escapeHtml(text);
      },
    },
  });
  const body = marked.parse(markdown) as string;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Clavis privacy policy</title>
<meta name="description" content="How Clavis handles your data.">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/privacy/privacy.css">
</head>
<body>
<a class="skip-link" href="#policy">Skip to the policy</a>
<header class="site-header"><a class="home" href="/">&larr; Clavis dashboard</a></header>
<main id="policy" class="policy">
${body}</main>
</body>
</html>
`;
  if (/\sstyle\s*=|<script|<style|\son[a-z]+\s*=/i.test(html)) {
    throw new Error('privacy page: generated HTML contains inline style/script/handlers');
  }
  return html;
}

/** Vite plugin: writes <outDir>/privacy/index.html from the policy markdown after the bundle is written. */
export function privacyPage(opts: { source: string }): Plugin {
  let outDir = 'dist';
  return {
    name: 'clavis-privacy-page',
    apply: 'build',
    configResolved(cfg) {
      outDir = path.resolve(cfg.root, cfg.build.outDir);
    },
    async writeBundle() {
      const markdown = await readFile(opts.source, 'utf8');
      const left = findPlaceholders(markdown);
      if (left.length > 0) {
        if (process.env[STRICT_ENV] === '1') {
          throw new Error(
            `privacy policy still has unresolved placeholders: ${left.join(', ')} (${opts.source}). ` +
              `Resolve them, or unset ${STRICT_ENV} for a local build.`,
          );
        }
        this.warn(
          `privacy policy has unresolved placeholders (${left.join(', ')}); ok outside ${STRICT_ENV}=1`,
        );
      }
      const dir = path.join(outDir, 'privacy');
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'index.html'), renderPrivacyPage(markdown));
    },
  };
}
