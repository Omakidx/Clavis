import type { ReactNode } from 'react';
import { t } from '../../lib/i18n';
import { openSettingsPage } from '../../lib/ui-client/navigation';
import type { Resource } from '../../lib/ui-client/use-resource';
import { ErrorNotice } from '../common/ui';

interface ResourceGateProps<T> {
  resource: Resource<T>;
  children(data: T): ReactNode;
}

/** Loading, error (with Try again) and ready states for data that comes from the background. */
export function ResourceGate<T>({ resource, children }: ResourceGateProps<T>) {
  const { state, reload } = resource;
  if (state.status === 'loading') {
    return (
      <p className="clavis-muted" role="status">
        {t('uiLoading')}
      </p>
    );
  }
  if (state.status === 'error') {
    return <ErrorNotice error={state.error} onRetry={reload} onOpenSettings={openSettingsPage} />;
  }
  return <>{children(state.data)}</>;
}
