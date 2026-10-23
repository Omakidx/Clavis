# Spike A: Groq BYOK from the trusted extension context

Status: tooling and no-key verification done 2026-10-22; **model comparison pending the user's run with their own key** (fills D-09).

## Goal

Prove the technical assumptions behind "the background service worker calls Groq with the user's own key" and choose default models (decision D-09) from measurements instead of guesses ([execution-phases.md](../execution-phases.md) Phase 2, Spike A).

## What was built

| Piece | Location |
| --- | --- |
| Groq client: `listModels`, `explain` (mode `core`), typed errors, capability table, strict-schema derivation, `core` prompt | `lib/ai/` |
| Unit tests (offline, mocked `fetch`) | `tests/unit/ai/` |
| Packaged-extension reachability test | `tests/e2e/spike-a-groq.spec.ts` |
| Model comparison script, fixtures, offline mock | `scripts/spikes/groq-compare.ts`, `scripts/spikes/fixtures/` |

The client takes `apiKey` and an `AbortSignal` as parameters and stores nothing. It is the only code that puts the key in an `Authorization` header; the body, logs and error messages never contain it.

## Method and what was verified without a key

### 1. Packaged worker reaches api.groq.com (E2E)

`tests/e2e/spike-a-groq.spec.ts` loads the built extension (`WXT_OUT_DIR=.output-spike-a`) in Chromium and evaluates `fetch` **inside the MV3 service worker** with `Authorization: Bearer gsk_TEST_invalid_key_for_cors_check`:

- manifest `host_permissions` is exactly `https://api.groq.com/*`; `optional_host_permissions` still holds the site patterns (no all-sites grant at install);
- `GET /openai/v1/models` returns **HTTP 401** (readable response, so not blocked by CORS or the host check);
- `POST /openai/v1/chat/completions` with a JSON body returns **HTTP 401** as well.

Result: passed (3/3) on Linux, 2026-10-22. Only a fake key is used; nothing secret is involved. The spec skips with a reason when `api.groq.com` is unreachable.

**Finding: the host permission is not what makes the call possible today.** A "same fetch from an ordinary web page is CORS-blocked" contrast was attempted and is not observable: `api.groq.com` answers the preflight with `access-control-allow-origin: *` and allows `authorization` and `content-type`, so a normal https page can also read the 401. That contrast test was therefore dropped. The narrow host permission is still right to keep: it makes the worker independent of Groq's CORS policy (which can change), keeps the grant minimal and auditable, and is already allowlisted in `scripts/expected-permissions.json`.

### 2. Error mapping and response handling (unit tests)

Mocked `fetch`, no network. Covered: valid JSON; `reasoning` field present and ignored; content not JSON; JSON failing the schema; empty content; truncation (`finish_reason: length`); 400 unsupported `response_format` retried **once** in `json_object` mode (and not looped, and not triggered by unrelated 400s); 401; 403; 404; 408; 429 with `Retry-After` in seconds and as HTTP-date (clamped to 1 h); 500/503; network `TypeError`; deadline timeout; caller abort; `listModels` parsing and errors. Asserted: `Authorization` is `Bearer <key>`, and the key, context text and `Bearer` never appear in thrown messages or logger output.

| Situation | `ErrorCode` |
| --- | --- |
| 401, 403 | `INVALID_API_KEY` |
| 400, 422 (invalid request / unsupported option or model) | `MODEL_UNAVAILABLE` ("Choose another model", requirements §7) |
| 404 | `MODEL_UNAVAILABLE` |
| 408, deadline reached | `TIMEOUT` |
| 429 | `RATE_LIMITED` with `retryAfterMs` (clamped 0 to 3,600,000) |
| 5xx, network failure, other statuses | `NETWORK_ERROR` |
| Bad body, empty content, truncation, not JSON, schema failure, 400 `json_validate_failed` | `INVALID_RESPONSE` (with a diagnostic `stage`) |
| Caller aborted | `REQUEST_CANCELLED` |

### 3. Groq API behaviour taken from the documentation (not yet confirmed live)

Consulted 2026-10-22 (console.groq.com/docs/structured-outputs, /reasoning). Treat as assumptions until the comparison run confirms them; the script records what the account actually does.

- `response_format: {type: "json_schema", json_schema: {name, strict, schema}}`. Strict mode is documented for `openai/gpt-oss-20b` and `openai/gpt-oss-120b` (plus a few others); best-effort (`strict: false`) also for `openai/gpt-oss-safeguard-20b`.
- Strict mode requires every property in `required`, `additionalProperties: false` on every object, and optional fields expressed as nullable unions (`["string","null"]`). `lib/ai/schema.ts` derives this from `coreOutputSchema` without changing the contract; `null` values are dropped before Zod validation.
- `json_object` mode guarantees valid JSON syntax only, and the prompt must mention JSON. The prompt spells out the keys for that mode.
- `reasoning_effort`: `low|medium|high` for the gpt-oss models. For gpt-oss the reasoning arrives in `message.reasoning`; the client reads only `choices[0].message.content`.
- Unknown: the exact status/message when `response_format` is unsupported (the client matches a 400 whose message mentions `response_format`, `json_schema`, structured outputs or JSON mode), and whether strict mode rejects length keywords (`minLength`/`maxLength`) that Zod emits. Either case surfaces in the results as a json_schema fallback with the provider error identifiers.

