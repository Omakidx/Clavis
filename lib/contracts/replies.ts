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
