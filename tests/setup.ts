import '@testing-library/jest-dom/vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { beforeEach } from 'vitest';

// Every test starts with empty extension storage and no listeners.
beforeEach(() => {
  fakeBrowser.reset();
});
