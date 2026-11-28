# Clavis privacy policy

**Effective date:** 2026-11-28  
**Publisher:** Omakidx · **Contact:** awwalm513@gmail.com

Clavis is a Chrome extension that helps you understand and pronounce text you select on websites and in PDFs you open in Clavis. It can also keep a library of words you save. This policy explains what data Clavis handles, where it goes, and how to delete it. It covers the Clavis extension and the Clavis web dashboard at `https://clavis-api-production.up.railway.app`.

## The short version

- **You do not need an account.** If you never sign in, Clavis **does not contact any server of the publisher's**: the publisher does not receive, store or sell your data, and everything Clavis saves stays in your Chrome profile.
- **An account is optional.** If you sign in with Google, Clavis stores your saved words, chats, reading progress, highlight positions and any PDFs you choose to save on a server run by the publisher, so they follow you across devices and appear in the web dashboard.
- When you ask for an explanation, or send a chat message about a saved word, the text involved goes to **Groq**, the AI provider, using **your own** Groq API key. Selecting text alone sends nothing. **Your Groq key is never sent to Clavis's server.**
- The Clavis server **never calls an AI provider**, does not sell your data, and shows no ads.
- **Listen** sends nothing to Groq. Automatic tries a matching on-device voice first, then a matching online voice if no local voice is available or can start. Online voices send the spoken text to their provider, including text from a PDF document or section you ask to hear.
- PDFs you open in Clavis are read inside your browser. A PDF is uploaded only if you are signed in and choose **Save to account**.
- You can export everything in your account and delete your account from the dashboard at any time.

## What Clavis handles

