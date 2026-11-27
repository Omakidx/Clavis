import { z } from 'zod';
import { ChatView, DocumentView, HighlightView, WordView } from './endpoints';
import { EpochMs } from './primitives';

// Account export (docs/clavis-sync-design.md §8.5). One JSON shape for the server ZIP (`clavis-export.json`) and the
// signed-out local export: the local export omits `account` and `documents[].file`, so both are optional here.

/** ZIP entry name of a stored PDF. */
export const exportPdfPath = (fingerprint: string): string => `pdfs/${fingerprint}.pdf`;

export const ExportWord = z.strictObject({ ...WordView.shape, messages: z.array(ChatView) });
export type ExportWord = z.infer<typeof ExportWord>;

export const ExportDocument = z.strictObject({
  ...DocumentView.shape,
  highlights: z.array(HighlightView),
  /** `pdfs/<fingerprint>.pdf` inside the ZIP; null when the document has no stored file (or it was missing). */
  file: z
    .string()
    .regex(/^pdfs\/[0-9a-f]{64}\.pdf$/)
    .nullable()
    .optional(),
});
export type ExportDocument = z.infer<typeof ExportDocument>;

export const ClavisExport = z.strictObject({
  format: z.literal('clavis-export'),
  version: z.literal(1),
  /** ISO 8601 instant. */
  exportedAt: z.iso.datetime(),
  /** Absent in the signed-out local export. */
  account: z
    .strictObject({
      email: z.string().max(320),
      displayName: z.string().max(200).nullable(),
      createdAt: EpochMs,
    })
    .optional(),
  savedWords: z.array(ExportWord),
  documents: z.array(ExportDocument),
});
export type ClavisExport = z.infer<typeof ClavisExport>;
