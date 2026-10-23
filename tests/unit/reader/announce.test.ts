import { describe, expect, it } from 'vitest';
import { announcementFor, type AnnounceInput } from '../../../lib/pdf/announce';
import type { ViewStatus } from '../../../lib/pdf/controller';
import type { ReaderState } from '../../../lib/pdf/state';

const view = (over: Partial<ViewStatus> = {}): ViewStatus => ({
  pageCount: 10,
  page: 1,
  zoom: 1,
  scaleValue: '1',
  ...over,
});
const ready = (name = 'a.pdf'): ReaderState => ({
  phase: 'ready',
  name,
  pageCount: 10,
  page: 1,
  zoom: 1,
});
const input = (state: ReaderState, v: ViewStatus | null = null): AnnounceInput => ({
  state,
  view: v,
});

describe('announcementFor', () => {
  it('announces a document that finished opening, with its name and page count', () => {
    expect(
      announcementFor(input({ phase: 'loading', name: 'a.pdf' }), input(ready(), view())),
    ).toEqual({ key: 'readerOpened', subs: ['a.pdf', '10'] });
  });

  it('announces a closed document', () => {
    expect(announcementFor(input(ready(), view()), input({ phase: 'empty' }))).toEqual({
      key: 'readerClosedLive',
    });
  });

  it('leaves loading, errors, image-only and the password prompt to their own live roles', () => {
    expect(
      announcementFor(input({ phase: 'empty' }), input({ phase: 'loading', name: 'a' })),
    ).toBeNull();
    expect(
      announcementFor(
        input({ phase: 'loading', name: 'a' }),
        input({ phase: 'error', code: 'CORRUPT', message: 'x' }),
      ),
    ).toBeNull();
    expect(
      announcementFor(
        input(ready(), view()),
        input({ phase: 'image-only', name: 'a', pageCount: 3 }, view()),
      ),
    ).toBeNull();
    expect(
      announcementFor(
        input({ phase: 'loading', name: 'a' }),
        input({ phase: 'password-required', name: 'a' }),
      ),
    ).toBeNull();
  });

  it('announces a page change as "page X of N"', () => {
    expect(announcementFor(input(ready(), view()), input(ready(), view({ page: 4 })))).toEqual({
      key: 'readerPageLive',
      subs: ['4', '10'],
    });
  });

  it('announces a zoom change as a whole percent', () => {
    expect(
      announcementFor(
        input(ready(), view()),
        input(ready(), view({ zoom: 1.25, scaleValue: '1.25' })),
      ),
    ).toEqual({ key: 'readerZoomLive', subs: ['125'] });
  });

  it('prefers the page change when both change, and ignores sub-0.1% zoom noise', () => {
    expect(
      announcementFor(input(ready(), view()), input(ready(), view({ page: 2, zoom: 2 })))?.key,
    ).toBe('readerPageLive');
    expect(
      announcementFor(input(ready(), view()), input(ready(), view({ zoom: 1.0004 }))),
    ).toBeNull();
  });

  it('says nothing when nothing relevant changed', () => {
    expect(announcementFor(input(ready(), view()), input(ready(), view()))).toBeNull();
    expect(announcementFor(input(ready()), input(ready()))).toBeNull();
  });
});
