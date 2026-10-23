import { z } from 'zod';
import { LIMITS, MESSAGE_VERSION } from '../config/constants';
import { EXPLAIN_MODES, explainModeSchema, explainResultSchema } from './explain';
import { languageTagSchema } from './primitives';
import { selectionSnapshotSchema } from './selection';

/**
 * The side panel hand-off (FR-042, Phase 8). The card (in a web page, the practice page or the
 * PDF reader) sends what it has to the service worker, which holds it in MEMORY keyed by tab and
 * serves it to that tab's side panel. Nothing here ever carries a key or reaches storage.
 *
 * Everything in it is untrusted text: the selection comes from a web page, the results from a
 * model. The panel renders it as text nodes only (D-10) and the parser bounds it (field limits of
 * the result schema, `LIMITS.maxHandoffBytes` overall).
 */

const v = z.literal(MESSAGE_VERSION);

/**
 * A loaded explanation without `selectedText`: the panel already has the selection in the
 * snapshot, and leaving it out keeps the hand-off well under its size bound.
 */
export const handoffResultSchema = explainResultSchema.omit({ selectedText: true });
export type HandoffResult = z.infer<typeof handoffResultSchema>;

export const sidePanelHandoffSchema = z
  .strictObject({
    /** The selection exactly as the card sent it to Groq (text and bounded context). */
    snapshot: selectionSnapshotSchema,
    /** The tabs the card has loaded; the panel starts from these and requests nothing on open. */
    results: z.array(handoffResultSchema).min(1).max(EXPLAIN_MODES.length),
    /** The tab the user was looking at. */
    active: explainModeSchema.optional(),
    /** The language the Translate tab used, so a result is never shown under another language. */
    targetLanguage: languageTagSchema.optional(),
  })
  .superRefine((handoff, ctx) => {
    const seen = new Set<string>();
    for (const [index, result] of handoff.results.entries()) {
      if (seen.has(result.mode)) {
        ctx.addIssue({
          code: 'custom',
          path: ['results', index, 'mode'],
          message: 'Each mode may appear once',
        });
      }
      seen.add(result.mode);
    }
  });
export type SidePanelHandoff = z.infer<typeof sidePanelHandoffSchema>;

/** Card / practice page / reader → background: show this explanation in the side panel. */
export const openSidePanelMessageSchema = z.strictObject({
  v,
  type: z.literal('OPEN_SIDE_PANEL'),
  handoff: sidePanelHandoffSchema,
});

/** A tab id as Chrome reports it. The panel learns its own from the query of its path. */
export const tabIdSchema = z.number().int().nonnegative().max(2_147_483_647);

/** Side panel → background: what is waiting for this tab? */
export const getSidePanelStateMessageSchema = z.strictObject({
  v,
  type: z.literal('GET_SIDE_PANEL_STATE'),
  tabId: tabIdSchema,
});

/**
 * The side-panel routes are their OWN union: they are the only routes allowed a message larger
 * than `LIMITS.maxMessageBytes`, so the public parser must never be able to accept them.
 */
export const sidePanelMessageSchema = z.discriminatedUnion('type', [
  openSidePanelMessageSchema,
  getSidePanelStateMessageSchema,
]);
export type SidePanelMessage = z.infer<typeof sidePanelMessageSchema>;

/** `data` of a successful OPEN_SIDE_PANEL reply. */
export const openSidePanelResultSchema = z.strictObject({ opened: z.literal(true) });
export type OpenSidePanelResult = z.infer<typeof openSidePanelResultSchema>;

/**
 * `data` of a successful GET_SIDE_PANEL_STATE reply. `handoff: null` means nothing is held for
 * the tab: the service worker restarted, the tab navigated, or the panel was opened by hand.
 * `revision` counts hand-offs of this tab, so the panel can tell a new one from the one it shows.
 */
export const sidePanelStateSchema = z.strictObject({
  revision: z.number().int().nonnegative(),
  handoff: sidePanelHandoffSchema.nullable(),
});
export type SidePanelState = z.infer<typeof sidePanelStateSchema>;

/**
 * Background → panel (runtime broadcast, never any text): the hand-off of `tabId` changed. The
 * panel for that tab then asks again with GET_SIDE_PANEL_STATE.
 */
export const sidePanelUpdatedMessageSchema = z.strictObject({
  v,
  type: z.literal('SIDE_PANEL_UPDATED'),
  tabId: tabIdSchema,
  revision: z.number().int().nonnegative(),
});
export type SidePanelUpdatedMessage = z.infer<typeof sidePanelUpdatedMessageSchema>;

/** Why a side-panel message was rejected (same shape as the other parsers). */
export type SidePanelParseResult =
  | { ok: true; message: SidePanelMessage }
  | { ok: false; reason: 'too_large' | 'unserializable' | 'invalid' };

/** Never-throwing parser for the side-panel routes, with the larger size bound. */
export function parseSidePanelMessage(input: unknown): SidePanelParseResult {
  let size: number;
  try {
    const json = JSON.stringify(input);
    if (json === undefined) return { ok: false, reason: 'unserializable' };
    size = new TextEncoder().encode(json).length;
  } catch {
    return { ok: false, reason: 'unserializable' };
  }
  if (size > LIMITS.maxHandoffBytes) return { ok: false, reason: 'too_large' };
  const result = sidePanelMessageSchema.safeParse(input);
  return result.success ? { ok: true, message: result.data } : { ok: false, reason: 'invalid' };
}
