import { z } from 'zod';
import { LIMITS } from '../config/constants';

/**
 * Shared building blocks for the contract schemas.
 *
 * Validation is NOT sanitization: strings are bounded plain text. Markup-looking
 * content is accepted as literal text and must only ever be rendered as text
 * nodes (D-10, FR-041).
 */

/** UUID (any RFC 4122 version) used for selection and request identifiers. */
export const idSchema = z.uuid();

/** BCP-47-ish language tag, bounded (e.g. `en`, `en-US`, `zh-Hant-TW`). */
export const languageTagSchema = z
  .string()
  .max(LIMITS.maxLanguageTagChars)
  .regex(/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,4}$/, 'Expected a BCP-47 language tag');

/** Model identifier such as `openai/gpt-oss-20b`. */
export const modelIdSchema = z.string().min(1).max(LIMITS.maxModelIdChars);

/** Non-empty, length-bounded plain-text string. */
export const boundedText = (max: number) => z.string().min(1).max(max);