## How to run the comparison (user, with your own key)

Create a key at <https://console.groq.com/keys>. Do not paste it into chat, a file or a commit. From the repo root:

```bash
GROQ_API_KEY=gsk_... npx tsx scripts/spikes/groq-compare.ts --runs 3
```

(Prefix the line with a space or use `read -rs GROQ_API_KEY && export GROQ_API_KEY` to keep the key out of shell history.)

- The key is read only from `GROQ_API_KEY`, must start with `gsk_`, and is never printed or written. Progress goes to stderr.
- Dry run without a key: `npx tsx scripts/spikes/groq-compare.ts --mock` (offline fake API; outputs are named `*-mock-*` and marked as mock data).
- Models: `openai/gpt-oss-20b` and `openai/gpt-oss-120b` when listed, plus one fast non-reasoning model chosen from your account's list by id heuristics (prefers an "instant", then small, then speed-named model; it prints which one and why). Absent models are skipped.
- Cost and limits: default 3 models x 7 cases x 3 runs = 63 requests, hard cap `--max-requests 63`. Fallbacks and 429 retries count toward the cap, so the last few trials may be skipped; add `--max-requests 75` to complete a full run. A 429 is retried (at most twice per trial) after `Retry-After`; a wait longer than `--max-wait-seconds` (default 60), a third 429, a rejected key, or repeated network errors stop the run politely and still write partial results.
- Other flags: `--runs N` (1 to 10), `--max-completion-tokens N` (override the per-model budget, useful to test truncation).

Output goes to `docs/decisions/spike-a-results/`:

- `<UTC timestamp>-results.json`: every trial (latency, requests used, response mode and fallback, token usage including reasoning tokens when reported, JSON/schema validity, parsed answer, error code/stage/status) plus per-model summaries.
- `<UTC timestamp>-summary.md`: the tables below plus the answers to review.

Review the JSON before committing it: it contains only fixture text and model answers, never the key or headers.

## How to read the results

- **Per-model table:** p50/p95 latency of successful trials (nearest rank; with about 21 trials per model, p95 is nearly the slowest run, so repeat if a result is borderline), mean completion tokens (reasoning tokens included for gpt-oss, which count against `max_completion_tokens`), mean reasoning tokens, JSON validity, schema validity, and how often `json_object` was used because `json_schema` was rejected. After the first rejection for a model, later trials start in `json_object` directly (`memoizedFallback`), which is also what Phase 5 should cache per model.
- **Truncated** must be 0. A non-zero count means the completion budget is too small for the reasoning plus the answer; raise `max_completion_tokens` for that model.
- **Obeyed injection** must be 0 (heuristic: the title or summary is just the injected marker). Read the injection answer anyway.
- **Observed capabilities:** whether `json_schema` was accepted and whether `reasoning_effort: low` was sent without a 400. If a gpt-oss model falls back, check the recorded provider error type and code; the likely cause is a schema keyword rather than the model, and `lib/ai/schema.ts` can strip it.
- **Answers section:** read the `bank` (both senses), `broke the ice` and injection answers against the "Check" line printed above each.

## Decision criteria for D-09

A model is acceptable when all of the following hold:

1. Schema validity is at least 95% over its trials, with 0 truncations.
2. `bank` is resolved correctly in both contexts, the idiom is explained figuratively, and the injection selection is explained as text and not obeyed.
3. Latency p95 is tolerable for an interactive tooltip (record the number; no hard bound is set before seeing data).

Choose **quick** as the acceptable model with the lowest p95. Choose **deep** as the best-quality acceptable model (normally `openai/gpt-oss-120b`), and note if deep is not meaningfully better. Then set per-mode `max_completion_tokens` from the measured completion and reasoning token means with headroom, update `MODEL_CANDIDATES` and the capability table, and confirm the free-tier limits shown on <https://console.groq.com/docs/rate-limits> without hard-coding promises.

## Results and decision

Settled by the Phase 5 evaluation run on 2026-10-23, which covered `core` plus the lazy modes on the same candidate models: **default model `openai/gpt-oss-20b`** (D-09). Full table, manual review of flags and reasoning: [p5-prompt-eval.md](p5-prompt-eval.md#results-and-decision).

## Follow-ups for later phases

- Phase 3/5: wire `groqProvider.explain` into the background router; validate the request at the boundary as the client already does, and map `GroqError` to `ErrorEnvelope` with `toEnvelope()`.
- Phase 5: add prompts and bounded schemas for the other five modes; cache the per-model `json_schema` support decision (the client currently re-tries `json_schema` on every call unless the caller passes `responseMode`).
- Phase 5: honour `retryAfterMs` in the UI wait state and add bounded exponential backoff with jitter for 5xx (the client deliberately does not retry on its own).
- Consider `include_reasoning: false` for gpt-oss to shrink responses once confirmed accepted with structured outputs (not sent today, to avoid an unverified parameter).
