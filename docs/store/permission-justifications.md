# Chrome Web Store: permission justifications and data-use answers

> **Status:** draft for v1, checked against the code on 2026-10-23 (Phase 9 release audit). Paste each answer into the matching field of the Chrome Web Store developer dashboard (Privacy tab). Keep it in step with [architecture.md §3](../architecture.md#3-extension-entry-points-and-message-routes) (permission table), [requirements.md §6](../requirements.md#6-permission-and-data-inventory) and the [privacy policy](../privacy-policy.md). If a permission changes, change all of them.
>
> Open placeholder: the dashboard's "Privacy policy" field needs the published policy address, `[POLICY_URL]`. It must equal `CLAVIS_PRIVACY_POLICY_URL` in `lib/ui-client/links.ts` (currently the placeholder `https://omakidx.github.io/clavis/privacy/`, D-15).

Manifest being described (`wxt.config.ts`, built `manifest.json`): `permissions` = `storage`, `tts`, `scripting`, `activeTab`, `contextMenus`, `sidePanel`; `host_permissions` = `https://api.groq.com/*`; `optional_host_permissions` = `http://*/*`, `https://*/*`. There are no static `content_scripts`, no `tabs`, `offscreen`, `webRequest` or `<all_urls>`.

## Single purpose

Clavis helps you understand and pronounce text you select on web pages and in PDFs you open in Clavis. It explains the selection with an AI model (Groq, using your own API key) and reads it aloud with your computer's voices.

## Permission justifications

### storage

Saves your settings (explanation language, reading level, voice, speed, model, sites where Clavis is off, setup progress) and your Groq API key in Chrome's extension storage on this device. If you choose "only for this session", the key is kept in Chrome's in-memory session storage instead. Nothing is synced to other devices. Websites and Clavis's on-page script cannot read this storage.

### tts

The **Listen** button reads the selected text aloud with the voices on the user's device through `chrome.tts`. Settings uses `chrome.tts.getVoices` to list the available voices. An online voice is used only if the user chooses one in Settings, and it is labelled as online.

### scripting

Used for three things, all initiated by the user's own choices. (1) After the user grants website access, it registers the small selection script that shows the toolbar; the registration is removed when access is removed, and excludes sites the user turned off. (2) When the user asks for an explanation by right-click, the popup button or the keyboard shortcut, it injects that script into the current tab only. (3) It loads the explanation card into the frame where the user clicked Explain. All injected code is part of the extension package.

### activeTab

Lets users who declined website access still use Clavis on the page they are reading. When they right-click selected text and choose Explain with Clavis, click "Explain on this page" in the popup, or press the keyboard shortcut, Chrome grants temporary access to that tab and Clavis reads the current selection.

### contextMenus

Adds one item, **Explain with Clavis**, to the right-click menu when text is selected. It is the main way to use Clavis without website access.

### sidePanel

Shows a long explanation in Chrome's side panel when the user chooses **Open in side panel** in the explanation card. The panel is enabled for that one tab only. Its content is held in the extension's memory, not stored, and is dropped when the tab closes or loads another page.

### Host permission: https://api.groq.com/*

The only server Clavis contacts. The extension's background worker sends the Explain request (the selected text, up to 1,000 characters of nearby text and a few settings) and the key check (a request for the model list) to Groq, using the user's own API key. Clavis has no server of its own, and no developer key is shipped.

### Optional host permissions: http://*/* and https://*/*

Requested only when the user clicks **Enable on websites** during setup or in Settings. It is not requested at install. It lets the toolbar appear automatically when the user selects text. The script only notices selections on the device. It reads nothing in the background, and nothing is sent anywhere until the user clicks Explain. The user can decline it and still use Clavis, or remove it at any time in Settings or on `chrome://extensions`.

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

Clavis sends website content only to Groq to provide the explanation the user requested. If the user chooses an online voice, the selected text for Listen goes to that voice's provider. By default Listen is on-device. Mention this in the description of "Website content" if the dashboard has room.

### Certifications (tick all three)

- I do not sell or transfer user data to third parties, outside of the approved use cases. Clavis transfers data only to Groq, and to an online voice provider if the user picks one, to provide the feature the user requested.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

## Reviewer notes

Paste into the "Notes for reviewers" field.

- **Test without website access.** Install the extension and skip the website-access step. On any web page, select text, right-click and choose **Explain with Clavis**. You can also press Alt+Shift+E, or click the Clavis icon and choose **Explain on this page**. The optional all-sites permission is requested only from the button **Enable on websites**.
- **Explain needs a Groq key.** Clavis has no server and ships no key. To test Explain, paste your own Groq API key (a free key from `https://console.groq.com/keys` is enough) in setup or Settings. Without a key, Explain asks you to connect Groq.
- **Listen depends on installed voices.** Listen uses the voices on the computer. Some systems, including many Linux setups, have no voice installed, and Clavis then says no voice is available. Online voices are used only if chosen in Settings → Voice.
- **PDFs.** Click the Clavis icon, choose **Open PDF reader**, then choose a PDF from the computer. Chrome's built-in PDF viewer is not supported. PDFs are read in the browser and never uploaded.
- **PDF.js bundle.** The bundled PDF.js code contains a Node-only code path that refers to `@napi-rs/canvas` (it uses `process.getBuiltinModule`). It is dead code in the browser: it never runs in the browser, and no such module is part of the package.
- **Minimum Chrome version** is 147 (PDF.js 6 needs it).
