import { useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { KeyStorage } from '../../lib/contracts/key-storage';
import type { AccessProbe, ForbiddenReason } from '../../lib/contracts/setup';
import { t } from '../../lib/i18n';
import { checkKeyInput, looksLikeGroqKey, type KeyOutcome } from '../../lib/ui-client/key-flow';
import { openSettingsPage } from '../../lib/ui-client/navigation';
import { Button, ErrorNotice } from '../common/ui';
import { useToast } from '../common/Toast';

/** Approved copy is "Label — explanation": show the label strongly, keep the whole text intact. */
function splitChoice(text: string): { label: string; rest: string } {
  const at = text.indexOf(' — ');
  return at === -1 ? { label: text, rest: '' } : { label: text.slice(0, at), rest: text.slice(at) };
}

interface KeyOutcomeNoticeProps {
  outcome: KeyOutcome;
  onRetry?: (() => void) | undefined;
}

const FORBIDDEN_REASON_MESSAGE = {
  model_permission_org: 'keyHttpModelOrg',
  model_permission_project: 'keyHttpModelProject',
  model_permission: 'keyHttpModelPermission',
  permission_restriction: 'keyHttpPermissionRestriction',
  region_block: 'keyHttpRegionBlock',
  edge_block: 'keyHttpEdgeBlock',
  unknown: 'keyHttpUnknown',
} as const satisfies Record<ForbiddenReason, string>;

const ACCESS_PROBE_MESSAGE = {
  'auth-required': 'keyProbeAuthRequired',
  forbidden: 'keyProbeForbidden',
  unreachable: 'keyProbeUnreachable',
  'other-response': 'keyProbeOtherResponse',
} as const satisfies Record<AccessProbe, string>;

export function KeyVerificationResponse({
  status,
  reason,
  probe,
  showCopy = false,
}: {
  status: number | undefined;
  reason?: ForbiddenReason | undefined;
  probe?: AccessProbe | undefined;
  showCopy?: boolean;
}) {
  const [copyState, setCopyState] = useState<'copied' | 'unavailable' | null>(null);
  async function copyDiagnostics() {
    if (status !== 403 || probe === undefined) return;
    const report = t('keyDiagnosticsReport', [String(status), probe, reason ?? 'unknown']);
    try {
      if (navigator.clipboard?.writeText === undefined) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(report);
      setCopyState('copied');
    } catch {
      setCopyState('unavailable');
    }
  }

  return (
    <>
      <span>
        {status === undefined ? t('keyNoHttpResponse') : t('keyHttpStatus', String(status))}
      </span>
      {status === 403 ? <span> {t(FORBIDDEN_REASON_MESSAGE[reason ?? 'unknown'])}</span> : null}
      {status === 403 && probe !== undefined ? (
        <span> {t(ACCESS_PROBE_MESSAGE[probe])}</span>
      ) : null}
      {showCopy && status === 403 && probe !== undefined ? (
        <Button onClick={() => void copyDiagnostics()}>{t('keyCopyDiagnostics')}</Button>
      ) : null}
      {copyState !== null ? (
        <span role="status">
          {t(copyState === 'copied' ? 'keyDiagnosticsCopied' : 'keyDiagnosticsCopyFailed')}
        </span>
      ) : null}
    </>
  );
}

/** The result of connecting or testing a key. Valid, rejected and unreachable look different. */
export function KeyOutcomeNotice({ outcome, onRetry }: KeyOutcomeNoticeProps) {
  if (outcome.kind === 'error') {
    return (
      <ErrorNotice error={outcome.error} onRetry={onRetry} onOpenSettings={openSettingsPage} />
    );
  }
  const last4 = outcome.status?.last4 ?? null;
  const count = outcome.status?.models.length ?? 0;
  if (outcome.kind === 'valid') {
    return (
      <div className="clavis-notice clavis-notice--success" data-outcome="valid">
        <p>{last4 === null ? t('keyConnectedLive') : t('keyResultValid', last4)}</p>
        {count > 0 ? <p>{t('keyModelsCount', String(count))}</p> : null}
      </div>
    );
  }
  if (outcome.kind === 'invalid') {
    return (
      <div className="clavis-notice clavis-notice--danger" data-outcome="invalid">
        <p>{t('keyResultInvalid')}</p>
        {outcome.status?.verificationHttpStatus !== undefined ? (
          <p>
            <KeyVerificationResponse
              status={outcome.status.verificationHttpStatus}
              reason={outcome.status.forbiddenReason}
              probe={outcome.status.accessProbe}
            />
          </p>
        ) : null}
      </div>
    );
  }
  if (outcome.kind === 'unverified') {
    return (
      <div className="clavis-notice clavis-notice--warning" data-outcome="unverified">
        <p>{t('keyResultUnverified')}</p>
        <p>
          <KeyVerificationResponse
            status={outcome.status?.verificationHttpStatus}
            reason={outcome.status?.forbiddenReason}
            probe={outcome.status?.accessProbe}
          />
        </p>
      </div>
    );
  }
  return (
    <div className="clavis-notice" data-outcome="unchecked">
      <p>{t('keyStatusNever')}</p>
    </div>
  );
}

interface KeyConnectFormProps {
  /** Save and verify the key. The page never keeps the key after this resolves. */
  onConnect(apiKey: string, storage: KeyStorage): Promise<KeyOutcome>;
  busy: boolean;
  /** Called with every finished attempt (the wizard uses it to unlock "Continue"). */
  onOutcome?: (outcome: KeyOutcome) => void;
}

/**
 * Key entry shared by onboarding and Settings (FR-003, FR-007, FR-071, secret boundary rule 5):
 * masked input with a show/hide toggle, an explicit local-or-session choice, and a deliberate
 * Connect button. The input is UNCONTROLLED on purpose: a controlled input makes React mirror
 * the typed key into the DOM `value` attribute, where it would show up in the serialized page.
 * The key is read from the field only on submit, cleared as soon as it was handed over, and never
 * kept in React state (only "is there text" and "does it look like a Groq key" are), rendered
 * back, logged or put in a URL.
 */
export function KeyConnectForm({ onConnect, busy, onOutcome }: KeyConnectFormProps) {
  const toast = useToast();
  const inputId = useId();
  const hintId = useId();
  const errorId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [odd, setOdd] = useState(false);
  const [shown, setShown] = useState(false);
  const [storage, setStorage] = useState<KeyStorage>('local');
  const [problem, setProblem] = useState<'empty' | 'format' | null>(null);
  const [outcome, setOutcome] = useState<KeyOutcome | null>(null);
  const groupName = useId();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const checked = checkKeyInput(inputRef.current?.value ?? '');
    if (!checked.ok) {
      setProblem(checked.reason);
      return;
    }
    setProblem(null);
    setOutcome(null);
    toast?.show({ content: t('keyResultChecking'), durationMs: 0 });
    const result = await onConnect(checked.value, storage);
    // Handed over (saved, rejected or unreachable): do not keep the secret in the page.
    if (result.kind !== 'error') {
      if (inputRef.current) inputRef.current.value = '';
      setOdd(false);
      setShown(false);
    }
    setOutcome(result);
    toast?.show({
      content: <KeyOutcomeNotice outcome={result} />,
      tone:
        result.kind === 'valid'
          ? 'success'
          : result.kind === 'invalid' || result.kind === 'error'
            ? 'danger'
            : 'warning',
    });
    onOutcome?.(result);
  }

  const local = splitChoice(t('keyStoreLocal'));
  const session = splitChoice(t('keyStoreSession'));

  return (
    <form onSubmit={(event) => void submit(event)} noValidate aria-busy={busy}>
      <div className="clavis-field">
        <label className="clavis-label" htmlFor={inputId}>
          {t('keyInputLabel')}
        </label>
        <div className="clavis-input-row">
          <input
            id={inputId}
            className="clavis-input"
            type={shown ? 'text' : 'password'}
            ref={inputRef}
            onChange={(event) => {
              const typed = event.target.value;
              setOdd(typed.trim() !== '' && !looksLikeGroqKey(typed));
            }}
            autoComplete="new-password"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            aria-describedby={`${hintId}${problem ? ` ${errorId}` : ''}`}
            aria-invalid={problem ? true : undefined}
            disabled={busy}
          />
          <Button aria-pressed={shown} onClick={() => setShown((current) => !current)}>
            {shown ? t('keyHide') : t('keyShow')}
          </Button>
        </div>
        <p id={hintId} className="clavis-hint">
          {t('keyInputHint')} {t('keyWarning')}
        </p>
        {problem ? (
          <p id={errorId} className="clavis-error" role="alert">
            {problem === 'empty' ? t('keyEmptyError') : t('keyFormatError')}
          </p>
        ) : null}
        {odd ? <p className="clavis-hint">{t('keyPrefixHint')}</p> : null}
      </div>

      <fieldset className="clavis-fieldset">
        <legend>{t('keyStorageLegend')}</legend>
        <label className="clavis-choice">
          <input
            type="radio"
            name={groupName}
            value="local"
            checked={storage === 'local'}
            onChange={() => setStorage('local')}
            disabled={busy}
          />
          <span className="clavis-choice__text">
            <strong>{local.label}</strong>
            {local.rest}
          </span>
        </label>
        <label className="clavis-choice">
          <input
            type="radio"
            name={groupName}
            value="session"
            checked={storage === 'session'}
            onChange={() => setStorage('session')}
            disabled={busy}
          />
          <span className="clavis-choice__text">
            <strong>{session.label}</strong>
            {session.rest}
          </span>
        </label>
      </fieldset>

      <div className="clavis-actions">
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? t('keyConnecting') : t('keyConnect')}
        </Button>
      </div>

      {toast ? null : (
        <div className="clavis-live" role="status" aria-live="polite">
          {busy ? (
            <div className="clavis-notice">
              <p>{t('keyResultChecking')}</p>
            </div>
          ) : outcome && outcome.kind !== 'error' ? (
            <KeyOutcomeNotice outcome={outcome} />
          ) : null}
        </div>
      )}
      {!toast && !busy && outcome?.kind === 'error' ? <KeyOutcomeNotice outcome={outcome} /> : null}
    </form>
  );
}
