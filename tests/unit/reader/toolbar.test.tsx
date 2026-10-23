// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { ReaderToolbar } from '../../../components/reader/ReaderToolbar';
import type { PdfReaderController, ViewStatus } from '../../../lib/pdf/controller';

beforeEach(() => {
  vi.spyOn(browser.i18n, 'getMessage').mockImplementation(
    ((key: string, subs?: string | string[]) =>
      `${key}${subs === undefined ? '' : `(${[subs].flat().join(',')})`}`) as never,
  );
});

const view = (over: Partial<ViewStatus> = {}): ViewStatus => ({
  pageCount: 50,
  page: 3,
  zoom: 1,
  scaleValue: '1',
  ...over,
});

function setup(v: ViewStatus | null, findOpen = false) {
  const controller = {
    goToPage: vi.fn(),
    nextPage: vi.fn(),
    previousPage: vi.fn(),
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
    setZoom: vi.fn(),
    fitWidth: vi.fn(),
  };
  const props = { onToggleFind: vi.fn(), onOpen: vi.fn(), onClose: vi.fn() };
  render(
    <ReaderToolbar
      controller={controller as unknown as PdfReaderController}
      view={v}
      findOpen={findOpen}
      {...props}
    />,
  );
  return { controller, ...props };
}

describe('<ReaderToolbar>', () => {
  it('without a document only Open PDF is enabled', () => {
    const { onOpen } = setup(null);
    for (const name of [
      'readerClose',
      'readerPrevPage',
      'readerNextPage',
      'readerZoomOut',
      'readerZoomIn',
      'readerFitWidth',
      'readerFindToggle',
    ]) {
      expect(screen.getByRole('button', { name })).toBeDisabled();
    }
    expect(screen.getByRole('button', { name: 'readerOpen' })).toBeEnabled();
    expect(screen.getByTestId('page-input')).toBeDisabled();
    expect(screen.getByTestId('zoom-select')).toBeDisabled();
    void onOpen;
  });

  it('groups pages and zoom with names, shows "page of N" and the current page', () => {
    setup(view());
    expect(screen.getByRole('group', { name: 'readerGroupPages' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'readerGroupZoom' })).toBeInTheDocument();
    expect(screen.getByTestId('page-input')).toHaveValue(3);
    expect(screen.getByTestId('page-count')).toHaveTextContent('readerPageOf(50)');
  });

  it('page buttons and the page box navigate, and the box commits on Enter and on blur', async () => {
    const { controller } = setup(view());
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'readerNextPage' }));
    await user.click(screen.getByRole('button', { name: 'readerPrevPage' }));
    expect(controller.nextPage).toHaveBeenCalledTimes(1);
    expect(controller.previousPage).toHaveBeenCalledTimes(1);

    const box = screen.getByTestId('page-input');
    await user.clear(box);
    await user.type(box, '12');
    fireEvent.submit(box.closest('form')!); // what Enter does in a browser
    expect(controller.goToPage).toHaveBeenLastCalledWith(12);
    await user.clear(box);
    await user.type(box, '7');
    await user.tab();
    expect(controller.goToPage).toHaveBeenLastCalledWith(7);
  });

  it('accepts an out-of-range page number without blocking submission (the controller clamps)', async () => {
    const { controller } = setup(view());
    const box = screen.getByTestId('page-input');
    const user = userEvent.setup();
    await user.clear(box);
    await user.type(box, '999');
    // `noValidate`: a browser must not refuse to submit a number above the input's `max`.
    expect(box.closest('form')).toHaveProperty('noValidate', true);
    fireEvent.submit(box.closest('form')!);
    expect(controller.goToPage).toHaveBeenLastCalledWith(999);
  });

  it('does not navigate when the box is emptied', async () => {
    const { controller } = setup(view());
    const user = userEvent.setup();
    await user.clear(screen.getByTestId('page-input'));
    await user.tab();
    expect(controller.goToPage).not.toHaveBeenCalled();
  });

  it('zoom buttons, presets and fit width call the controller', async () => {
    const { controller } = setup(view());
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'readerZoomIn' }));
    await user.click(screen.getByRole('button', { name: 'readerZoomOut' }));
    expect(controller.zoomIn).toHaveBeenCalledTimes(1);
    expect(controller.zoomOut).toHaveBeenCalledTimes(1);
    await user.selectOptions(screen.getByTestId('zoom-select'), '1.5');
    expect(controller.setZoom).toHaveBeenCalledWith(1.5);
    await user.selectOptions(screen.getByTestId('zoom-select'), 'page-width');
    expect(controller.fitWidth).toHaveBeenCalledTimes(1);
    await user.click(screen.getByTestId('fit-width'));
    expect(controller.fitWidth).toHaveBeenCalledTimes(2);
  });

  it('shows a level between presets as its own percentage, and a preset as selected', () => {
    const { unmount } = render(<div />);
    unmount();
    document.body.replaceChildren();
    setup(view({ zoom: 1.37, scaleValue: '1.37' }));
    expect(screen.getByTestId('zoom-select')).toHaveValue('custom');
    expect(screen.getByRole('option', { selected: true })).toHaveTextContent(
      'readerZoomPercent(137)',
    );
    document.body.replaceChildren();
    setup(view({ zoom: 1.25, scaleValue: '1.25' }));
    expect(screen.getByTestId('zoom-select')).toHaveValue('1.25');
    document.body.replaceChildren();
    setup(view({ zoom: 1.3, scaleValue: 'page-width' }));
    expect(screen.getByTestId('zoom-select')).toHaveValue('page-width');
  });

  it('the Find button reports whether the bar is open and toggles it', async () => {
    const { onToggleFind } = setup(view(), true);
    const toggle = screen.getByRole('button', { name: 'readerFindToggle' });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(toggle).toHaveAttribute('aria-controls', 'reader-find-bar');
    expect(toggle).toHaveAttribute('aria-keyshortcuts', 'Control+F Meta+F');
    await userEvent.setup().click(toggle);
    expect(onToggleFind).toHaveBeenCalledTimes(1);
  });

  it('Open and Close call back', async () => {
    const { onOpen, onClose } = setup(view());
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'readerOpen' }));
    await user.click(screen.getByRole('button', { name: 'readerClose' }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
