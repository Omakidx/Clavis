import { z } from 'zod';

/** Where the user chose to keep their Groq key (FR-007, FR-071). */
export const keyStorageSchema = z.enum(['local', 'session']);
export type KeyStorage = z.infer<typeof keyStorageSchema>;
