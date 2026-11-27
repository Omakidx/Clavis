import { useEffect, useId, useRef, useState } from 'react';
import { ApiFailure, describeFailure } from '../api/client';
import { api, EXPORT_URL } from '../api/endpoints';
import { REAUTH_URL, setReauthMarker } from '../api/reauth';
import { useSession } from '../api/session';
import { Modal } from '../ui/modal';

const CONFIRM_WORD = 'DELETE';

interface Props {
  /** The last Google login is too old (or the server said so): ask for Google sign-in again first. */
  reauth: boolean;
  onReauthRequired(): void;
  onCancel(): void;
}

/** Typed-confirmation account deletion (design §8.2), with Google re-authentication when the login is stale. */
export function DeleteAccountDialog({ reauth, onReauthRequired, onCancel }: Props) {
  const { state, clear } = useSession();
  const email = state.status === 'signed-in' ? state.user.email : null;
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const hintId = useId();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // After a failed delete the input is re-enabled: put focus back there (it was lost while it was disabled).
  useEffect(() => {
    if (!busy && error) inputRef.current?.focus();
  }, [busy, error]);

  const signInAgain = (): void => {
    setReauthMarker();
    window.location.assign(REAUTH_URL);
  };

  const remove = async (): Promise<void> => {
    if (typed !== CONFIRM_WORD || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteAccount();
      clear(false, true);
    } catch (e) {
      if (e instanceof ApiFailure && e.code === 'REAUTH_REQUIRED') onReauthRequired();
      else setError(e);
      setBusy(false);
    }
  };

  const cancel = (
    <button
      type="button"
      className="btn btn--quiet"
      data-initial-focus
      disabled={busy}
      onClick={onCancel}
    >
      Cancel
    </button>
  );

  if (reauth) {
    return (
      <Modal
        key="reauth"
        title="Sign in again to delete your account"
        onClose={onCancel}
        actions={
          <>
            {cancel}
            <button type="button" className="btn" onClick={signInAgain}>
              Sign in again to continue
            </button>
          </>
        }
      >
        {email ? <p>You are signed in as {email}. Use the same Google account.</p> : null}
        <p>
          For your security, deleting your account needs a recent Google sign-in. Sign in with
          Google again, and you will come back here to finish. Nothing has been deleted yet.
        </p>
      </Modal>
    );
  }

  return (
    <Modal
      key="confirm"
      title={email ? `Delete the Clavis account for ${email}?` : 'Delete your Clavis account?'}
      onClose={() => {
        if (!busy) onCancel();
      }}
      actions={
        <>
          {cancel}
          <button
            type="button"
            className="btn btn--danger"
            disabled={busy || typed !== CONFIRM_WORD}
            onClick={() => void remove()}
          >
            {busy ? 'Deleting…' : 'Delete my account'}
          </button>
        </>
      }
    >
      <p>
        This permanently deletes your Clavis account and everything stored in it: all saved words
        and their chats, documents, reading progress, highlights and stored PDFs. It cannot be
        undone.
      </p>
      <p>
        Data already on your devices stays there until you sign out of Clavis on each device. Want a
        copy first?{' '}
        <a href={EXPORT_URL} download>
          Export your data
        </a>{' '}
        before deleting.
      </p>
      <label htmlFor={inputId}>Type {CONFIRM_WORD} to confirm</label>
      <input
        id={inputId}
        ref={inputRef}
        type="text"
        value={typed}
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        aria-describedby={hintId}
        disabled={busy}
        onChange={(e) => setTyped(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void remove();
          }
        }}
      />
      <p className="muted" id={hintId}>
        Case-sensitive: type {CONFIRM_WORD} in capital letters. The delete button turns on when it
        matches.
      </p>
      {error ? (
        <p className="notice notice--danger" role="alert">
          {describeFailure(error)}
        </p>
      ) : null}
    </Modal>
  );
}
