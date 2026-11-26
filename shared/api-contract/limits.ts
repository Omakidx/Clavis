// Normative limits shared by the extension, the server and the dashboard (docs/clavis-sync-design.md §3.2, §5.4, §6).
export const LIMITS = {
  /** Largest stored PDF, 15 MiB (S-06). */
  maxFileBytes: 15_728_640,
  /** Per-account stored-PDF quota, 100 MiB (S-06). */
  quotaBytes: 104_857_600,
  maxWords: 5000,
  maxMessagesPerWord: 200,
  maxDocuments: 2000,
  maxHighlightsPerDocument: 200,
  maxPushChanges: 200,
  maxPullLimit: 1000,
  defaultPullLimit: 500,
  maxPageLimit: 100,
  defaultPageLimit: 50,
  /** JSON request bodies are limited to 512 KiB (the PDF upload is exempt). */
  maxJsonBodyBytes: 524_288,
  maxUserChatChars: 2000,
  maxChatChars: 4000,
  maxContextChars: 1000,
  maxSearchChars: 100,
} as const;

export type Limits = typeof LIMITS;
