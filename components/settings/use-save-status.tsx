import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import { t } from '../../lib/i18n';
import type { ClientError } from '../../lib/ui-client/errors';
import type { ClientResult } from '../../lib/ui-client/request';
import { openSettingsPage } from '../../lib/ui-client/navigation';
import { ErrorNotice, LiveStatus } from '../common/ui';

type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved'; message: string }
  | {
      kind: 'error';
      error: ClientError;
    };

interface SaveStatus<A extends unknown[], T> {
  /** The wrapped action: same arguments and result, plus status tracking. */
  run(...args: A): Promise<ClientResult<T>>;
  /** Render once, near the controls: a polite live region plus an error notice when needed. */
  notice: ReactNode;
}

/**
 * Track "Saving… / Saved. / error" for an action that returns a ClientResult, so every field
 * shows immediate confirmation (FR-006) and an actionable error instead of failing silently.
 */
export function useSaveStatus<A extends unknown[], T>(
  action: (...args: A) => Promise<ClientResult<T>>,
  savedMessage?: string,
  retry?: () => void,
): SaveStatus<A, T> {
  const [state, setState] = useState<SaveState>({ kind: 'idle' });

  const run = useCallback(
    async (...args: A) => {
      setState({ kind: 'saving' });
      const result = await action(...args);
      setState(
        result.ok
          ? { kind: 'saved', message: savedMessage ?? t('uiSaved') }
          : { kind: 'error', error: result.error },
      );
      return result;
    },
    [action, savedMessage],
  );

  const notice = (
    <>
      <LiveStatus
        message={
          state.kind === 'saving' ? t('uiSaving') : state.kind === 'saved' ? state.message : null
        }
        tone={state.kind === 'saved' ? 'success' : 'info'}
      />
      {state.kind === 'error' ? (
        <ErrorNotice error={state.error} onRetry={retry} onOpenSettings={openSettingsPage} />
      ) : null}
    </>
  );

  return { run, notice };
}
