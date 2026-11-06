# Design preview

Every Clavis screen in a normal browser tab, with live hot updates, so the UI can be redesigned
while watching it. Development only: `dev/` is not an entrypoint, so WXT never bundles it and it
is not in the extension build or ZIP.

## Open it

1. Start the usual dev server: `npm run dev` (WXT, port 3000).
2. Open <http://localhost:3000/dev/preview/index.html> in any browser tab (not the extension
   Chrome window WXT launches; a plain tab is fine).

Edit any `.css` or `.tsx` under `components/` or `entrypoints/` and the frame updates in place
(React Fast Refresh and CSS hot updates, no reload, state kept). Editing `public/_locales/en/messages.json`
updates strings on the next render.

## What is there

Left nav, one iframe per screen (`dev/preview/screen.html?screen=...`), so page CSS never leaks
between screens:

| Screen         | Notes                                                                                                                                                                                                                                                                                                                                                                 |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Settings       | the options page                                                                                                                                                                                                                                                                                                                                                      |
| Onboarding 1-7 | each step; the frame clicks through to the step for you                                                                                                                                                                                                                                                                                                               |
| Popup          | 360 x 600 frame                                                                                                                                                                                                                                                                                                                                                       |
| Practice page  | real selection controller, toolbar and card inside the demo article: select text to try it                                                                                                                                                                                                                                                                            |
| Side panel     | 400 px frame, with a sample hand-off, and the "nothing to show" state                                                                                                                                                                                                                                                                                                 |
| PDF reader     | empty, and fixtures from `tests/fixtures/pdf`: one page, columns, links, image-only, password prompt, corrupt file                                                                                                                                                                                                                                                    |
| Web page       | the real toolbar view and explanation card with their real CSS, one specimen per state (toolbar idle, starting, playing, finished, online voice, no voice, only online voices, voice failed, too long, trimmed, notice; card loading, answer, long answer, disclosure, no key, invalid key, rate limited, network, timeout, model unavailable, bad format, cancelled) |

Header controls: **Scenario**, **System appearance** and a single **Dark mode** toggle (forces the scheme in every frame without
a reload, see `scheme.ts`), **Reload frame** (icon button), **Open alone** (the frame as its own tab).

## Scenarios (`?state=`)

`connected` (default), `fresh` (nothing set up), `no-key`, `key-invalid`, `disclosure`,
`rate-limited`, `offline`, `timeout`, `bad-format`, `no-voice`, `online-only`, `no-access`.
Other parameters on `screen.html`: `theme=light|dark`, `delay=<ms>` (how long Explain takes,
default 400), `handoff=none` (empty side panel), `pdf=<fixture name>` and `step=<1-7>`.

## What is faked

`fake-chrome.ts` installs `chrome` / `browser` before the app loads. It is a hand-written stub, not
the real background router:

- `i18n.getMessage` reads `public/_locales/en/messages.json` with Chrome's placeholder rules.
- `runtime.sendMessage` answers per message type with canned replies that validate against the real
  Zod schemas in `lib/contracts/**` (settings, key status, models, voices, site access, side panel
  hand-off, Explain for every mode, Listen). Settings, key, onboarding and permission changes
  are kept in memory for the life of the frame, so saving works; they are lost on reload.
- Explain results are made-up text (a real dictionary entry only for "ephemeral").
- `tabs.create`, `openOptionsPage`, `OPEN_SETTINGS`, `OPEN_SIDE_PANEL`, and links to extension pages
  switch the gallery frame or navigate a standalone preview tab, keeping its scenario and theme.
  Settings deep links keep their section anchor; external web links open a new tab. The preview
  keeps its popup tab open so its buttons can navigate.
- The popup's **Explain on this page** opens the practice screen, where you can select sample
  text and try Explain. It does not claim that text was already selected on the previous tab.
  `storage`, `permissions`, `tts`, `sidePanel`,
  `contextMenus`, `scripting` are working or no-op stubs; no audio is ever played.

## Limits

- No real Groq call, key storage, service worker, content script injection, side panel or popup
  chrome: sender checks and the background's own logic are not exercised.
- The popup always believes it is on a Wikipedia article tab.
- PDF.js runtime data (CJK cmaps, standard fonts, ICC profiles, wasm decoders) is copied into the
  extension build only, so those PDFs render without them here. Latin text PDFs render fine.
- The Web page screen draws the toolbar in the page flow (the real one is a fixed popover in a
  closed shadow root placed by `components/tooltip/toolbar.ts`), so placement is not previewed.
- Forcing light/dark rewrites `prefers-color-scheme` media rules; `forced-colors` and
  `prefers-reduced-motion` are not forced (use browser dev tools emulation).
- The self-check of the canned replies is the schema validation done when each page asks for them:
  a reply that stops matching the contracts shows up as the page's own "bad reply" error.
