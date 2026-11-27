import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { describeFailure } from '../api/client';

let firstPage = true;

/**
 * Sets the tab title and, on client-side navigation (not the first load), moves focus to the page heading so
 * keyboard and screen-reader users land at the top of the new page. Pass `ready=false` while the heading is
 * not yet in the DOM.
 */
export function usePage(title: string, ready = true): RefObject<HTMLHeadingElement | null> {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    document.title = `${title} · Clavis`;
  }, [title]);
  useEffect(() => {
    if (!ready) return;
    if (firstPage) {
      firstPage = false;
      return;
    }
    heading.current?.focus({ preventScroll: false });
  }, [ready]);
  return heading;
}

export function Loading({ label }: { label: string }) {
  return (
    <p className="state" role="status">
      <span className="spinner" aria-hidden="true" />
      {label}
    </p>
  );
}

export function ErrorState({
  failure,
  onRetry,
  label = 'Try again',
}: {
  failure: unknown;
  onRetry?: () => void;
  label?: string;
}) {
  return (
    <div className="notice notice--danger" role="alert">
      <p>{describeFailure(failure)}</p>
      {onRetry ? (
        <button type="button" className="btn btn--quiet" onClick={onRetry}>
          {label}
        </button>
      ) : null}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="state state--empty">{children}</div>;
}