| Data | When | Where it goes |
| --- | --- | --- |
| Text you select on a website or in a PDF | When you select it | Stays on your device. Used to show the Clavis toolbar. |
| Selected text, up to 1,000 characters of nearby text and a few settings (see [What Groq receives](#what-groq-receives)) | Only when you ask for an explanation | Sent over HTTPS to Groq with your API key, to generate the explanation. |
| Selected text, translated output, or PDF document/range text you ask to hear | When you click **Listen**, the speaker beside a translation, or **Play** in the PDF reader | Passed to a speech engine on your computer (Chrome's text-to-speech or your system voices). Not sent to Groq. Automatic tries a matching on-device voice first, then a matching online voice if no local voice is available or can start. You can also choose a specific voice in Settings → Voice. When an online voice is used, the spoken text is sent to that voice's provider (for example Google) to be spoken, under that provider's terms; Settings identifies online voices and explains the automatic fallback. Translation pronunciation adds no visible status label; PDF narration shows playback controls and follows the spoken passage. Your operating system's speech engine may have its own data practices. |
| Your Groq API key | When you enter it | Stored in Chrome's extension storage on your device, either until you remove it or only while Chrome keeps the session, as you choose. Sent only to Groq, in the request header. Never sent to Clavis's server and never synced. |
| Words you save, with their meaning, nearby text, source page address and title (see [Saved words, chats and reading data](#saved-words-chats-and-reading-data)) | When you click **Save** | Stored on your device. Also on the Clavis server if you are signed in. |
| Chat messages about a saved word | When you send one from the Clavis library | Your message, the word, its saved meaning, its saved context and recent messages go to Groq with your key. Stored on your device, and on the Clavis server if you are signed in. |
| PDF reading progress and highlights | While you read a PDF in Clavis | Stored on your device. Also on the Clavis server if you are signed in. |
| PDF files you open | When you open them | Read in your browser's memory and released when you close the reader. Uploaded only if you are signed in and choose **Save to account**. |
| Your Google account email address, name and identifier | When you sign in | Sent to and stored on the Clavis server. |
| Settings and setup state (see [What Clavis stores on your device](#what-clavis-stores-on-your-device)) | When you change them | Stored in Chrome's extension storage on your device. Not synced. |

Clavis does **not** collect analytics, advertising identifiers or crash reports, and does not track your browsing. The only page addresses Clavis keeps are those of pages where **you** saved a word, as described below. Clavis never sends text from password fields, form inputs or other editable areas, either as the selection or as nearby text.

## What Groq receives

Clavis asks Groq for an explanation in these cases:

- You click **Explain** in the toolbar.
- You open another explanation tab in the card or in the side panel (Roots, Related words, Simplify or Translate). Each one is a separate request.
- You right-click selected text and choose **Explain with Clavis**.
- You click the Clavis icon and choose **Explain on this page**.
- You send a chat message about a saved word in the Clavis library.

Each request goes from Clavis's background worker to `https://api.groq.com` and contains:

- the selected text (at most 2,000 characters);
- up to 1,000 characters of nearby text, taken from the same block of the page or PDF;
- the language tag the page declares for itself, if it has one;
- the explanation type (the main explanation, roots, related words, a plainer rewrite or a translation) and whether the selection is a word, phrase, sentence or passage;
- your explanation language or translation target language, reading level and detail level, where that explanation type uses them;
- the name of the AI model you chose;
- fixed instructions written by Clavis, and your Groq API key in the request header.

A request for a chat message instead contains your question (at most 2,000 characters), the saved word, its saved meaning and nearby text, and up to the last 20 messages of that chat (at most 12,000 characters), with the same instructions, model name and key header.

A request does not contain the page address, page title, cookies, other page content, or the PDF file. Groq also sees the IP address the request comes from, as any web service does.

Pressing the keyboard shortcut (Alt+Shift+E) only shows the toolbar. It sends nothing. When you check your key in Settings, Clavis asks Groq for the list of models your key can use. That request contains your key and no text.

Before the first Explain, Clavis shows what is sent and asks you to acknowledge it, in setup or, if you skipped that, in the card or in the library. Groq is an independent company; its handling of the data is governed by its own terms and privacy policy: <https://groq.com/privacy-policy/>. You create and control your Groq account and API key, and Groq's usage limits apply to your account.

Chat messages are sent only from the extension. The web dashboard shows saved chats read-only and cannot send a message, and the Clavis server never sends your text to Groq or any other AI provider.

## Saved words, chats and reading data

These features work without an account. They are stored on your device first.

- **Saved words.** When you click **Save** on a word or phrase (up to 200 characters), Clavis keeps the text, the language if known, the meaning shown in the card (title, summary, contextual meaning, definition, examples, caution note and the model name), up to 1,000 characters of the nearby text, and where you read it. For a webpage that is the address of the page, reduced to its origin and path (the query string and fragment are dropped), and the page title. If you saved it from an incognito window, the address and title are not kept. For a PDF it is the PDF's title, the page number and the PDF's SHA-256 content hash.
- **Chats.** Messages you send about a saved word and the answers you received, with the model's name and the time. Up to 200 messages per word.
- **PDF reading data.** For each PDF you open in Clavis: its SHA-256 content hash, its title (the file name without `.pdf`), its page count and size, the page and position where you stopped reading, and your highlights (each mark's random ID, page number, text offsets, color and creation time). Highlight text, PDF contents and the file name are not stored. Up to 200 marks per PDF across 2,000 PDFs.

On your device these live in the extension's IndexedDB database, which websites cannot read. They stay until you delete them, clear all Clavis data, sign out without keeping a copy (see below) or uninstall Clavis. Signed out, the library can export your saved words and chats as a JSON file.

## Signing in and your account (with an account)

Signing in is optional and is done with Google only. There are no Clavis passwords.

**What Clavis asks Google for.** The scopes `openid`, `email` and `profile`: your email address, your name and a stable Google account identifier. Clavis does not ask for offline access, and does not receive or keep any Google access or refresh token. Your Google password is never seen by Clavis. Google processes your sign-in under its own privacy policy. Your email address must be verified by Google.

**What the Clavis server stores about you.** When you sign in, the Clavis server stores your email address, your display name, your Google account identifier, when the account was created, and the sign-in sessions it issues to your devices and browser (as one-way hashes, not the tokens themselves). The extension keeps its session tokens in its own protected storage and never shows them to web pages.

**What syncs while you are signed in.** The following are copied to the Clavis server and to your other devices:

- saved words with their meaning, nearby text, source page address (origin and path) and title, or PDF title and page, and their hash;
- chat messages about saved words;
- for each PDF you opened in the reader: its title, page count, size, reading position and highlight positions, whether or not you saved the file itself;
- PDF files you chose to save with **Save to account**: each file up to 15 MB, and up to 100 MB in total per account.

When you first sign in, saved words, highlights and reading progress already on that device are added to your account. The sign-in screen says so before you continue. Cancel it if you do not want this.

**What is never synced.** Your Groq API key, your preferences and settings, which sites Clavis is turned off on, and text you select and explain without saving it.

**The web dashboard.** At `https://clavis-api-production.up.railway.app` you sign in with Google to browse and delete your saved words and documents, read saved chats (read-only), download or remove stored PDFs, export your data, sign out everywhere and delete your account. It sets one cookie that keeps you signed in (up to 7 days of inactivity and 30 days in total, and it is removed when you sign out). It does not use analytics or advertising cookies, and loads no third-party scripts.

## How Clavis uses data

- Clavis uses website content only to show its toolbar and, when you ask, to get an explanation or read the text aloud. This is the feature you asked for.
- With an account, Clavis uses your email and name to identify your account and show you who is signed in, and uses your saved words, chats, reading data and PDFs only to store them, sync them to your devices and show them to you in the extension and the dashboard.
- Clavis does not sell data. It does not use data for advertising, to judge creditworthiness, or for lending. It does not use your data to train AI models, and the Clavis server does no AI processing of it.
- Clavis does not transfer your data to anyone except: Groq, to provide the explanation or chat answer you asked for; a voice provider when Automatic falls back to an online voice or you choose one, to speak the text; Google, which handles your sign-in; and Railway, the hosting provider described next, which stores the account data on the publisher's behalf.
- Without an account, the publisher has no access to your data and no person at the publisher reads it, because none of it reaches the publisher.

## Where account data is stored and who can access it (with an account)

- **Hosting.** The Clavis server runs on [Railway](https://railway.com). Account records are kept in a Railway PostgreSQL database and stored PDFs in a Railway storage bucket, both in the publisher's Railway project. Railway acts as the publisher's hosting provider and is subject to its own terms and privacy policy. All traffic to the server uses HTTPS.
- **Who can access it.** Access to the database and the bucket is limited to the publisher, through the publisher's Railway account. The publisher does not read your saved words, chats or PDFs in the ordinary course of running the service, and will access them only where needed to keep the service secure and working, or where the law requires. Other Clavis users cannot see your data: every request is checked against your account. Railway, as the hosting provider, has the technical ability to access what it hosts.
- **Server logs.** The server's logs record the type of request, the route name (never the full address), the response status, how long it took, an error code and an internal pseudonymous account number. They never record email addresses, names, tokens, request or response contents, query strings, word text, page addresses or titles, or IP addresses.
- **No sale, no ads, no profiling.** See [How Clavis uses data](#how-clavis-uses-data).

## How long data is kept

**On your device.** Until you delete it, clear all Clavis data, sign out without keeping a copy, or uninstall Clavis.

**On the Clavis server (with an account).**

- **Live data** (saved words, chats, reading data and stored PDFs) is kept until you delete it or delete your account.
- **Deleted items.** When you delete a saved word or a document, its content (text, meaning, context, page address, title) is removed from the saved-word or document record immediately. Two kinds of short-lived technical record can still hold a copy for a short time: the record the server keeps of a sync request so that a repeated request gets the same answer (its response can include a word's data) is deleted after 24 hours, and the record of a finished PDF upload (which includes the PDF's hash) is deleted after 7 days. Deleting your account removes both immediately. A small marker that says only "this record was deleted" (its identifier, such as a word's hash or a PDF's hash, and timestamps) is kept for up to 90 days so that your other devices learn about the deletion, and is then permanently removed. A deleted highlight's marker also still carries the mark's page, text offsets and color during that time, but no text. Deleting a word deletes its chat. Deleting a document removes its highlights and its stored file.
- **Sessions.** Sign-in records are deleted after they expire or are revoked, with a short grace period of about seven days; they are all deleted when you delete your account.
- **Server logs** (described under [Where account data is stored](#where-account-data-is-stored-and-who-can-access-it-with-an-account)) are kept by Railway for 30 days and then deleted.
- **Database backups.** No scheduled backups of the Clavis database are kept, so data you delete, or delete along with your account, is not kept in a backup. If backups are turned on later, this policy will be updated first to say how long they are kept.

## Export and deleting your account (with an account)

Both are in the dashboard, on the **Account** page.

- **Export your data.** Downloads a ZIP file with your account details, saved words with their chats, documents with reading progress and highlights, and your stored PDFs. You can export up to three times a day and one export at a time, and the download can be requested only from the dashboard itself, not from another website. A download is cancelled only if it stalls.
- **Delete your account.** Permanently deletes your account and everything stored in it on the Clavis server: your email, name and identifier, saved words, chats, documents, highlights, sign-in sessions and stored PDFs. To confirm, you type `DELETE`, and you must first have signed in again with Google, to the same Google account, within the last 10 minutes (an ordinary sign-in does not count, and signing in to a different Google account is refused). Deleting your account cannot be undone. The stored PDFs are removed by a background process that retries until each file is gone.
- **Copies on your devices stay.** Deleting your account does not erase the saved words, highlights and reading data already on your devices. To remove them, use Clavis Settings → Privacy and data → **Clear all data** on each device. A device whose session ended because the account was deleted is signed out and keeps its local copy.
- **Delete a single item.** In the Clavis library or the dashboard, delete a saved word or a document, or remove only a stored PDF file.
- **Sign out.** In the extension you choose whether to remove the synced data from this device or keep a copy there. Your cloud copy is kept either way. **Sign out everywhere** ends every session on every device.

## What Clavis stores on your device

Clavis keeps this on your device in Chrome's extension storage and its IndexedDB database. It is not synced to other devices unless this policy says it is.

- **Preferences:** explanation language, translation target language, reading level, when the toolbar appears (automatically or only when you ask), Listen voice, language and speed, and the AI model you chose.
- **Sites where Clavis is turned off** (host names only).
- **Setup state:** whether setup is finished, when you accepted the data disclosure, and whether you granted or declined website access.
- **Key details:** whether your key is stored on this device or only for the session, its last four characters (for display), whether the last check passed and when, and the list of models Groq said your key can use.
- **Your Groq API key.**
- **Saved words, chats and PDF reading data,** as described in [Saved words, chats and reading data](#saved-words-chats-and-reading-data).
- **If you are signed in:** your account's email address and name, your session tokens, and sync bookkeeping (which account this device is bound to, how far it has synced, a random device identifier).
- **A short-lived copy of a PDF** while one is being uploaded to or opened from your account. It is deleted as soon as the transfer ends and in any case after 10 minutes.
- **Model capability notes:** which request options your chosen model accepted. Clavis keeps these in memory-based session storage, so they last only for the browser session.

Clavis does **not** store the text you select, nearby text, or Groq's answers, except what you choose to save in a word or chat. Looking up a word inside an answer sends that selected generated text and a small amount of context from the same answer paragraph. Earlier layers remain only in memory for Back navigation while the original selection is retained; they are never saved as browsing or lookup history. An answer lives in the page's memory while the card is open. See [Side panel](#side-panel) for the one place a copy is held longer, and only in memory.

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
| `storage` | Keeps your settings, Groq key and (if you sign in) account session in Chrome's extension storage on this device. The "only for this session" option uses in-memory session storage. Websites cannot read it. |
| `tts` | Listen reads the selected text aloud with the voices on your device, and Settings lists the voices that are available. Automatic prefers a matching on-device voice and falls back to a matching online voice if needed; a specific voice can also be chosen in Settings. |
| `scripting` | After you grant website access, registers the small selection script on websites (removed when you remove access or turn a site off). Injects it into the current tab when you ask (right-click, icon or shortcut). Loads the explanation card into the page where you clicked Explain. All of this code ships inside the extension. |
| `activeTab` | Lets Clavis work on the current tab, after your action, if you declined website access. |
| `contextMenus` | Adds one **Explain with Clavis** item to the right-click menu for selected text. |
| `sidePanel` | Shows a long explanation in Chrome's side panel, for the tab where you chose **Open in side panel**. |
| `identity` | Only for the optional **Sign in with Google** button: opens Google's sign-in page and returns you to Clavis. Used only when you click it. |
| `alarms` | Only while you are signed in: wakes the extension about every 30 minutes to sync, and to retry after a failed sync. |
| `https://api.groq.com/*` | The background worker sends the Explain request, chat messages and the key check to Groq, with your own key. |
| Optional: all `http` and `https` websites | Asked for only when you choose **Enable on websites**. It lets the toolbar appear automatically when you select text. The script only notices selections on your device. Nothing is read in the background or sent until you ask for an explanation or start Listen with an online voice. You can decline it or remove it at any time. |

The Clavis server (`https://clavis-api-production.up.railway.app`) is not a permission: the extension contacts it only when you are signed in, and the server accepts requests only from the Clavis extension.

## Security

Your API key and, when signed in, your Clavis session tokens are kept in Chrome's extension storage, which websites and Clavis's on-page script cannot read. This storage is **not encrypted**: anyone with access to your computer account or Chrome profile could find them. If you are concerned, choose **Only for this session** for the Groq key. Chrome clears session storage when the browser restarts and also when the extension is updated, reloaded or turned off, so you will need to paste the key again after any of these. Use a Groq key you can revoke. Session tokens can be revoked with **Sign out everywhere**. On the server, traffic uses HTTPS, tokens are stored only as one-way hashes, and every request is checked against your account.

## Deleting your data

- **Remove your API key:** Clavis Settings → Groq API key → **Remove key**. This does not cancel the key at Groq; do that on the Groq keys page.
- **Clear everything Clavis stores on this device:** Clavis Settings → Privacy and data → **Clear all data**. This removes your key, preferences, setup progress, saved words, chats, PDF reading data and highlights, the list of turned-off sites, and your account session, and drops any explanation held for the side panel. If you are signed in, Clavis signs you out first. It does not delete your cloud copy: use **Delete account** in the dashboard for that.
- **Delete your account and its server data:** see [Export and deleting your account](#export-and-deleting-your-account-with-an-account).
- **Remove website access:** **Clear all data does not remove website access**, because that is a Chrome permission. Remove it in Clavis Settings → Website access → **Remove website access**, or in Chrome at `chrome://extensions` → Clavis → Details → Site access.
- **Remove everything on the device:** uninstall Clavis from `chrome://extensions`. Chrome deletes all of its stored data and permissions. Uninstalling does not delete your account.

Data already sent to Groq is subject to Groq's retention policy; contact Groq to ask about it.

## Children

Clavis is not directed at children under 13 and does not knowingly collect their data. A Clavis account requires a Google account. If you believe a child under 13 has created an account, contact the publisher.

## Changes

If Clavis ever adds a new data recipient, telemetry or new permissions, or changes what is stored on the server or for how long, this policy will be updated first and the change will be shown in the extension's release notes. The current version is always at <https://clavis-api-production.up.railway.app/privacy>.

## Contact

Questions, or a request about your data: awwalm513@gmail.com. Please never send your API key or your Google password.
