import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { listChat, MAX_MESSAGES_PER_WORD } from '../../lib/data/chat';
import type { LocalChatMessage } from '../../lib/data/db';
import { kickSync } from '../../lib/data/kick';
import { t } from '../../lib/i18n';
import { MAX_CHAT_QUESTION_CHARS } from '../../lib/contracts/words';
import { api } from '../../lib/ui-client/api';
import type { ClientError } from '../../lib/ui-client/errors';
import { libraryApi } from '../../lib/ui-client/library-api';
import { openSettingsAt, openSettingsPage } from '../../lib/ui-client/navigation';
import { Button, ErrorNotice, LiveStatus } from '../common/ui';
import { useLocalData } from './data';

interface Props {
  wordKey: string;
  /** The saved word, for the chat's accessible name. */
  word: string;
}

const WATCH = ['chat'] as const;

type Phase =
  | { name: 'idle' }
  | { name: 'asking'; requestId: string; message: string }
  /** The one-time "Send this to Groq?" confirmation is owed (S-05, FR-002). */
  | { name: 'disclosure'; message: string };

/**
 * Chat about one saved word (S-05). New questions go to the background, which uses the Groq key
 * and writes both messages; this page only reads the stored chat. Plain text only (D-10): an
 * answer is a text node with its line breaks kept, never markup.
 */
export function ChatPane({ wordKey, word }: Props) {
  const { state, reload } = useLocalData(() => listChat(wordKey), WATCH);
  const [draft, setDraft] = useState('');
  const [phase, setPhase] = useState<Phase>({ name: 'idle' });
  const [error, setError] = useState<ClientError | null>(null);
  const [announce, setAnnounce] = useState('');
  const inputId = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLDivElement>(null);
  // The request this pane is waiting for; a stopped or abandoned one is ignored when it answers.
  const waiting = useRef<string | null>(null);

  const messages: LocalChatMessage[] = state.status === 'ready' ? state.data : [];
  const full = messages.length + 2 > MAX_MESSAGES_PER_WORD;
  const asking = phase.name === 'asking';

  // Leaving the word (or the page) stops a question that is still on its way.
  useEffect(
    () => () => {
      const pending = waiting.current;
      waiting.current = null;
      if (pending !== null) void libraryApi.chatCancel(pending);
    },
    [],
  );

  // The newest message stays in view.
  useEffect(() => {
    const list = log.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [messages.length]);

  const ask = async (message: string): Promise<void> => {
    const requestId = crypto.randomUUID();
    waiting.current = requestId;
    setError(null);
    setPhase({ name: 'asking', requestId, message });
    const result = await libraryApi.chatSend({ requestId, wordKey, message });
    if (waiting.current !== requestId) return;
    waiting.current = null;
    if (result.ok) {
      setPhase({ name: 'idle' });
      setDraft('');
      setAnnounce(t('libraryChatAnswered'));
      reload();
      void kickSync();
      input.current?.focus();
      return;
    }
    if (result.error.code === 'SETUP_REQUIRED' && result.error.reason === 'disclosure') {
      setPhase({ name: 'disclosure', message });
      return;
    }
    setPhase({ name: 'idle' });
    if (result.error.code === 'REQUEST_CANCELLED') setAnnounce(t('libraryChatCancelled'));
    else setError(result.error);
  };

  const send = (): void => {
    const message = draft.trim();
    if (message === '' || asking || full) return;
    void ask(message);
  };

  const stop = (): void => {
    if (phase.name !== 'asking') return;
    const { requestId } = phase;
    waiting.current = null;
    void libraryApi.chatCancel(requestId);
    setPhase({ name: 'idle' });
    setAnnounce(t('libraryChatCancelled'));
    input.current?.focus();
  };

  const confirmDisclosure = async (): Promise<void> => {
    if (phase.name !== 'disclosure') return;
    const { message } = phase;
    const accepted = await api.acceptDisclosure();
    if (!accepted.ok) {
      setPhase({ name: 'idle' });
      setError(accepted.error);
      return;
    }
    await ask(message);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      send();
    }
  };

  return (
    <section
      className="library-chat"
      aria-labelledby="library-chat-title"
      data-testid="library-chat"
    >
      <h3 id="library-chat-title">{t('libraryChatTitle')}</h3>
      {messages.length === 0 && state.status === 'ready' ? (
        <p className="clavis-muted">{t('libraryChatIntro')}</p>
      ) : null}
      {state.status === 'error' ? (
        <p role="alert" className="clavis-error">
          {t('libraryLoadError')}
        </p>
      ) : null}
      {messages.length > 0 ? (
        <div
          ref={log}
          className="library-log"
          role="log"
          aria-label={t('libraryChatLog', word)}
          tabIndex={0}
        >
          <ol className="library-messages">
            {messages.map((message) => (
              <li
                key={message.id}
                className={`library-message library-message--${message.role}`}
                data-role={message.role}
              >
                <span className="library-message__who">
                  {message.role === 'user' ? t('libraryChatYou') : t('libraryChatClavis')}
                </span>
                <span className="library-message__text" dir="auto">
                  {message.content}
                </span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {phase.name === 'disclosure' ? (
        <div
          className="clavis-notice clavis-notice--warning"
          role="group"
          data-testid="library-disclosure"
        >
          <p>{t('firstSendBody')}</p>
          <p>{t('libraryChatDisclosureNote')}</p>
          <div className="clavis-actions">
            <Button
              variant="primary"
              data-testid="library-disclosure-confirm"
              onClick={() => void confirmDisclosure()}
            >
              {t('libraryChatDisclosureConfirm')}
            </Button>
            <Button onClick={() => setPhase({ name: 'idle' })}>{t('firstSendCancel')}</Button>
          </div>
        </div>
      ) : null}

      {error === null ? null : (
        <ErrorNotice
          error={error}
          onRetry={error.action === 'retry' ? send : undefined}
          onOpenSettings={() =>
            error.action === 'open-settings' ? openSettingsPage() : openSettingsAt('key')
          }
        />
      )}

      {full ? (
        <p className="clavis-notice" data-testid="library-chat-full">
          {t('libraryChatFull')}
        </p>
      ) : (
        <div className="clavis-field">
          <label className="clavis-label" htmlFor={inputId}>
            {t('libraryChatInputLabel')}
          </label>
          <textarea
            ref={input}
            id={inputId}
            className="clavis-input library-input"
            rows={3}
            maxLength={MAX_CHAT_QUESTION_CHARS}
            value={draft}
            readOnly={asking}
            aria-busy={asking}
            data-testid="library-chat-input"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
          />
          <div className="clavis-actions">
            {asking ? (
              <>
                <span className="clavis-muted" role="status" data-testid="library-chat-asking">
                  {t('libraryChatSending')}
                </span>
                <Button data-testid="library-chat-stop" onClick={stop}>
                  {t('libraryChatStop')}
                </Button>
              </>
            ) : (
              <Button
                variant="primary"
                data-testid="library-chat-send"
                disabled={draft.trim() === ''}
                onClick={send}
              >
                {t('libraryChatSend')}
              </Button>
            )}
          </div>
        </div>
      )}
      <LiveStatus message={announce} />
    </section>
  );
}
