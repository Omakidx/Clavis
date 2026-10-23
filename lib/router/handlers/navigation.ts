import { SETTINGS_SECTION_ANCHORS } from '../../config/constants';
import type { MessageReply, OpenSettingsResult } from '../../contracts';
import { logger } from '../../security/logger';
import { senderKey } from '../limiter';
import { failure, success } from '../replies';
import type { RouteContext } from '../router';

/** At least this long between two OPEN_SETTINGS from one sender, so a script cannot spam tabs. */
export const OPEN_SETTINGS_MIN_INTERVAL_MS = 1_000;
const MAX_TRACKED_SENDERS = 64;

export interface NavigationHandlerDeps {
  runtime: { openOptionsPage(): Promise<void> };
  tabs: { create(properties: { url: string }): Promise<unknown> };
  /** Absolute url of the options page, e.g. `chrome-extension://<id>/options.html`. */
  optionsUrl: string;
  now?: () => number;
}

export function createNavigationHandlers(deps: NavigationHandlerDeps) {
  const now = deps.now ?? Date.now;
  /** Last accepted call per sender, oldest first. */
  const lastOpened = new Map<string, number>();

  return {
    /**
     * OPEN_SETTINGS: open (or focus) the Settings page, at a section when one is named. The
     * section is a closed enum mapped to a fixed anchor, so no caller-supplied text reaches a url.
     */
    async openSettings(
      section: keyof typeof SETTINGS_SECTION_ANCHORS | undefined,
      context: RouteContext,
    ): Promise<MessageReply<OpenSettingsResult>> {
      const key = senderKey(context.sender);
      const at = now();
      const previous = lastOpened.get(key);
      if (previous !== undefined && at - previous < OPEN_SETTINGS_MIN_INTERVAL_MS) {
        return failure('RATE_LIMITED', {
          retryAfterMs: Math.max(1, OPEN_SETTINGS_MIN_INTERVAL_MS - (at - previous)),
          reason: 'local-limit',
        });
      }
      lastOpened.delete(key);
      lastOpened.set(key, at);
      while (lastOpened.size > MAX_TRACKED_SENDERS) {
        const oldest = lastOpened.keys().next();
        if (oldest.done) break;
        lastOpened.delete(oldest.value);
      }

      try {
        if (section === undefined) await deps.runtime.openOptionsPage();
        else
          await deps.tabs.create({
            url: `${deps.optionsUrl}#${SETTINGS_SECTION_ANCHORS[section]}`,
          });
      } catch {
        logger.warn('open_settings_failed');
        return failure('INTERNAL_ERROR');
      }
      return success<OpenSettingsResult>({ opened: true });
    },
  };
}

export type NavigationHandlers = ReturnType<typeof createNavigationHandlers>;
