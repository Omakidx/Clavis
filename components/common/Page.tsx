import { useEffect } from 'react';
import type { ReactNode } from 'react';
import './page.css';

interface PageProps {
  /** Already-localized page title; used for the tab title and the single <h1>. */
  title: string;
  /** `narrow` is for the toolbar popup, `wide` for full-tab pages. */
  size?: 'narrow' | 'wide';
  children?: ReactNode;
}

export function Page({ title, size = 'wide', children }: PageProps) {
  useEffect(() => {
    document.title = title;
  }, [title]);

  return (
    <main className={`clavis-page clavis-page--${size}`}>
      <h1 className="clavis-page__title">{title}</h1>
      {children}
    </main>
  );
}
