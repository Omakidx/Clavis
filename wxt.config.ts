import { defineConfig } from 'wxt';

/** Left in every chunk of a CLAVIS_FORCE_FEATURES build; audit-zip.mjs fails the release ZIP if it finds it. */
const FORCED_FEATURES_MARKER = 'CLAVIS_FORCED_FEATURES_BUILD_NEVER_SHIP';

/**
 * Public half of the release signing key. Every build and the GitHub release ZIP carry it as the
 * manifest `key`, so Chrome gives the extension the same ID on every machine and from any folder:
 * `ebfpdncfkebjagolnbmfdhikaipiflbl`. Clavis Sync needs that stable ID for its Google OAuth
 * redirect (`https://<id>.chromiumapp.org/`) and the API's allowed origins. The private half was
 * never kept; unpacked loading ("Load unpacked" from the release ZIP) does not need it.
 *
 * `npm run zip` KEEPS `key` by default (GitHub distribution), and scripts/audit-zip.mjs accepts
 * exactly this value (it must equal `key` in scripts/expected-permissions.json) and refuses any
 * other. For a future Chrome Web Store upload, which assigns its own ID and rejects packages with
 * a `key`, run `CLAVIS_STRIP_KEY=1 npm run zip`: the `zip:extension:start` hook below then removes
 * it (the audit accepts a manifest without `key`).
 */
const DEV_MANIFEST_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA8ZPxbrxFmeU0tk88IcgJXRaQvXxwPLsAEWn4UCVcMURdHtuu33TsqduTOkb+XGMLl7DIENWTpmZj9Xn+61zuwyFG5tyZi9O/L0vCki9CyQiRROBx6apcZ00aMwmqggYbfyI283JKs7c5ftXXHn/TWXqlW9adfFLzrra5QGnFtaU+Ok9yTAP9OG1p9Go6yBYpG1Lz16lQ3cR8JpaJbmkkAzqt0ErQdHNi3sAgwpT2I85OLvp9/lJ9vwqRqTQW8FfIzMfU7grpkup71rp6Dqt8qqm8tgseA02YHADZ+mGfDusqCmxm/rxC7xJgbpLFdkGBAYtoGaNNN/8iK6tZ80j88QIDAQAB';

