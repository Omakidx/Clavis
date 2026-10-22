import { defineConfig } from 'wxt';

// Manifest permissions are normative in docs/architecture.md §3.
// Change them there first, then here, and update the privacy policy.
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: '__MSG_extName__',
    description: '__MSG_extDescription__',
    default_locale: 'en',
    // Tentative (docs/requirements.md §11); confirmed after Phase 2.
    minimum_chrome_version: '116',
    permissions: ['storage', 'tts', 'scripting', 'activeTab', 'contextMenus'],
    // 'sidePanel' is added when the side panel ships (FR-042, Phase 8).
    // 'offscreen' is added only if Spike D adopts the speechSynthesis fallback (D-07).
    host_permissions: ['https://api.groq.com/*'],
    // Requested at onboarding from a user gesture (D-02); never at install.
    optional_host_permissions: ['http://*/*', 'https://*/*'],
    action: { default_title: '__MSG_extName__' },
  },
});
