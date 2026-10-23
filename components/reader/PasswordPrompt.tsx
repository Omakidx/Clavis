import { useId, useState, type FormEvent } from 'react';
import { t } from '../../lib/i18n';

interface PasswordPromptProps {
  fileName: string;
  incorrect: boolean;
  onSubmit: (password: string) => void;
  onCancel: () => void;
}

/**
 * Inline password form for encrypted PDFs. The typed value lives only in this component's state
 * and is handed to PDF.js on submit; it is never logged or persisted (architecture section 8).
 */
export function PasswordPrompt({ fileName, incorrect, onSubmit, onCancel }: PasswordPromptProps) {
  const [password, setPassword] = useState('');
  const headingId = useId();
  const errorId = useId();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (password === '') return;
    onSubmit(password);
    setPassword('');
  };

  return (
    <form
      className="reader-dialog"
      aria-labelledby={headingId}
      onSubmit={submit}
      data-testid="password-prompt"
    >
      <h2 id={headingId}>{t('readerPasswordTitle')}</h2>
      <p>{t('readerPasswordPrompt', fileName)}</p>
      <label className="reader-dialog__field">
        <span>{t('readerPasswordLabel')}</span>
        <input
          className="clavis-input reader-input"
          type="password"
          autoComplete="off"
          // The prompt only exists because the user just chose an encrypted file.
          autoFocus
          value={password}
          aria-invalid={incorrect}
          aria-describedby={incorrect ? errorId : undefined}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      {incorrect ? (
        <p id={errorId} role="alert" className="reader-message--error" data-testid="password-error">
          {t('readerPasswordIncorrect')}
        </p>
      ) : null}
      <div className="clavis-actions">
        <button type="submit" className="clavis-button clavis-button--primary">
          {t('readerPasswordSubmit')}
        </button>
        <button type="button" className="clavis-button" onClick={onCancel}>
          {t('readerPasswordCancel')}
        </button>
      </div>
    </form>
  );
}
