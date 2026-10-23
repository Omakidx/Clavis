import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import AxeBuilder from '@axe-core/playwright';
import type { Frame, Page } from '@playwright/test';
import { tb } from '../spike-b-support/toolbar';

const require = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

export interface Violation {
  id: string;
  impact: string | null | undefined;
  nodes: string[];
}

/** axe on a whole ordinary page (popup, Settings, onboarding, reader, side panel). */
export async function axePage(page: Page): Promise<Violation[]> {
  const results = await new AxeBuilder({ page }).analyze();
  return results.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    nodes: v.nodes.map((n) => n.target.join(' ')).slice(0, 4),
  }));
}

/**
 * axe on the toolbar and card the way a screen reader meets them. The production DOM lives in the
 * CLOSED shadow root of the content script, which locators, axe and the page cannot reach (on
 * purpose). The DevTools protocol can: this takes a snapshot of that root (its nodes and its
 * adopted and inline style sheets) into an OPEN root on a fixed audit host in the same document,
 * runs axe on the host, and removes it. What is audited is the shipped markup and CSS in the live
 * state (colour scheme, viewport and card state as the test left them), not a rebuilt component.
 */
export async function axeToolbarRoot(page: Page, target: Page | Frame): Promise<Violation[]> {
  await target.evaluate(AXE_SOURCE);
  const probe = tb(target);
  const cloned = await probe.evalIn<boolean>(
    null,
    `function () {
      const old = document.getElementById('clavis-axe-audit');
      if (old) old.remove();
      const host = document.createElement('div');
      host.id = 'clavis-axe-audit';
      host.style.cssText = 'position:fixed;left:0;top:0;width:min(100vw,420px);z-index:2147483647';
      const open = host.attachShadow({ mode: 'open' });
      open.adoptedStyleSheets = Array.from(this.adoptedStyleSheets);
      for (const node of Array.from(this.childNodes)) open.appendChild(node.cloneNode(true));
      document.documentElement.appendChild(host);
      return open.childNodes.length > 0;
    }`,
  );
  if (cloned !== true) throw new Error('no toolbar root to audit');
  try {
    return await target.evaluate(async () => {
      const axe = (
        window as unknown as {
          axe: { run(context: string, options: object): Promise<{ violations: AxeResult[] }> };
        }
      ).axe;
      interface AxeResult {
        id: string;
        impact?: string | null;
        nodes: { target: unknown[] }[];
      }
      const results = await axe.run('#clavis-axe-audit', { resultTypes: ['violations'] });
      return results.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        nodes: v.nodes.map((n) => n.target.join(' ')).slice(0, 4),
      }));
    });
  } finally {
    await target.evaluate(() => document.getElementById('clavis-axe-audit')?.remove());
  }
}

export interface ContrastProblem {
  text: string;
  color: string;
  background: string;
  ratio: number;
}

/**
 * Text contrast (WCAG 1.4.3: 4.5:1, or 3:1 for large text) of everything the toolbar and card
 * show, computed inside the closed root. axe cannot decide contrast there (it reports "needs
 * review"), so this does the arithmetic on the computed colours: each text element's colour is
 * blended with its opacity, and the background is the nearest opaque ancestor background.
 * Inactive controls (`aria-disabled`, `disabled`) are exempt, as the success criterion says.
 */
export async function contrastProblemsInRoot(target: Page | Frame): Promise<ContrastProblem[]> {
  const found = await tb(target).evalIn<ContrastProblem[]>(
    null,
    `function () {
      const parse = (css) => {
        const m = css.match(/rgba?\\(([^)]+)\\)/);
        if (!m) return [0, 0, 0, 0];
        const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
        return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
      };
      const over = (top, under) => {
        const a = top[3];
        return [0, 1, 2].map((i) => top[i] * a + under[i] * (1 - a)).concat([1]);
      };
      const lum = ([r, g, b]) => {
        const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };
      const dark = matchMedia('(prefers-color-scheme: dark)').matches;
      const page = dark ? [18, 18, 18, 1] : [255, 255, 255, 1];
      const out = [];
      const walk = (el) => {
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return;
        const own = Array.from(el.childNodes).filter((n) => n.nodeType === 3 && n.textContent.trim() !== '');
        const rect = el.getBoundingClientRect();
        const inactive = el.closest('[aria-disabled="true"],[disabled]') !== null;
        if (own.length > 0 && rect.width > 1 && rect.height > 1 && !inactive) {
          let opacity = 1;
          const layers = [];
          for (let n = el; n; n = n.parentElement) {
            opacity *= Number(getComputedStyle(n).opacity);
            layers.push(parse(getComputedStyle(n).backgroundColor));
          }
          let bg = page;
          for (const layer of layers.reverse()) bg = layer[3] > 0 ? over(layer, bg) : bg;
          const fg = parse(style.color);
          const text = over([fg[0], fg[1], fg[2], fg[3] * opacity], bg);
          const l1 = lum(text), l2 = lum(bg);
          const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
          const size = parseFloat(style.fontSize);
          const bold = Number(style.fontWeight) >= 700;
          const need = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5;
          if (ratio < need) out.push({
            text: own.map((n) => n.textContent.trim()).join(' ').slice(0, 40),
            color: style.color, background: 'rgb(' + bg.slice(0, 3).map(Math.round).join(', ') + ')',
            ratio: Math.round(ratio * 100) / 100,
          });
        }
        for (const child of el.children) walk(child);
      };
      for (const child of this.children) walk(child);
      return out;
    }`,
  );
  return found ?? [];
}
