# Set up Clavis in Chrome

This guide installs Clavis as an unpacked extension in **desktop Google Chrome 147 or newer**, then walks through the first setup. The minimum version comes from the extension's [manifest configuration](../wxt.config.ts).

## 1. Get the extension files

### Build from this repository

Install [Node.js 24](https://nodejs.org/en/download) and [Git](https://git-scm.com/downloads), then run these commands in a terminal:

```sh
git clone https://github.com/Omakidx/Clavis.git
cd Clavis
npm ci
npm run build
```

The extension is now in **`.output/chrome-mv3`** inside the `Clavis` folder. That folder contains `manifest.json`, `background.js`, and the extension's pages. You will select this generated folder in Chrome, rather than the source repository folder.

If you prefer GitHub's **Code → Download ZIP**, extract the source ZIP, open a terminal in its extracted folder, and run `npm ci` followed by `npm run build` there.

### If you already have a built extension ZIP

If the maintainer supplied a built package such as `clavis-1.0.10-chrome.zip` or `Clavis-extension.zip`, extract it into a permanent folder. Select the folder containing `manifest.json` directly. A built package does not need Node.js or the build commands above.

GitHub's **Download ZIP** is a source archive and still needs building. Keep the extracted extension folder in place after loading it; Chrome continues to use its files.

## 2. Load it in Chrome

1. Open `chrome://extensions` in Chrome's address bar.
2. Turn on **Developer mode**.
3. Click **Load unpacked**.
4. Select `.output/chrome-mv3` from the build above, or the extracted built-package folder containing `manifest.json`.
5. Confirm that **Clavis** appears and is enabled.
6. Open Chrome's puzzle-piece **Extensions** menu and pin Clavis for easy access.

These are Chrome's official [unpacked extension installation steps](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked).

## 3. Complete the welcome steps

Open the Clavis toolbar icon to begin. To reopen onboarding later, go to **Settings → Privacy & help** and choose **Run the welcome tutorial again**.

1. Read the introduction and data disclosure.
2. Choose whether to enable automatic website access. With access enabled, selecting text on supported websites can show the toolbar automatically. If you decline, select text and use Clavis's **Explain on this page** action, the right-click menu, or the keyboard shortcut `Alt+Shift+E`.
3. Connect your Groq key, or skip it for now. Speech and the local PDF reader can be used without a Groq key when suitable voices and selectable text are available.
4. Choose your language and reading preferences.
5. Open the practice page and try selecting a word before finishing setup.

## 4. Connect Groq for Lookup and translation

1. Open the [Groq keys page](https://console.groq.com/keys) and create an API key for your account.
2. In Clavis, open **Settings → Connection** and paste the complete key into **Your Groq key**.
3. Choose whether to keep it on this device or only for the browser session, then click **Connect**.
4. Use **Test connection** to retry a check. A working connection shows **Working**.
5. Leave the model at **Recommended by Clavis (default)**, or select a model your Groq project can use.

Paste your key only into Clavis's extension settings. Do not put it in a source file, `.env` file, GitHub issue, screenshot, or chat. Clavis does not use your operating system's password vault or encrypt a stored key. Groq's account limits and terms apply to AI requests.

Use the installed extension to check a real key. The development preview at `localhost:3000/dev/preview/` uses simulated connection states.

## 5. Choose translation and speech preferences

Open **Settings → Preferences**:

- **Explanation language** controls the language used for explanations.
- **Translation language** is the target language for the result card's **Translate** tab.
- Choose your reading level and when the floating toolbar should appear.

The Voice controls in Preferences let you choose a language, speed, and a specific voice or **Automatic (best match)**. Automatic tries a matching local voice first, then a matching online voice if a local voice is unavailable or cannot start. A specific saved voice is used when it supports the text's language. Online voices send the spoken text to their provider.

Use **Test voice** to check the chosen voice. In a translated result, press the speaker beside the translation to hear it with your saved speech preferences and the translation's language. Press the stop icon to end playback.

## 6. Try it on a page or PDF

### Webpages

1. Open a regular webpage and refresh it if it was already open when you installed Clavis.
2. Select a word or short sentence.
3. Choose **Lookup** to get an explanation, or **Speak** to hear the selection.
4. Open **Translate** in the result card for a translation into your target language.
5. Select a word inside an answer and choose **Lookup** to explore it. **Back** returns to the previous answer.

If automatic access is off, select text first and use **Explain on this page** from the Clavis popup. Chrome's internal pages, the Chrome Web Store, and other protected pages do not support the injected toolbar.

### Local PDFs

Open the Clavis popup, choose **Open PDF reader**, and select a local PDF file. Select text in that reader to use the toolbar. Clavis does not add its toolbar to Chrome's built-in PDF viewer, and image-only scans need a text layer before words can be selected; OCR is not included.

## Update an unpacked installation

1. Get the updated extension files. If you built from source, run `git pull --ff-only`, `npm ci`, and `npm run build` in the same repository folder.
2. Keep using the same loaded extension folder. For a supplied built ZIP, replace that folder's contents with the new extracted files.
3. Go to `chrome://extensions` and click **Reload** on Clavis.
4. Refresh webpages where you use Clavis, then reopen any Clavis settings or reader pages.

Reloading the same installation keeps its saved settings. Removing the extension deletes its stored data, so use **Reload** when updating.

## Troubleshooting

| Problem                                              | What to check                                                                                                                                                                                                                                         |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chrome cannot find a manifest                        | Select the folder that directly contains `manifest.json`. Build a source download first; extract a built ZIP before loading it.                                                                                                                       |
| Chrome says the version is unsupported               | Update Chrome to at least the minimum version shown above.                                                                                                                                                                                            |
| No toolbar appears                                   | Refresh the webpage, check **Settings → Website access**, and confirm automatic display is enabled in Preferences. Try the practice page or the popup's **Explain on this page** action.                                                              |
| A key is saved but not verified, or HTTP 403 appears | Retry **Test connection**. Check the Groq account/project and model access. If the key works elsewhere, try Clavis in a fresh Chrome profile to check whether the issue is specific to the existing profile. A 403 alone does not identify its cause. |
| Lookup reports a model error                         | Choose an available model in Connection settings and retry. Keep the full error text when reporting the issue, but exclude your key.                                                                                                                  |
| No voice, wrong language, or no sound                | Check your system volume and voice controls in Preferences. Use **Test voice**, confirm a voice supports the language, and try Automatic. Available voices depend on Chrome and your operating system; Linux may need an additional voice engine.     |
| Translation uses the wrong target                    | Change **Translation language** in Preferences and start a new lookup so the new result uses that setting.                                                                                                                                            |
| A PDF has no selectable words                        | Open it in the Clavis PDF reader and check that it contains a text layer. Image-only PDFs are not supported for text selection.                                                                                                                       |
| Updated files have no effect                         | Reload Clavis in `chrome://extensions`, refresh the webpage, and confirm the version shown on the extension card.                                                                                                                                     |

For a bug report, include your operating system, Chrome version, Clavis version, the steps to reproduce, and the error text. Remove API keys and private page content before sharing logs or screenshots.
