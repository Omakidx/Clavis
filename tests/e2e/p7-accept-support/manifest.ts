import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Outcome the READER is expected to reach after opening a fixture (the end state, once any
 * password prompt has been answered). `a-or-b` means both are acceptable and a crash, a blank
 * reader or a hang is not.
 */
export type ExpectedState =
  | 'ready'
  | 'password-required'
  | 'image-only'
  | 'image-only-or-ready'
  | 'error-corrupt'
  | 'error-unsupported'
  | 'ready-or-corrupt'
  | 'ready-or-unsupported';

export interface LineInfo {
  page: number;
  /** One visual line of text as authored (or, for `oracle: 'pdfjs'`, as PDF.js itself extracts it). */
  text: string;
  rtl?: boolean;
  oracle?: 'pdfjs';
  /** The PDF's text equals the visual text only after NFKC normalisation (Kangxi radical code points). */
  nfkc?: boolean;
}

export interface AcceptEntry {
  file: string;
  description: string;
  producer: string;
  command?: string;
  bytes: number;
  sha256: string;
  /** Page count as PDF.js reports it; null when PDF.js cannot open the file without a password. */
  pages: number | null;
  state: ExpectedState;
  lines: LineInfo[];
  properties?: Record<string, unknown>;
  password?: string;
  ownerPassword?: string;
  fonts?: string[];
  licenses?: string[];
  notes?: string;
}

export const acceptDir = fileURLToPath(new URL('../../fixtures/pdf/accept/', import.meta.url));

export const acceptPath = (file: string): string => path.join(acceptDir, file);

export const acceptManifest = (): AcceptEntry[] =>
  JSON.parse(readFileSync(acceptPath('manifest.json'), 'utf8')) as AcceptEntry[];

export function accept(file: string): AcceptEntry {
  const found = acceptManifest().find((e) => e.file === file);
  if (!found) throw new Error(`Unknown acceptance fixture ${file}`);
  return found;
}

/** Lines of one page, in authored order. */
export const pageLines = (entry: AcceptEntry, page: number): LineInfo[] =>
  entry.lines.filter((l) => l.page === page);
