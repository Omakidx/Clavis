// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { Reader } from '../../../components/reader/Reader';
import { PdfReaderController } from '../../../lib/pdf/controller';

// t() resolves through browser.i18n; echo the key and substitutions so assertions are exact.
beforeEach(() => {
  vi.spyOn(browser.i18n, 'getMessage').mockImplementation(
    ((key: string, subs?: string | string[]) =>
      `${key}${subs === undefined ? '' : `(${[subs].flat().join(',')})`}`) as never,
  );
});
afterEach(() => {
  document.title = '';
});

const textFile = (name: string, body: string) =>
  new File([body], name, { type: 'application/pdf' });

describe('<Reader> shell', () => {
  it('starts in the empty state with the tab title and nothing enabled that needs a document', () => {
    render(<Reader />);
    expect(screen.getByTestId('state-empty')).toBeInTheDocument();
    expect(document.title).toBe('readerTitle');
    expect(screen.getByRole('button', { name: 'readerClose' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'readerFindToggle' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'readerZoomIn' })).toBeDisabled();
    // The pages area is not reachable by keyboard while there is nothing in it.
    expect(screen.getByTestId('viewer-container')).toHaveAttribute('inert');
    expect(document.querySelector('.reader')).toHaveAttribute('data-phase', 'empty');
  });

  it('has landmarks: one banner, one main, and a named pages region', () => {
    render(<Reader />);
    expect(screen.getAllByRole('banner')).toHaveLength(1);
    expect(screen.getAllByRole('main')).toHaveLength(1);
    expect(screen.getByRole('region', { name: 'readerViewerLabel' })).toBeDefined();
  });

  it('a file that is not a PDF shows an actionable error', async () => {
    const user = userEvent.setup();
    render(<Reader />);
    await user.upload(screen.getByTestId('file-input'), textFile('notes.pdf', 'plain text'));
    const alert = await screen.findByTestId('state-error');
    expect(alert).toHaveAttribute('data-code', 'UNSUPPORTED');
    expect(screen.getByRole('button', { name: 'readerChooseAnother' })).toBeInTheDocument();
    expect(document.querySelector('.reader')).toHaveAttribute('data-phase', 'error');
    // The user can tell which file failed.
    expect(document.title).toBe('readerDocTitle(notes.pdf)');
    expect(screen.getByTestId('file-name')).toHaveTextContent('notes.pdf');
  });

  it('shows a hostile file name as text, never as markup', async () => {
    const user = userEvent.setup();
    render(<Reader />);
    const name = '<img src=x onerror=alert(1)>.pdf';
    await user.upload(screen.getByTestId('file-input'), textFile(name, 'plain text'));
    await screen.findByTestId('state-error');
    expect(screen.getByTestId('file-name')).toHaveTextContent(name);
    expect(document.title).toBe(`readerDocTitle(${name})`);
    expect(document.querySelector('img')).toBeNull();
  });

  it('Close PDF is disabled and the picker is the way forward after an error', async () => {
    const user = userEvent.setup();
    render(<Reader />);
    await user.upload(screen.getByTestId('file-input'), textFile('x.pdf', 'nope'));
    await screen.findByTestId('state-error');
    expect(screen.getByRole('button', { name: 'readerClose' })).toBeDisabled();
  });

  describe('drag and drop', () => {
    const drag = (type: string, files: boolean) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'dataTransfer', {
        value: { types: files ? ['Files'] : ['text/plain'], files: [], dropEffect: 'none' },
      });
      act(() => void document.querySelector('.reader')!.dispatchEvent(event));
      return event;
    };

    it('shows the drop target while a FILE is dragged over, and hides it on leave', () => {
      render(<Reader />);
      const over = drag('dragover', true);
      expect(over.defaultPrevented).toBe(true);
      expect(screen.getByTestId('drop-target')).toHaveTextContent('readerDropActive');
      expect(document.querySelector('.reader')).toHaveAttribute('data-dragging', 'true');
      drag('dragleave', true);
      expect(screen.queryByTestId('drop-target')).toBeNull();
    });

    it('ignores drags that carry no file (selected text, a link)', () => {
      render(<Reader />);
      const over = drag('dragover', false);
      expect(over.defaultPrevented).toBe(false);
      expect(screen.queryByTestId('drop-target')).toBeNull();
    });
  });

  describe('shortcuts without a document', () => {
    it('leaves Ctrl+F to Chrome and does not open a find bar', async () => {
      const user = userEvent.setup();
      render(<Reader />);
      const seen: boolean[] = [];
      window.addEventListener('keydown', (e) => e.key === 'f' && seen.push(e.defaultPrevented));
      await user.keyboard('{Control>}f{/Control}');
      expect(seen).toEqual([false]);
      expect(screen.queryByTestId('find-bar')).toBeNull();
    });

    it('does not act on n, p, + or - (nothing to navigate)', async () => {
      const user = userEvent.setup();
      const spy = vi.spyOn(PdfReaderController.prototype, 'nextPage');
      const zoom = vi.spyOn(PdfReaderController.prototype, 'zoomIn');
      render(<Reader />);
      await user.keyboard('np+-');
      expect(spy).not.toHaveBeenCalled();
      expect(zoom).not.toHaveBeenCalled();
    });
  });

  describe('releasing the document (UJ-04)', () => {
    it('destroys the controller on pagehide and on unmount', () => {
      const destroy = vi.spyOn(PdfReaderController.prototype, 'destroy');
      const { unmount } = render(<Reader />);
      destroy.mockClear();
      act(() => void window.dispatchEvent(new Event('pagehide')));
      expect(destroy).toHaveBeenCalledTimes(1);
      unmount();
      expect(destroy).toHaveBeenCalledTimes(2);
    });
  });

  it('mounts the shared selection controller for the page and removes its listener on unmount', () => {
    const { unmount } = render(<Reader />);
    expect(browser.runtime.onMessage.hasListeners()).toBe(true);
    unmount();
    expect(browser.runtime.onMessage.hasListeners()).toBe(false);
  });
});
