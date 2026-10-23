import type { SidePanelHandoff } from '../../lib/contracts';
import { blocksToText, resultBlocks, tabLabel } from '../explanation/model';
import type { Entry } from '../explanation/session';
import type { ExplainMode } from '../../lib/contracts';

/** One section as plain text for the clipboard: its name, then exactly what the section shows. */
export function sectionText(mode: ExplainMode, entry: Entry | undefined): string | null {
  if (entry?.status !== 'ready' || entry.result === null) return null;
  return `${tabLabel(mode)}\n${blocksToText(resultBlocks(entry.result))}`;
}

/** The selected text and every loaded section as plain text (no markup, FR-019 for the panel). */
export function allText(
  selected: string,
  tabs: readonly ExplainMode[],
  entries: Partial<Record<ExplainMode, Entry>>,
): string {
  const parts = tabs
    .map((mode) => sectionText(mode, entries[mode]))
    .filter((part): part is string => part !== null);
  return [selected, ...parts].join('\n\n');
}

/** Results of a hand-off as the session wants them (it keeps `selectedText` for the contract). */
export function handoffResults(handoff: SidePanelHandoff) {
  return handoff.results.map((result) => ({ ...result, selectedText: handoff.snapshot.text }));
}
