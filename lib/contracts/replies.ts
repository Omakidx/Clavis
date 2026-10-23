import { z } from 'zod';

/** `data` of a successful AI_CANCEL reply. */
export const aiCancelResultSchema = z.strictObject({
  /** Whether an in-flight request of the sender was actually aborted. */
  cancelled: z.boolean(),
});
export type AiCancelResult = z.infer<typeof aiCancelResultSchema>;

/** `data` of a successful CLEAR_ALL_DATA reply. */
export const clearAllDataResultSchema = z.strictObject({ cleared: z.literal(true) });
export type ClearAllDataResult = z.infer<typeof clearAllDataResultSchema>;

/** `data` of a successful LOAD_EXPLAIN_CARD reply: the card script is running in the sender's frame. */
export const loadExplainCardResultSchema = z.strictObject({ loaded: z.literal(true) });
export type LoadExplainCardResult = z.infer<typeof loadExplainCardResultSchema>;

/** `data` of a successful OPEN_SETTINGS reply. */
export const openSettingsResultSchema = z.strictObject({ opened: z.literal(true) });
export type OpenSettingsResult = z.infer<typeof openSettingsResultSchema>;
