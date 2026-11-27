import { browser } from 'wxt/browser';
import { MESSAGE_VERSION } from '../config/constants';
import { isSignedIn } from './sync-flag';

/**
 * After a local write, wake the sync engine (SYNC_KICK, design 4.1). Fire and forget, and only
 * while signed in: a signed-out device has nothing to push, so nothing is sent. Never throws.
 * Hand-written and zod-free so the reader can use it.
 */
export async function kickSync(pull = false): Promise<void> {
  try {
    if (!(await isSignedIn())) return;
    await browser.runtime.sendMessage({
      v: MESSAGE_VERSION,
      type: 'SYNC_KICK',
      ...(pull ? { pull: true } : {}),
    });
  } catch {
    // The worker is restarting or sync is not there yet: the next write kicks again.
  }
}
