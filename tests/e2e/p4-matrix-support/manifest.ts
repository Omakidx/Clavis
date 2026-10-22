import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type Kind = 'word' | 'phrase' | 'sentence' | 'passage';
export type Method = 'dblclick' | 'drag' | 'triple' | 'keyboard';

export interface Target {
  id: string;
  /** Expected classification: one kind, or the acceptable kinds when the heuristic is ambiguous. */
  kind: Kind | Kind[];
  /** Expected selected text (normalised). Absent for paragraph targets. */
  text?: string;
  /** Unique string in the page text that contains `text`. */
  context?: string;
  /** Paragraph targets: selector of the block (triple click). */
  paragraph?: string;
  /** Paragraph targets: unique start of the paragraph text. */
  startsWith?: string;
  /** Name of the frame (see Fixture.frames) that holds the target. */
  frame?: string;
  methods?: Method[];
  forwardKey?: ForwardKey;
  overLimit?: boolean;
  note?: string;
}

export type ForwardKey = 'ArrowRight' | 'ArrowLeft' | 'ArrowDown';

export interface Fixture {
  id: string;
  /** Path (and hash) served by the matrix server. */
  file: string;
  title: string;
  layout: string;
  dir?: 'rtl' | 'vertical';
  forwardKey?: ForwardKey;
  viewport?: { width: number; height: number };
  /** Selector that must exist before selecting (dynamically inserted content). */
  ready?: string;
  /** A modal dialog is open: Escape would close it, reset selection by other means. */
  modal?: boolean;
  frames?: Record<string, string>;
  targets: Target[];
}

export interface NegativeTarget {
  id: string;
  description: string;
  selector?: string;
  kind?: Kind;
  text?: string;
  context?: string;
  expect: 'toolbar' | 'none';
}

export interface MatrixManifest {
  version: number;
  support: string[];
  fixtures: Fixture[];
  negatives: { fixture: string; targets: NegativeTarget[] };
}

const manifestPath = fileURLToPath(
  new URL('../../fixtures/web/matrix/index.json', import.meta.url),
);

export const manifest: MatrixManifest = JSON.parse(
  readFileSync(manifestPath, 'utf8'),
) as MatrixManifest;

export const DEFAULT_METHODS: Record<Kind, Method[]> = {
  word: ['dblclick', 'keyboard'],
  phrase: ['drag', 'keyboard'],
  sentence: ['drag', 'keyboard'],
  passage: ['triple'],
};

export function methodsFor(target: Target): Method[] {
  if (target.methods !== undefined) return target.methods;
  if (target.paragraph !== undefined) return ['triple'];
  const kind = Array.isArray(target.kind) ? (target.kind[0] as Kind) : target.kind;
  return DEFAULT_METHODS[kind];
}

export function acceptableKinds(target: Target): Kind[] {
  return Array.isArray(target.kind) ? target.kind : [target.kind];
}

/**
 * The oracle for "what the user selected": whitespace runs (including NBSP and newlines)
 * collapse to one space, invisible soft hyphen / zero-width space / BOM are dropped, and the
 * result is trimmed (requirements 4.2, FR-011).
 */
export function normalize(raw: string): string {
  return raw
    .replace(/[\u00ad\u200b\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
