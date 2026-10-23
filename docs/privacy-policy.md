# Clavis privacy policy — DRAFT

> **Status:** draft for v1, written 2026-10-22. Not yet published. It will be hosted on GitHub Pages (D-15) and must be re-checked against the shipped code, the permission list in [architecture.md §3](architecture.md#3-extension-entry-points-and-message-routes) and the data flows in [architecture.md §9](architecture.md#9-persistence-privacy-and-telemetry) before store submission. Placeholders: `[PUBLISHER]`, `[SUPPORT_EMAIL]`, `[EFFECTIVE_DATE]`, `[POLICY_URL]`.

**Effective date:** [EFFECTIVE_DATE]  
**Publisher:** [PUBLISHER] · **Contact:** [SUPPORT_EMAIL]

Clavis is a Chrome extension that helps you understand and pronounce text you select on websites and in PDFs you open in Clavis. This policy explains what data Clavis handles, where it goes, and how to delete it.

## The short version

- Clavis has **no server of its own**. The publisher does not receive, store or sell your data.
- Nothing you read is sent anywhere until you click **Explain**. Then the selected text and a small amount of nearby text go to **Groq**, the AI provider, using **your own** Groq API key.
- **Listen** uses the voices on your computer and sends nothing to Groq. It uses an online voice only if you explicitly choose one in Settings.
- PDFs you open in Clavis are read inside your browser and never uploaded.
- Your settings and API key are stored only in your Chrome profile, and you can delete them at any time.

## What Clavis handles

| Data | When | Where it goes |
| --- | --- | --- |
| Text you select on a website or in a PDF | When you select it | Stays on your device. Used to show the Clavis toolbar. |
| Selected text, up to 1,000 characters of surrounding text, and your chosen explanation language | Only when you click **Explain** or open an explanation tab | Sent over HTTPS to Groq with your API key, to generate the explanation. |
| Selected text for **Listen** | When you click **Listen** | Passed to a speech engine on your computer (Chrome's text-to-speech or your system voices). Not sent to Groq. By default Clavis uses only on-device voices. If you explicitly choose a voice marked *online* in Settings → Voice, the selected text is sent to that voice's provider (for example Google) to be spoken, under that provider's terms. Your operating system's speech engine may have its own data practices. |
| Your Groq API key | When you enter it | Stored in Chrome's extension storage on your device, either until you remove it or only for the current browser session, as you choose. Sent only to Groq. |
| PDF files you open | When you open them | Read in your browser's memory and released when you close the reader. Never uploaded. |
| Settings (language, voice, speed, model, sites where Clavis is disabled) | When you change them | Stored in Chrome's extension storage on your device. Not synced. |

Clavis does **not** collect browsing history, page addresses, analytics, advertising identifiers or crash reports. It does not read text in password fields, form inputs or other editable areas.

## Website access

During setup, Clavis asks for optional permission to run on websites so it can show its toolbar when you select text. With this permission, a small script on each page watches for text selections **on your device only**; it does not read or send page content in the background. You can decline and still use Clavis by right-clicking selected text and choosing **Explain with Clavis**. You can grant or remove website access at any time in Clavis settings or on Chrome's extension page.

## Side panel

When you choose **Open in side panel** in the explanation card, Clavis shows that explanation in Chrome's side panel. The selected text and the explanation are handed to the panel inside the extension and kept in the extension's memory only, for that tab: they are not written to storage, are not sent anywhere, and are dropped when you close the tab, move it to another page or clear Clavis data. Opening the panel sends nothing to Groq; loading another part of the explanation in the panel is a new Explain request like any other.

## Groq

When you click Explain, Groq receives the text described above and processes it to return an explanation. Groq is an independent company; its handling of that data is governed by its own terms and privacy policy: <https://groq.com/privacy-policy/>. You create and control your Groq account and API key, and Groq's usage limits apply to your account.

The publisher of Clavis has no access to your Groq account, your API key or the text you send to Groq.

## Security

Your API key is kept in Chrome's extension storage, which websites and Clavis's on-page script cannot read. This storage is **not encrypted**: anyone with access to your computer account or Chrome profile could find the key. If you are concerned, choose **Only for this session**, which clears the key when Chrome closes, and use a Groq key you can revoke.

## Deleting your data

- **Remove your API key:** Clavis settings → API key → Remove.
- **Reset settings / clear all Clavis data:** Clavis settings → Privacy → Clear all data.
- **Remove everything:** uninstall Clavis from `chrome://extensions`. Chrome deletes all of its stored data.

Data already sent to Groq is subject to Groq's retention policy; contact Groq to ask about it.

## Children

Clavis is not directed at children under 13 and does not knowingly collect their data. It collects no personal data from anyone.

## Changes

If Clavis ever adds a new data recipient, telemetry, syncing or new permissions, this policy will be updated first and the change will be shown in the extension's release notes. The current version is always at [POLICY_URL].

## Contact

Questions: [SUPPORT_EMAIL]. Please never send your API key.
