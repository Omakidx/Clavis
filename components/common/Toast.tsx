import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { t } from '../../lib/i18n';
import type { NoticeTone } from './ui';

interface ToastOptions {
  content: ReactNode;
  tone?: NoticeTone;
  /** Zero keeps a pending operation visible until its result replaces it. */
  durationMs?: number;
}

interface ToastItem extends ToastOptions {
  id: number;
  tone: NoticeTone;
  durationMs: number;
}

interface ToastApi {
  show(options: ToastOptions): number;
  dismiss(id: number): void;
}

const ToastContext = createContext<ToastApi | null>(null);

/** Optional so shared Settings fields keep their original inline feedback in onboarding. */
export function useToast(): ToastApi | null {
  return useContext(ToastContext);
}

function ToastCard({ item, onDismiss }: { item: ToastItem; onDismiss(): void }) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const remaining = useRef(item.durationMs);

  useEffect(() => {
    if (item.durationMs === 0 || hovered || focused) return;
    const started = Date.now();
    const timer = window.setTimeout(onDismiss, remaining.current);
    return () => {
      window.clearTimeout(timer);
      remaining.current = Math.max(0, remaining.current - (Date.now() - started));
    };
  }, [focused, hovered, item.durationMs, onDismiss]);

  return (
    <div
      className={`clavis-toast clavis-toast--${item.tone}`}
      data-testid="settings-toast"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
    >
      <span className="clavis-toast__symbol" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" focusable="false">
          {item.tone === 'success' ? (
            <path
              d="M21.5303 5.46967C21.8232 5.76256 21.8232 6.23744 21.5303 6.53033L9.53033 18.5303C9.23744 18.8232 8.76256 18.8232 8.46967 18.5303L2.46967 12.5303C2.17678 12.2374 2.17678 11.7626 2.46967 11.4697C2.76256 11.1768 3.23744 11.1768 3.53033 11.4697L9 16.9393L20.4697 5.46967C20.7626 5.17678 21.2374 5.17678 21.5303 5.46967Z"
              fill="currentColor"
            />
          ) : (
            <g stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <circle cx="12" cy="12" r="9" />
              <path d={item.tone === 'info' ? 'M12 11v6M12 7v.1' : 'M12 7v6M12 17v.1'} />
            </g>
          )}
        </svg>
      </span>
      <div className="clavis-toast__content">{item.content}</div>
      <button
        type="button"
        className="clavis-toast__close"
        aria-label={t('uiDismissNotification')}
        onClick={onDismiss}
      >
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
          <path
            d="m7 7 10 10M17 7 7 17"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      </button>
    </div>
  );
}

/** Settings-scoped host. Each new action replaces the previous feedback, including identical text. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [item, setItem] = useState<ToastItem | null>(null);
  const nextId = useRef(0);
  const show = useCallback((options: ToastOptions) => {
    const id = ++nextId.current;
    setItem({
      ...options,
      id,
      tone: options.tone ?? 'info',
      durationMs:
        options.durationMs ??
        (options.tone === 'danger' || options.tone === 'warning' ? 7000 : 4000),
    });
    return id;
  }, []);
  const dismiss = useCallback((id: number) => {
    setItem((current) => (current?.id === id ? null : current));
  }, []);
  const api = useMemo(() => ({ show, dismiss }), [show, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="clavis-toast-host" role="status" aria-live="polite" aria-atomic="true">
        {item ? <ToastCard key={item.id} item={item} onDismiss={() => dismiss(item.id)} /> : null}
      </div>
    </ToastContext.Provider>
  );
}
