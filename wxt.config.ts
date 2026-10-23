import { defineConfig } from 'wxt';

/** Left in every chunk of a CLAVIS_FORCE_FEATURES build; audit-zip.mjs fails the release ZIP if it finds it. */
const FORCED_FEATURES_MARKER = 'CLAVIS_FORCED_FEATURES_BUILD_NEVER_SHIP';

// Manifest permissions are normative in docs/architecture.md §3.
// Change them there first, then here, and update the privacy policy.
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  // WXT_OUT_DIR lets parallel builds (e.g. separate spike workstreams) avoid
  // overwriting each other. Defaults to WXT's standard `.output`.
  outDir: process.env.WXT_OUT_DIR ?? '.output',
  manifest: {
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
    permissions: ['storage', 'tts', 'scripting', 'activeTab', 'contextMenus', 'sidePanel'],
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
  // (FEATURES.grammarTab, still off in the shipped build, and FEATURES.translateTab, which ships on),
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
                return code
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