// Manifest permissions are normative in docs/architecture.md §3.
// Change them there first, then here, and update the privacy policy.
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  // WXT_OUT_DIR lets parallel builds (e.g. separate spike workstreams) avoid
  // overwriting each other. Defaults to WXT's standard `.output`.
  outDir: process.env.WXT_OUT_DIR ?? '.output',
  manifest: {
    key: DEV_MANIFEST_KEY,
    name: '__MSG_extName__',
    description: '__MSG_extDescription__',
    default_locale: 'en',
    // D-18: 147 is required by pdfjs-dist 6 (Math.sumPrecise in its font code; MDN
    // browser-compat-data). Other floors: Uint8Array base64 140, Promise.try 128,
    // URL.parse 126, matchOriginAsFallback 119.
    minimum_chrome_version: '147',
    // D-07: Listen uses chrome.tts only (the offscreen Web Speech fallback found the same voices
    // and was not adopted), so there is no 'offscreen' permission.
    // 'sidePanel' (FR-042, Phase 8): the side panel for long explanations. It is opened per tab by
    // `chrome.sidePanel.setOptions({ tabId, path }) + open()` after a click on "Open in side
    // panel"; the manifest has no `side_panel.default_path` (see the build:manifestGenerated hook).
    // 'identity' and 'alarms' (Clavis Sync, design 7.1): Google sign-in through
    // launchWebAuthFlow, and the periodic pull and retry backoff while the worker sleeps. Neither
    // shows an install warning. No new host_permissions: the background reaches the sync API
    // through the server's CORS allowlist.
    permissions: [
      'storage',
      'tts',
      'scripting',
      'activeTab',
      'contextMenus',
      'sidePanel',
      'identity',
      'alarms',
    ],
    host_permissions: ['https://api.groq.com/*'],
    // Requested at onboarding from a user gesture (D-02); never at install.
    optional_host_permissions: ['http://*/*', 'https://*/*'],
    action: { default_title: '__MSG_extName__' },
    // Keyboard path to the toolbar for the current selection (FR-016).
    commands: {
      'explain-selection': {
        suggested_key: { default: 'Alt+Shift+E' },
        description: '__MSG_toolbarCommandExplain__',
      },
    },
    // D-17: allow WebAssembly (never eval) on extension pages so PDF.js can use its
    // wasm decoders for ICC/CMYK colour, JPEG 2000 and JBIG2. The reader page is a trusted
    // context that renders untrusted PDFs, so the policy also forbids what it never needs:
    // media (PDF audio/video annotations), frames, form submission and a <base> override
    // (Phase 7 security review). No connect-src: the page itself fetches only extension files and
    // PDF.js's worker needs the same. Must match scripts/expected-permissions.json exactly.
    content_security_policy: {
      extension_pages:
        "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; media-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'",
    },
  },
  // Test builds only: CLAVIS_FORCE_FEATURES=1 builds with every Should-priority flag on
  // (FEATURES.grammarTab, still off in the shipped build, and
  // FEATURES.accountSync and FEATURES.translateTab, which ship on), and lets the WXT_CLAVIS_API_ORIGIN / _GOOGLE_AUTH_URL /
  // _GOOGLE_LOGIN_HINT overrides point at a local API and a fake Google,
  // so the Grammar tab can be exercised end to end WITHOUT editing lib/config/constants.ts. The
  // shipped flags stay the literals in that file (flip them there).
  vite: () => ({
    plugins:
      process.env.CLAVIS_FORCE_FEATURES === '1'
        ? [
            {
              name: 'clavis-force-features',
              enforce: 'pre' as const,
              transform(code: string, id: string) {
                if (!id.replaceAll('\\', '/').endsWith('lib/config/constants.ts')) return null;
                // The flag's initializer also sets a global named FORCED_FEATURES_MARKER, a side
                // effect the minifier keeps, so every bundle that reads FEATURES carries the name
                // and scripts/audit-zip.mjs refuses the ZIP of such a build.
                // Translate ships on, so only Grammar needs forcing; Translate is forced as well so
                // the build stays "every flag on" if its shipped literal is ever flipped back.
                // accountSync ships on, so it needs no marker; forcing it keeps the build "every flag on".
                return code
                  .replace('accountSync: false', 'accountSync: true')
                  .replace(
                    'ENDPOINT_OVERRIDES: boolean = false',
                    `ENDPOINT_OVERRIDES: boolean = ((globalThis as Record<string, unknown>)['${FORCED_FEATURES_MARKER}'] = true)`,
                  )
                  .replace(
                    'grammarTab: false',
                    `grammarTab: ((globalThis as Record<string, unknown>)['${FORCED_FEATURES_MARKER}'] = true)`,
                  )
                  .replace('translateTab: false', 'translateTab: true');
              },
            },
          ]
        : [],
  }),
  hooks: {
    // The release ZIP keeps the manifest `key` (see DEV_MANIFEST_KEY). Only CLAVIS_STRIP_KEY=1
    // (a Chrome Web Store upload) removes it. WXT writes the production manifest as compact JSON,
    // so rewriting it compactly keeps the ZIP reproducible.
    'zip:extension:start': async (wxt) => {
      if (process.env.CLAVIS_STRIP_KEY !== '1') return;
      const { readFile, writeFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const file = join(wxt.config.outDir, 'manifest.json');
      const manifest = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
      if (!('key' in manifest)) return;
      delete manifest.key;
      await writeFile(file, JSON.stringify(manifest));
    },
    // WXT turns entrypoints/sidepanel into `side_panel.default_path`, which would offer ONE shared
    // panel on every tab (it would keep showing one tab's explanation after a tab switch). The
    // panel is per tab instead: lib/router/handlers/sidepanel.ts enables it for one tab with
    // `setOptions({ tabId, path: 'sidepanel.html?tab=<id>' })`, so there is no default.
    'build:manifestGenerated': (_wxt, manifest) => {
      delete (manifest as { side_panel?: unknown }).side_panel;
    },
    // Spike C (D-06): PDF.js reads CMaps, standard fonts, ICC profiles and image-decoder wasm at
    // runtime from URLs. Copy them from pdfjs-dist into the build under pdfjs/ so nothing is
    // fetched remotely. The scripting sandbox (quickjs-eval) is deliberately left out. Only the
    // wasm decoders are copied: the CSP allows wasm (D-17), so the *_nowasm_fallback.js twins are
    // not needed; see docs/decisions/spike-c-pdf.md.
    'build:publicAssets': async (wxt, files) => {
      const { readdirSync } = await import('node:fs');
      const { join } = await import('node:path');
      const base = join(wxt.config.root, 'node_modules/pdfjs-dist');
      const copy = (dir: string, keep: (name: string) => boolean) => {
        for (const name of readdirSync(join(base, dir)).filter(keep)) {
          files.push({ absoluteSrc: join(base, dir, name), relativeDest: `pdfjs/${dir}/${name}` });
        }
      };
      // Copy only known file types, so a pdfjs-dist update can't ship something new unnoticed.
      const licence = /^LICENSE/;
      copy('cmaps', (name) => /\.bcmap$/.test(name) || licence.test(name));
      copy('standard_fonts', (name) => /\.(?:pfb|ttf)$/.test(name) || licence.test(name));
      copy('iccs', (name) => /\.icc$/.test(name) || licence.test(name));
      copy(
        'wasm',
        (name) => (/\.wasm$/.test(name) || licence.test(name)) && !name.startsWith('quickjs'),
      );
    },
  },
});
