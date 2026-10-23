import { browser } from 'wxt/browser';
import { capturePdfSelection } from '../../lib/pdf/selection';
import { createSelectionController } from '../../lib/selection/controller';
import { createListenController } from '../../lib/selection/listen';
import type { ExplainCardApi, ToolbarHandle, ToolbarOptions } from '../../lib/selection/ui-api';
import { isOpenSelectionMessage } from '../../lib/site-access/messages';

/**
 * The reader's selection toolbar (FR-053): the SAME controller, toolbar, Listen and explanation
 * card as a web page, mounted on the PDF text layers.
 *
 * - Selections: `capturePdfSelection` (lib/pdf/selection.ts) replaces the webpage capture, so a
 *   snapshot has `source: 'pdf'`, its page number and context from that page only.
 * - Listen: `createListenController`, the content script's own code. The background reports
 *   `TTS_EVENT` to this tab with tabs.sendMessage; it is fed in below.
 * - Explain: the explanation card, imported directly (an extension page has no isolated-world
 *   loading step) but lazily, on the first press. The toolbar is loaded lazily too, on the first
 *   selection, so opening the reader costs neither Preact nor the card.
 *
 * `container` is the scrolling viewer; only selections inside its text layers qualify.
 */
/** The sender fields the check reads (a subset of `runtime.MessageSender`). */
export interface SenderLike {
  id?: string | undefined;
  url?: string | undefined;
  tab?: unknown;
}

/**
 * Messages this page accepts (TTS_EVENT, CLAVIS_OPEN_SELECTION) come from the service worker:
 * our id, no tab (a content script has one) and the worker's own script URL. A content script
 * running in a web page shares our id but not those (Phase 7 security review LOW-3).
 */
export function isFromBackground(sender: SenderLike | undefined): boolean {
  return (
    sender?.id === browser.runtime.id &&
    sender.tab === undefined &&
    sender.url === browser.runtime.getURL('/background.js')
  );
}

export interface ReaderSelectionHandle {
  /** Re-run toolbar placement (after a zoom or render moved the text under a visible toolbar). */
  reposition(): void;
  stop(): void;
}

export function mountReaderSelection(
  container: HTMLElement,
  win: Window = window,
): ReaderSelectionHandle {
  const speech = createListenController();
  // Filled in below; the message handler needs it when a message arrives, never earlier.
  const mounted: { controller?: ReturnType<typeof createSelectionController> } = {};
  const onMessage = (
    message: unknown,
    sender: SenderLike | undefined,
    sendResponse: (response: unknown) => void,
  ): true | undefined => {
    // Only our own background sends us anything: not a content script of ours on some web page.
    if (!isFromBackground(sender)) return undefined;
    // Playback state (TTS_EVENT) for a Listen run of this page.
    if (speech.handleEvent(message)) return undefined;
    // The keyboard path (FR-016): show the toolbar for the current selection and move focus in.
    if (isOpenSelectionMessage(message) && mounted.controller !== undefined) {
      void mounted.controller
        .openForCurrentSelection({
          ...(message.focus === true ? { focus: true } : {}),
          // The reader only listens to the background (isFromBackground above).
          ...(message.explain === true ? { explain: true } : {}),
        })
        .then((shown) => sendResponse({ ok: true, shown }));
      return true;
    }
    return undefined;
  };
  browser.runtime.onMessage.addListener(onMessage);

  let card: ExplainCardApi | null = null;
  let loadingCard: Promise<ExplainCardApi> | null = null;
  const loadCard = (): Promise<ExplainCardApi> => {
    loadingCard ??= import('../explanation').then(({ createExplainCard }) => {
      card = createExplainCard();
      return card;
    });
    return loadingCard;
  };

  const loadToolbar = async (options: ToolbarOptions): Promise<ToolbarHandle> => {
    const [{ createToolbar }, { createPreactRenderer }] = await Promise.all([
      import('../tooltip/toolbar'),
      import('../tooltip/preact-renderer'),
    ]);
    return createToolbar(createPreactRenderer(), options, win.document);
  };

  const controller = createSelectionController({
    win,
    capture: (w) => capturePdfSelection(w, container),
    loadToolbar,
    actions: {
      listen: speech.listen,
      openVoiceSettings: speech.openVoiceSettings,
      async explain(context) {
        await (await loadCard()).present(context);
      },
      // A trim makes a new snapshot: the old selection's explanation is not wanted any more.
      trim: () => card?.dismiss(),
      dismiss: (context) => card?.dismiss(context.snapshot.selectionId),
    },
  });

  mounted.controller = controller;

  return {
    reposition() {
      // The toolbar re-places itself on window `resize` and capture-phase `scroll`. A zoom or a
      // page re-render moves the text without either, so nudge it with a plain resize event.
      win.dispatchEvent(new Event('resize'));
    },
    stop() {
      browser.runtime.onMessage.removeListener(onMessage);
      controller.stop();
      card?.destroy();
      card = null;
      loadingCard = null;
    },
  };
}
