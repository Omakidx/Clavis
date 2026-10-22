import { describe, expect, it } from 'vitest';
import { isShowNoticeMessage } from '../../../lib/selection/notice';

describe('CLAVIS_SHOW_NOTICE guard', () => {
  it('accepts exactly the message the background sends', () => {
    expect(
      isShowNoticeMessage({ v: 1, type: 'CLAVIS_SHOW_NOTICE', reason: 'frame-no-access' }),
    ).toBe(true);
  });

  it.each([
    null,
    'x',
    {},
    { v: 2, type: 'CLAVIS_SHOW_NOTICE', reason: 'frame-no-access' },
    { v: 1, type: 'CLAVIS_OPEN_SELECTION' },
    { v: 1, type: 'CLAVIS_SHOW_NOTICE', reason: 'other' },
    { v: 1, type: 'CLAVIS_SHOW_NOTICE' },
  ])('rejects %j', (value) => {
    expect(isShowNoticeMessage(value)).toBe(false);
  });
});
