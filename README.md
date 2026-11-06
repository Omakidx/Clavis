# Clavis

Understand and pronounce text you select on webpages and in local PDF files. Clavis adds a floating toolbar with Lookup, Speak, translations, and explanations in context. AI features use your own Groq API key.

**[Set up Clavis in Chrome →](docs/setup.md)**

## Get started

Clavis currently installs as an unpacked extension in desktop Google Chrome **147 or newer**. Build the extension from this repository, then load the generated folder in Chrome:

```sh
git clone https://github.com/Omakidx/Clavis.git
cd Clavis
npm ci
npm run build
```

Use Node.js **24** (see [.nvmrc](.nvmrc)). In `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select `.output/chrome-mv3` inside the cloned repository. The [setup guide](docs/setup.md) walks through these steps, connecting Groq, choosing languages and voices, and testing your installation.

## What you can do

- Select a word, phrase, or sentence and choose **Lookup** for its meaning in context.
- Explore roots and related words, or translate into the language you choose in Settings.
- Select words inside an answer to look them up too; **Back** restores the previous result.
- Use **Speak** to hear selected text, or the speaker beside a translation to hear that translation.
- Open local PDFs in the Clavis reader and work with their selectable text.

## Privacy

Selecting text alone does not send an AI request. Lookup sends your selection and a limited amount of surrounding context to Groq. Speech uses available Chrome voices: Automatic tries a matching local voice first, then an online voice when needed. Online voices send the text to their provider. Your Groq key stays in Chrome extension storage on your device or in session storage, according to your choice; Clavis does not encrypt it.

See the [privacy policy draft](docs/privacy-policy.md) for details.

## Development

```sh
npm run dev        # WXT development server
npm run check      # Types, lint, formatting, unit and integration tests
npm run build      # Production unpacked extension
npm run zip        # Production ZIP in .output/
```

The [technical documentation](docs/README.md) covers architecture, requirements, and release checks. The [design preview](dev/preview/README.md) is for UI development; it uses simulated data and cannot validate a real Groq key.

## License

[MIT](LICENSE).
