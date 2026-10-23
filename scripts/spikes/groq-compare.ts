/**
 * Spike A model comparison, superseded in Phase 5 by scripts/eval/explain-eval.ts (every mode,
 * more fixtures, capability and token-budget reporting). Kept so the documented command still
 * works: it runs the old scope (mode `core` only) with the same flags.
 *
 *   GROQ_API_KEY=... npx tsx scripts/spikes/groq-compare.ts --runs 3
 *
 * Results go to docs/decisions/p5-eval-results/ (see docs/decisions/p5-prompt-eval.md).
 */
import { main } from '../eval/explain-eval';

void main(['--modes', 'core', ...process.argv.slice(2)]);
