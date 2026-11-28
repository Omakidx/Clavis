# Clavis

Understand and pronounce text you select on webpages and in local PDF files. Clavis adds a floating toolbar with Lookup, Speak, translations, and explanations in context. AI features use your own Groq API key.

**[Set up Clavis in Chrome →](docs/setup.md)**

## Get started

Clavis installs as an unpacked extension in desktop Google Chrome **147 or newer**. Version 1.1.0 is distributed as a ZIP on GitHub; it is not on the Chrome Web Store.

1. Download `clavis-1.1.0-chrome.zip` from the [latest GitHub release](https://github.com/Omakidx/Clavis/releases/latest).
2. Unzip it into a folder you will keep (Chrome keeps using the files in that folder).
3. Open `chrome://extensions` and turn on **Developer mode**.
4. Click **Load unpacked** and select the unzipped folder that contains `manifest.json`.

The [setup guide](docs/setup.md) walks through these steps, connecting Groq, choosing languages and voices, and testing your installation. To build from source instead, see [Development](#development).

### Upgrading from an older GitHub ZIP

The 1.1.0 ZIP has a fixed extension ID, because Google sign-in only works for IDs the Clavis server and Google recognize. A copy installed from an older ZIP has a different ID that Chrome derived from its folder, so **1.1.0 installs as a new, separate extension**. Your old local data (Groq key, settings, saved items, reading progress) does not carry over automatically. Load 1.1.0, set it up (add your Groq key again), and only then remove the old copy at `chrome://extensions`. Removing an extension deletes its stored data. Later 1.1.x updates keep the same ID, so **Reload** is enough.

## What you can do

- Select a word, phrase, or sentence and choose **Lookup** for its meaning in context.
- Explore roots and related words, or translate into the language you choose in Settings.
- Select words inside an answer to look them up too; **Back** restores the previous result.
- Use **Speak** to hear selected text, or the speaker beside a translation to hear that translation.
- Open local PDFs in the Clavis reader and work with their selectable text.
- Optionally, sign in with Google to keep saved words, highlights, reading progress and PDFs in sync across devices and in a web dashboard (see [Clavis Sync](#clavis-sync-optional-account)). Accounts are never required: signed out, Clavis stays local.

## Clavis Sync (optional account)

Clavis Sync is off until you sign in. Open **Settings → Account & sync** and choose **Sign in with Google**. While signed in, your saved words (with meaning, context and per-word chat), highlights, reading progress and any PDFs you choose to **Save to account** sync across your devices and appear in the web dashboard at <https://clavis-api-production.up.railway.app>, where you can also export your data and delete your account. Your Groq key and settings are never synced. Sign-in works only with the 1.1.0 release ZIP (see above).

## Privacy

Selecting text alone does not send an AI request. Lookup sends your selection and a limited amount of surrounding context to Groq. Speech uses available Chrome voices: Automatic tries a matching local voice first, then an online voice when needed. Online voices send the text to their provider. Your Groq key stays in Chrome extension storage on your device or in session storage, according to your choice; Clavis does not encrypt it.

With an account, saved words, chats, reading data and any PDFs you choose to save are also stored on a server run by the publisher; your Groq key is never sent there. Read the full [privacy policy](https://clavis-api-production.up.railway.app/privacy).

## Development

Use Node.js **24** (see [.nvmrc](.nvmrc)).

```sh
npm ci
npm run dev        # WXT development server
npm run check      # Types, lint, formatting, unit and integration tests
npm run build      # Production unpacked extension (.output/chrome-mv3)
npm run zip        # Production ZIP in .output/
```

The [technical documentation](docs/README.md) covers architecture, requirements, and release checks. The optional sync server in [`server/`](server/README.md) and the web dashboard in `dashboard/` have their own setup; [server/README.md](server/README.md) lists how to run the server and its environment (see also [docs/clavis-sync-design.md](docs/clavis-sync-design.md)). The [design preview](dev/preview/README.md) is for UI development; it uses simulated data and cannot validate a real Groq key.

## License

[MIT](LICENSE).
