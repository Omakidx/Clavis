# Clavis v1 backlog and requirement checklist

**Created:** 2026-10-22 (Phase 0) · **Owner of requirement text:** [requirements.md](requirements.md) — this file only tracks order and status.

Use this file to track progress. Update the **Status** column as work lands (`Not started` → `In progress` → `Done` → `Verified`). "Verified" means the acceptance test in `requirements.md` passed and the evidence is linked.

## 1. Delivery order

Work in this order. Phases 3, 4 and 7 can overlap once Phase 2 closes; see the dependency graph in [execution-phases.md](execution-phases.md#workstream-dependencies).

| # | Item | Phase | Blocks | Status |
| --- | --- | --- | --- | --- |
| 1 | WXT scaffold in `Clavis/`, strict TS, lint, Vitest, CI, `_locales`, bundle-size report | 1 | Everything | Done |
| 2 | Zod contracts: messages, `SelectionSnapshot`, `ExplainRequest`, `ExplainResult` | 1 | 6, 8, 9 | Done |
| 3 | Spike A — Groq from background + model comparison (D-09) | 2 | 8 | Done; model comparison awaits the user's key |
| 4 | Spike B — optional permission flow, runtime registration, toolbar loading measurement (D-02, D-08) | 2 | 6, 7 | Done (option c chosen) |
| 5 | Spike C — PDF.js viewer components (D-06) | 2 | 10 | Done |
| 6 | Spike D — `chrome.tts` on Linux + offscreen fallback (D-07) | 2 | 9 | Done; voice check awaits the user |
| 7 | Onboarding, disclosure, site access, key lifecycle, settings | 3 | 8 | Done |
| 8 | Selection observer + toolbar on both injection paths | 4 | 8, 9 | Done |
| 9 | Core Explain + Must tabs (roots, related words, simplify) | 5 | 11 | Not started |
| 10 | Listen / `SpeechService` | 6 | 11 | Not started |
| 11 | PDF reader | 7 | 11 | Not started |
| 12 | Unified UX, side panel, copy; Should tabs if on schedule | 8 | 13 | Not started |
| 13 | QA, security, performance, privacy verification | 9 | 14 | Not started |
| 14 | Store package, privacy policy publish, submission | 10 | — | Not started |

## 2. Requirement checklist

### Must (launch-blocking)

| ID | Short name | Phase | Status |
| --- | --- | --- | --- |
| FR-001 | Welcome page once per install | 3 | Done |
| FR-002 | Data disclosure before first AI use | 3 | Done |
| FR-003 | Link to Groq key creation | 3 | Done |
| FR-004 | Test key from privileged context | 3 | Done |
| FR-005 | Model choice from available models | 3 | Done |
| FR-006 | Language, reading level, tooltip, TTS preferences | 3 | Done |
| FR-007 | Change/revoke key; persistent vs session | 3 | Done |
| FR-009 | Optional all-sites access, grant/revoke | 3 | Done |
| FR-010 | Detect selections on granted sites | 4 | Done |
| FR-011 | Word/phrase/sentence/passage classification | 4 | Done |
| FR-012 | Toolbar placement | 4 | Done |
| FR-013 | Listen + Explain primary actions | 4 | Done |
| FR-014 | Dismiss behavior | 4 | Done |
| FR-015 | Respect site permissions/exclusions | 4 | Done |
| FR-016 | Accessibility of toolbar | 4 | Done |
| FR-017 | No transmission on highlight | 4 | Done |
| FR-018 | Context menu / toolbar icon without site access | 4 | Done |
| FR-020 | Speak selected word | 6 | Not started |
| FR-021 | Speak selected sentence | 6 | Not started |
| FR-022 | Normal/slow, Stop, Replay | 6 | Not started |
| FR-023 | No-voice detection and message | 6 | Not started |
| FR-024 | Speak only selected text | 6 | Not started |
| FR-030 | Core explanation (one request) | 5 | Not started |
| FR-031 | Definition (in core) | 5 | Not started |
| FR-032 | Examples (in core) | 5 | Not started |
| FR-033 | Roots tab | 5 | Not started |
| FR-034 | Related words tab | 5 | Not started |
| FR-035 | Simplify tab | 5 | Not started |
| FR-038 | On-demand calls, per-selection cache | 5 | Not started |
| FR-039 | Loading/error/rate-limit states | 5 | Not started |
| FR-040 | Model capability checks | 5 | Not started |
| FR-041 | Plain-text output only | 5 | Not started |
| FR-050 | Open local PDF (picker, drag-drop) | 7 | Not started |
| FR-051 | Render with PDF.js viewer components | 7 | Not started |
| FR-052 | Aligned selectable text layer | 7 | Not started |
| FR-053 | Same Listen/Explain in PDFs | 7 | Not started |
| FR-054 | Page navigation, zoom, fit-width | 7 | Not started |
| FR-055 | PDF error states | 7 | Not started |
| FR-056 | No interception of Chrome's PDF viewer | 7 | Not started |
| FR-059 | Virtualized pages | 7 | Not started |
| FR-070 | Key only in trusted contexts | 3 | Done |
| FR-071 | Key storage caveats; session mode | 3 | Done |
| FR-072 | Revoked key / transient errors | 5 | Done (key routes and AI_EXPLAIN) |
| FR-073 | No content/key in logs | 1–9 | In progress (metadata-only logger; lint bans console.log) |
| FR-074 | Public privacy policy + store disclosures | 10 | Draft written ([privacy-policy.md](privacy-policy.md)) |
| FR-075 | All executable code packaged locally | 1–10 | In progress (ZIP audit enforces it) |
| FR-076 | Minimum permissions with justification | 1–10 | In progress (ZIP audit checks the allowlist) |
| FR-077 | Works from production ZIP | 9–10 | Not started |

### Should

| ID | Short name | Phase | Status |
| --- | --- | --- | --- |
| FR-008 | Rerun tutorial from Settings | 8 | Done (rerun tutorial in Settings) |
| FR-019 | Copy answer | 8 | Not started |
| FR-025 | Voice chooser | 6 | Not started |
| FR-036 | Grammar tab | 8 | Not started |
| FR-037 | Translate tab | 8 | Not started |
| FR-042 | Side panel for long answers | 8 | Not started |
| FR-043 | Opt-in cross-selection cache | 8 | Not started |
| FR-057 | PDF find-in-document | 7 | Not started |
| FR-078 | Reset / clear all data | 8 | Done |

### Could / Later / Won't

FR-026 (IPA and recorded audio) is a Could. FR-058 (remote PDF URLs) and FR-079 (vocabulary export) are Later. FR-060 (OCR, annotation, full-document translation) is Won't. None are scheduled for v1.

## 3. Risk register

| ID | Risk | Likelihood | Impact | Mitigation | Owner phase |
| --- | --- | --- | --- | --- | --- |
| R-01 | `chrome.tts` has no voice on the Linux dev machine, so Listen can't be shown working locally | Confirmed | Medium | Install `speech-dispatcher` + `espeak-ng` for the positive path; test the offscreen fallback (D-07); keep the no-voice message honest | 2 |
| R-02 | Voices on Windows/macOS never checked by a person | High | Medium | Automated non-voice E2E on CI; one manual tester pass before public listing (D-14); no voice claims until then | 9–10 |
| R-03 | First toolbar after page load misses 150 ms because UI code must load | Low (mitigated) | Medium | Spike B: bundled Preact toolbar measured 60 ms p95 (D-08); re-measure on a quiet machine | 2 |
| R-04 | Reasoning models are slow or truncate JSON on the free tier | Medium | High | Spike A model comparison and token budgets (D-09) | 2 |
| R-05 | Users decline site access and find the right-click path hard to discover | Medium | Medium | Clear onboarding copy (D-16), toolbar-icon fallback, help text in Phase 8 | 3, 8 |
| R-06 | Chrome Web Store review is slow or rejects the optional all-sites access | Medium | High | Accurate justifications; privacy policy published; trusted-tester release first | 10 |
| R-07 | Groq changes model IDs or free-tier limits | Medium | Medium | Model list fetched at runtime; clear "choose another model" path; recheck before release | 5, 11 |
| R-08 | No GitHub repo / Pages yet for the privacy policy URL | Low | High (blocks submission) | Create repo and enable Pages before Phase 10 (D-15) | 10 |
| R-09 | PDF.js viewer components change API between versions | Medium (seen in Spike C) | Medium | Pin exact version; keep worker, core and viewer identical; re-read release notes on every bump | 7 |
| R-10 | Store ZIP grew to ~2.5 MB with the PDF engine and data files | Medium | Low | Reader size budgets in Phase 7; drop CMaps if CJK without embedded fonts is out of scope | 7 |
| R-11 | Observer budget could fill up as Phases 5–6 add actions | Medium | Medium | Budget raised to 18 KB (D-20) with latency headroom; the explanation card still loads separately on the first Explain (Phase 5) | 5 |
