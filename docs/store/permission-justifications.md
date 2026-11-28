# Chrome Web Store: permission justifications and data-use answers

> **Status:** draft for v1, checked against the code on 2026-10-23 (Phase 9 release audit). **Web Store submission is deferred:** v1.1.0 (the first release with Clavis Sync switched on) is distributed as a GitHub release ZIP that users install with **Load unpacked**, so nothing here is submitted yet. Keep these answers ready for a future submission and re-check them against the code then. Each answer goes into the matching field of the Chrome Web Store developer dashboard (Privacy tab). Keep it in step with [architecture.md §3](../architecture.md#3-extension-entry-points-and-message-routes) (permission table), [requirements.md §6](../requirements.md#6-permission-and-data-inventory) and the [privacy policy](../privacy-policy.md). If a permission changes, change all of them.
>
> **Clavis Sync (optional accounts).** Sections and rows marked **Effective when account sync ships** apply from v1.1.0, which has `FEATURES.accountSync` set to `true`; they are part of any store submission from then on, including the `identity` and `alarms` justifications. Source of truth for the new rows: [architecture.md §3](../architecture.md#3-extension-entry-points-and-message-routes) and [clavis-sync-design.md §7.1](../clavis-sync-design.md#71-manifest-permissions-and-lockstep-files).
>
> **Privacy policy URL.** The dashboard's "Privacy policy" field takes `https://clavis-api-production.up.railway.app/privacy` (the server renders [privacy-policy.md](../privacy-policy.md) there). It must equal `CLAVIS_PRIVACY_POLICY_URL` in `lib/ui-client/links.ts`.
>
> **Extension ID and the manifest key.** The GitHub release ZIP keeps the manifest `key` so its extension ID stays fixed (sign-in only works for IDs the server and Google know). A Web Store upload must not contain a `key`: strip it for that upload only (see ADR A-014 in [architecture.md](../architecture.md)). The Store assigns its own extension ID, which would then have to be added to the server's allowed extension IDs and to Google's OAuth client before sign-in works for Store installs.

Manifest being described (`wxt.config.ts`, built `manifest.json`): `permissions` = `storage`, `tts`, `scripting`, `activeTab`, `contextMenus`, `sidePanel`, `identity`, `alarms`; `host_permissions` = `https://api.groq.com/*`; `optional_host_permissions` = `http://*/*`, `https://*/*`. There are no static `content_scripts`, no `tabs`, `offscreen`, `webRequest` or `<all_urls>`. The Clavis sync server (`https://clavis-api-production.up.railway.app`) is **not** a host permission: the background reaches it under the server's CORS allowlist, and the release ZIP audit lists it as `allowedUrlHosts.corsNetwork`.

## Single purpose

Clavis helps you understand and pronounce text you select on web pages and in PDFs you open in Clavis. It explains the selection with an AI model (Groq, using your own API key) and reads it aloud with your computer's voices.

## Permission justifications

### storage

Saves your settings (explanation language, reading level, voice, speed, model, sites where Clavis is off, setup progress) and your Groq API key in Chrome's extension storage on this device. If you choose "only for this session", the key is kept in Chrome's in-memory session storage instead. Nothing is synced to other devices. Websites and Clavis's on-page script cannot read this storage.

### tts

The **Listen** button reads the selected text aloud with the voices on the user's device through `chrome.tts`. Settings uses `chrome.tts.getVoices` to list the available voices. Automatic tries a matching on-device voice first, then a matching online voice if needed. A user can also choose a specific online voice in Settings. Online voices send selected text to their provider and playback is labelled online.

### scripting

Used for three things, all initiated by the user's own choices. (1) After the user grants website access, it registers the small selection script that shows the toolbar; the registration is removed when access is removed, and excludes sites the user turned off. (2) When the user asks for an explanation by right-click, the popup button or the keyboard shortcut, it injects that script into the current tab only. (3) It loads the explanation card into the frame where the user clicked Explain. All injected code is part of the extension package.

### activeTab

Lets users who declined website access still use Clavis on the page they are reading. When they right-click selected text and choose Explain with Clavis, click "Explain on this page" in the popup, or press the keyboard shortcut, Chrome grants temporary access to that tab and Clavis reads the current selection.

### contextMenus

Adds one item, **Explain with Clavis**, to the right-click menu when text is selected. It is the main way to use Clavis without website access.

### sidePanel

Shows a long explanation in Chrome's side panel when the user chooses **Open in side panel** in the explanation card. The panel is enabled for that one tab only. Its content is held in the extension's memory, not stored, and is dropped when the tab closes or loads another page.

### identity (effective when account sync ships)

Used only for the optional **Sign in with Google** button. The background calls `chrome.identity.launchWebAuthFlow` to open Google's sign-in page and `chrome.identity.getRedirectURL` to build the redirect address. Clavis requests only the `openid`, `email` and `profile` scopes, does not use the `oauth2` manifest key or `getAuthToken`, and stores no Google access or refresh token. Nothing runs unless the user clicks the button, and the extension works fully without signing in.

### alarms (effective when account sync ships)

Used only while the user is signed in, to wake the background service worker about every 30 minutes to fetch changes from the Clavis sync server, and to schedule one retry with backoff after a failed sync. Chrome puts the service worker to sleep, so a timer in the page would not survive. When signed out, no alarm is set.

### Host permission: https://api.groq.com/*

The only server Clavis contacts. The extension's background worker sends the Explain request (the selected text, up to 1,000 characters of nearby text and a few settings) and the key check (a request for the model list) to Groq, using the user's own API key. No developer key is shipped. **Effective when account sync ships:** Groq is still the only recipient of selected text. The extension also contacts the Clavis sync server, but only after the user signs in, and without a host permission (see the note on the Clavis API origin below).

### Clavis API origin: https://clavis-api-production.up.railway.app (not a permission; effective when account sync ships)

Nothing to paste into a permission field. For reviewers: this server holds the optional Clavis account. It is reached only by the background service worker, only after the user signs in with Google, to sync the user's saved words, chats, reading progress, highlight positions and any PDFs the user explicitly chooses to store. It is allowed by the server's CORS allowlist for this extension's own origin, so no host permission is requested.

### Optional host permissions: http://*/* and https://*/*

Requested only when the user clicks **Enable on websites** during setup or in Settings. It is not requested at install. It lets the toolbar appear automatically when the user selects text. The script only notices selections on the device. It reads nothing in the background, and nothing is sent until the user asks for an explanation or starts Listen with an online voice. The user can decline it and still use Clavis, or remove it at any time in Settings or on `chrome://extensions`.

## Remote code

**Answer: No, Clavis does not use remote code.**

All JavaScript and the PDF.js WebAssembly decoders ship inside the extension package. The extension-page content security policy is `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; media-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'`, so extension pages cannot load a script from another origin. Groq returns JSON that Clavis checks against a schema and shows as plain text. It is never executed or inserted as HTML. The release ZIP is audited for CDN-hosted scripts and dynamic evaluation (`scripts/audit-zip.mjs`).

## Data usage form

Chrome Web Store asks which user data the extension collects. "Collect" here includes data sent off the device.

| Category | Answer | Explanation |
| --- | --- | --- |
| Personally identifiable information | No | Not collected. |
| Health information | No | Not collected. |
| Financial and payment information | No | Not collected. |
| Authentication information | **Yes** | The user's own Groq API key. Stored locally in Chrome's extension storage (or in session memory if the user chooses). Sent only to Groq, in the request header, to authorize the user's own requests. The publisher never receives it. |
| Personal communications | No | Not collected. |
| Location | No | Not collected. |
| Web history | No | Page addresses and browsing history are not collected or sent. |
| User activity | No | No analytics, clicks or keystrokes are recorded or sent. |
| Website content | **Yes** | The text the user selects and up to 1,000 characters of nearby text are sent to Groq only when the user asks for an explanation. Never sent when text is only selected. Not stored. Not sent to the publisher. Text from password fields, form inputs and editable areas is never sent. |

Clavis sends website content to Groq only to provide the explanation the user requested. Automatic Listen tries a matching on-device voice first, then an online voice if needed. Online playback sends the selected text to that voice's provider; this also applies when the user chooses an online voice explicitly. Mention this in the description of "Website content" if the dashboard has room.

### Data usage form: Clavis Sync release (effective when account sync ships)

Replace the answers above with these when the release that enables account sync is submitted. Only users who choose to sign in send anything to the Clavis server; say so in the free-text fields.

| Category | Answer | Explanation |
| --- | --- | --- |
| Personally identifiable information | **Yes** | The Google account email address and display name, collected only when the user signs in, used to identify the account. Sent to and stored on the Clavis sync server. |
| Health information | No | Not collected. |
| Financial and payment information | No | Not collected. |
| Authentication information | **Yes** | The user's own Groq API key (stored locally; sent only to Groq; never to the Clavis server), and the Clavis session tokens issued after a Google sign-in (stored locally by the background; sent only to the Clavis server). Google passwords are never seen by Clavis. |
| Personal communications | No | Not collected. Per-word chat messages are the user's own questions about a saved word and the model's answers, not communications with other people; they are disclosed under "Website content". |
| Location | No | Not collected. |
| Web history | **Yes** | The address (origin and path only, no query or fragment) and title of the page where the user saved a word, stored with that saved word when the user signs in. Not collected from incognito tabs. Clavis does not collect browsing history otherwise. |
| User activity | No | No analytics, clicks or keystrokes are recorded or sent. Reading position and highlight positions in PDFs are synced as user content under "Website content". |
| Website content | **Yes** | Selected text and up to 1,000 characters of nearby text go to Groq only on an explanation request (unchanged). Additionally, when the user signs in: saved words with their meaning and bounded context, per-word chat messages, PDF titles, reading progress, highlight positions and text offsets, and the PDF files the user chooses to save (up to 15 MB each and 100 MB per account) are stored on the Clavis sync server. |

The certifications below stay true: the data goes only to Groq (explanations), to online voice providers (speech) and, for signed-in users, to the Clavis server that provides the sync feature the user asked for. It is not sold, not used for advertising and not used for creditworthiness. The privacy policy ([../privacy-policy.md](../privacy-policy.md)) describes retention, export and deletion; the dashboard links to it.

### Certifications (tick all three)

- I do not sell or transfer user data to third parties, outside of the approved use cases. Clavis transfers data only to Groq, and to an online voice provider when Automatic falls back to one or the user chooses one, to provide the feature the user requested.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

## Reviewer notes

Paste into the "Notes for reviewers" field.

- **Test without website access.** Install the extension and skip the website-access step. On any web page, select text, right-click and choose **Explain with Clavis**. You can also press Alt+Shift+E, or click the Clavis icon and choose **Explain on this page**. The optional all-sites permission is requested only from the button **Enable on websites**.
- **Explain needs a Groq key.** Clavis ships no key. To test Explain, paste your own Groq API key (a free key from `https://console.groq.com/keys` is enough) in setup or Settings. Without a key, Explain asks you to connect Groq.
- **Listen depends on the voices reported by Chrome.** Automatic tries a matching on-device voice first, then a matching online voice if no local voice is available or can start. Online voices send the selected text to their provider and playback is marked online. If no voice matches the language, Clavis shows a no-voice message.
- **PDFs.** Click the Clavis icon, choose **Open PDF reader**, then choose a PDF from the computer. Chrome's built-in PDF viewer is not supported. PDFs are read in the browser and not uploaded unless a signed-in user chooses **Save to account** (effective when account sync ships).
- **Account sync (effective when account sync ships).** Signing in is optional and never required to test any feature. To test it, open Settings → Account & sync and sign in with a Google account; the extension then syncs saved words, reading progress and highlights to the Clavis server, and the web dashboard at `https://clavis-api-production.up.railway.app` shows them. Test with a throwaway Google account.
- **PDF.js bundle.** The bundled PDF.js code contains a Node-only code path that refers to `@napi-rs/canvas` (it uses `process.getBuiltinModule`). It is dead code in the browser: it never runs in the browser, and no such module is part of the package.
- **Minimum Chrome version** is 147 (PDF.js 6 needs it).
