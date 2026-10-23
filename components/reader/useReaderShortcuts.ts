import { useEffect, type RefObject } from 'react';
import type { PdfReaderController } from '../../lib/pdf/controller';
import { commandForKey, SCROLL_PAGE_FRACTION, type ReaderCommand } from '../../lib/pdf/shortcuts';
import { isOwnUiNode } from '../../lib/selection/own-ui';
import type { FindBarModel } from './useFindBar';

interface Options {
  controller: PdfReaderController;
  containerRef: RefObject<HTMLElement | null>;
  find: FindBarModel;
  /** A document is on screen and no dialog is open. */
  enabled: boolean;
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT'
  );
}

/** Reader keyboard shortcuts (lib/pdf/shortcuts.ts decides; this runs the command). */
export function useReaderShortcuts({ controller, containerRef, find, enabled }: Options): void {
  useEffect(() => {
    const run = (command: ReaderCommand): void => {
      const container = containerRef.current;
      switch (command) {
        case 'next-page':
          return controller.nextPage();
        case 'previous-page':
          return controller.previousPage();
        case 'first-page':
          return controller.firstPage();
        case 'last-page':
          return controller.lastPage();
        case 'scroll-down':
          return container?.scrollBy({
            top: container.clientHeight * SCROLL_PAGE_FRACTION,
            behavior: 'instant',
          });
        case 'scroll-up':
          return container?.scrollBy({
            top: -container.clientHeight * SCROLL_PAGE_FRACTION,
            behavior: 'instant',
          });
        case 'scroll-start':
          return container?.scrollTo({ top: 0, behavior: 'instant' });
        case 'scroll-end':
          return container?.scrollTo({ top: container.scrollHeight, behavior: 'instant' });
        case 'zoom-in':
          return controller.zoomIn();
        case 'zoom-out':
          return controller.zoomOut();
        case 'zoom-actual':
          return controller.setZoom(1);
        case 'open-find':
          return find.show();
        case 'find-next':
          return find.step(false);
        case 'find-previous':
          return find.step(true);
        case 'close-find':
          return find.hide();
      }
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing) return;
      // Keys pressed inside Clavis's own toolbar or card belong to it.
      if (event.composedPath().some((node) => isOwnUiNode(node as Node))) return;
      const command = commandForKey(event, {
        hasDocument: enabled,
        findOpen: find.open,
        editable: isEditable(event.target),
        inFindBar: find.barRef.current?.contains(event.target as Node | null) === true,
      });
      if (command === null) return;
      event.preventDefault();
      run(command);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [controller, containerRef, find, enabled]);
}
