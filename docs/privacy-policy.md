# Clavis privacy policy — DRAFT

> **Status:** draft for v1, last checked against the code on 2026-10-23 (Phase 9 release audit). Not yet published. It will be hosted on GitHub Pages (D-15) and must be re-checked against the shipped code, the permission list in [architecture.md §3](architecture.md#3-extension-entry-points-and-message-routes) and the data flows in [architecture.md §9](architecture.md#9-persistence-privacy-and-telemetry) before store submission. The Chrome Web Store answers that go with this policy are in [store/permission-justifications.md](store/permission-justifications.md).
>
> Placeholders: `[PUBLISHER]`, `[SUPPORT_EMAIL]`, `[EFFECTIVE_DATE]`, `[POLICY_URL]`.
>
> `[POLICY_URL]` must be exactly the address the extension links to: `CLAVIS_PRIVACY_POLICY_URL` in `lib/ui-client/links.ts`, currently `https://omakidx.github.io/clavis/privacy/`. That value is a placeholder until the page is published (D-15). Change the code constant, this policy and the Chrome Web Store "Privacy policy" field together.

**Effective date:** [EFFECTIVE_DATE]  
**Publisher:** [PUBLISHER] · **Contact:** [SUPPORT_EMAIL]

Clavis is a Chrome extension that helps you understand and pronounce text you select on websites and in PDFs you open in Clavis. This policy explains what data Clavis handles, where it goes, and how to delete it.

## The short version

- Clavis has **no server of its own**. The publisher does not receive, store or sell your data.
- Nothing you read is sent anywhere until you ask for an explanation. Then the selected text and a small amount of nearby text go to **Groq**, the AI provider, using **your own** Groq API key.
- **Listen** uses the voices on your computer and sends nothing to Groq. It uses an online voice only if you explicitly choose one in Settings.
- PDFs you open in Clavis are read inside your browser and never uploaded.
- Your settings and API key are stored only in your Chrome profile, and you can delete them at any time.

## What Clavis handles

| Data | When | Where it goes |
| --- | --- | --- |
| Text you select on a website or in a PDF | When you select it | Stays on your device. Used to show the Clavis toolbar. |
| Selected text, up to 1,000 characters of nearby text and a few settings (see [What Groq receives](#what-groq-receives)) | Only when you ask for an explanation (see below) | Sent over HTTPS to Groq with your API key, to generate the explanation. |
| Selected text for **Listen** | When you click **Listen** | Passed to a speech engine on your computer (Chrome's text-to-speech or your system voices). Not sent to Groq. By default Clavis uses only on-device voices. If you explicitly choose a voice marked *online* in Settings → Voice, the selected text is sent to that voice's provider (for example Google) to be spoken, under that provider's terms. Your operating system's speech engine may have its own data practices. |
| Your Groq API key | When you enter it | Stored in Chrome's extension storage on your device, either until you remove it or only while Chrome keeps the session, as you choose. Sent only to Groq, in the request header. |
| PDF files you open | When you open them | Read in your browser's memory and released when you close the reader. Never uploaded. |
| Settings and setup state (see [What Clavis stores](#what-clavis-stores)) | When you change them | Stored in Chrome's extension storage on your device. Not synced. |

Clavis does **not** collect browsing history, page addresses, analytics, advertising identifiers or crash reports. Clavis never sends text from password fields, form inputs or other editable areas, either as the selection or as nearby text.

## What Groq receives

Clavis asks Groq for an explanation in these cases:

- You click **Explain** in the toolbar.
- You open another explanation tab in the card or in the side panel (Roots, Related words or Simplify). Each one is a separate request.
- You right-click selected text and choose **Explain with Clavis**.
- You click the Clavis icon and choose **Explain on this page**.

Each request goes from Clavis's background worker to `https://api.groq.com` and contains:

- the selected text (at most 2,000 characters);
- up to 1,000 characters of nearby text, taken from the same block of the page or PDF;
- the language tag the page declares for itself, if it has one;
- the explanation type (the main explanation, roots, related words or a plainer rewrite) and whether the selection is a word, phrase, sentence or passage;
- your explanation language, reading level and detail level, where that explanation type uses them;
- the name of the AI model you chose;
- fixed instructions written by Clavis, and your Groq API key in the request header.

A request does not contain the page address, page title, cookies, other page content, or the PDF file. Groq also sees the IP address the request comes from, as any web service does.

Pressing the keyboard shortcut (Alt+Shift+E) only shows the toolbar. It sends nothing. When you check your key in Settings, Clavis asks Groq for the list of models your key can use. That request contains your key and no text.

Before the first Explain, Clavis shows what is sent and asks you to acknowledge it, in setup or, if you skipped that, in the card. Groq is an independent company; its handling of the data is governed by its own terms and privacy policy: <https://groq.com/privacy-policy/>. You create and control your Groq account and API key, and Groq's usage limits apply to your account.

## How Clavis uses data

- Clavis uses website content only to show its toolbar and, when you ask, to get an explanation or read the text aloud. This is the feature you asked for.
- Clavis does not sell data. It does not use data for advertising, to judge creditworthiness, or for lending.
- Clavis does not transfer your data to anyone except Groq, to provide the explanation you asked for, and, only if you choose an online voice, that voice's provider, to speak the text.
- The publisher has no access to your data. It does not pass through any server of the publisher, and no person at the publisher reads it.

## What Clavis stores

Clavis keeps this on your device in Chrome's extension storage. It is not synced to other devices.

- **Preferences:** explanation language, reading level, when the toolbar appears (automatically or only when you ask), Listen voice, language and speed, and the AI model you chose.
- **Sites where Clavis is turned off** (host names only).
- **Setup state:** whether setup is finished, when you accepted the data disclosure, and whether you granted or declined website access.
- **Key details:** whether your key is stored on this device or only for the session, its last four characters (for display), whether the last check passed and when, and the list of models Groq said your key can use.
- **Your Groq API key.**
- **Model capability notes:** which request options your chosen model accepted. Clavis keeps these in memory-based session storage, so they last only for the browser session.

Clavis does **not** store the text you select, nearby text, or Groq's answers. An answer lives in the page's memory while the card is open. See [Side panel](#side-panel) for the one place a copy is held longer, and only in memory.

## Website access

During setup, Clavis asks for optional permission to run on websites so it can show its toolbar when you select text. With this permission, a small script on each page watches for text selections **on your device only**; it does not read or send page content in the background. Clavis does not run on the Chrome Web Store, and you can turn it off for individual sites in Settings.

You can decline and still use Clavis without website access, one page at a time:

- Select text, right-click it and choose **Explain with Clavis**.
- Select text and press the keyboard shortcut, Alt+Shift+E by default.
- Click the Clavis icon and choose **Explain on this page**.

Each of these uses Chrome's temporary access to the page you are on, after your action. You can grant or remove website access at any time: in Clavis Settings → Website access (**Remove website access**), or on Chrome's extension page (`chrome://extensions` → Clavis → Details → Site access).

## Side panel

When you choose **Open in side panel** in the explanation card, Clavis shows that explanation in Chrome's side panel. The selected text and the explanation are handed to the panel inside the extension and kept in the extension's memory only, for that tab. They are not written to storage and are not sent anywhere. They are dropped when you close the tab, when the tab starts loading another page, or when you clear Clavis data, and they are lost if Chrome restarts the extension's background worker. On single-page sites that change the address without loading a page, Clavis drops them when it can see the address change; where it cannot, they may stay until you close the tab. Opening the panel sends nothing to Groq. Loading another part of the explanation in the panel is a new Explain request like any other.

## Permissions

Clavis asks Chrome for these permissions. Each is used only for the purpose given here.

| Permission | Why Clavis needs it |
| --- | --- |
| `storage` | Keeps your settings and Groq key in Chrome's extension storage on this device. The "only for this session" option uses in-memory session storage. Nothing is synced. Websites cannot read it. |
| `tts` | Listen reads the selected text aloud with the voices on your device, and Settings lists the voices that are available. An online voice is used only if you choose one. |
| `scripting` | After you grant website access, registers the small selection script on websites (removed when you remove access or turn a site off). Injects it into the current tab when you ask (right-click, icon or shortcut). Loads the explanation card into the page where you clicked Explain. All of this code ships inside the extension. |
| `activeTab` | Lets Clavis work on the current tab, after your action, if you declined website access. |
| `contextMenus` | Adds one **Explain with Clavis** item to the right-click menu for selected text. |
| `sidePanel` | Shows a long explanation in Chrome's side panel, for the tab where you chose **Open in side panel**. |
| `https://api.groq.com/*` | The only server Clavis contacts. The background worker sends the Explain request and the key check to Groq, with your own key. |
| Optional: all `http` and `https` websites | Asked for only when you choose **Enable on websites**. It lets the toolbar appear automatically when you select text. The script only notices selections on your device. Nothing is read in the background or sent until you ask for an explanation. You can decline it or remove it at any time. |

## Security

Your API key is kept in Chrome's extension storage, which websites and Clavis's on-page script cannot read. This storage is **not encrypted**: anyone with access to your computer account or Chrome profile could find the key. If you are concerned, choose **Only for this session**. Chrome clears session storage when the browser restarts and also when the extension is updated, reloaded or turned off, so you will need to paste the key again after any of these. Use a Groq key you can revoke.

## Deleting your data

- **Remove your API key:** Clavis Settings → Groq API key → **Remove key**. This does not cancel the key at Groq; do that on the Groq keys page.
- **Clear everything Clavis stores:** Clavis Settings → Privacy and data → **Clear all data**. This removes your key, preferences, setup progress and the list of turned-off sites, and drops any explanation held for the side panel.
- **Remove website access:** **Clear all data does not remove website access**, because that is a Chrome permission. Remove it in Clavis Settings → Website access → **Remove website access**, or in Chrome at `chrome://extensions` → Clavis → Details → Site access.
- **Remove everything:** uninstall Clavis from `chrome://extensions`. Chrome deletes all of its stored data and permissions.

Data already sent to Groq is subject to Groq's retention policy; contact Groq to ask about it.

## Children

Clavis is not directed at children under 13 and does not knowingly collect their data. The publisher receives no data from anyone who uses Clavis.

## Changes

If Clavis ever adds a new data recipient, telemetry, syncing or new permissions, this policy will be updated first and the change will be shown in the extension's release notes. The current version is always at [POLICY_URL].

## Contact

Questions: [SUPPORT_EMAIL]. Please never send your API key.
