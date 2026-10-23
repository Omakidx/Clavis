import { describe, expect, it, vi } from 'vitest';
import { KEY_MESSAGES, createHarness, pageSender } from './harness';

const options = pageSender('/options.html');

describe('model context changes (capability cache invalidation hook)', () => {
  it('fires when the model preference is set, cleared or reset, and on CLEAR_ALL_DATA', async () => {
    const onModelContextChanged = vi.fn();
    const h = createHarness({ onModelContextChanged });
    const update = (patch: object) => h.call({ v: 1, type: 'UPDATE_PREFERENCES', patch }, options);

    await update({ model: 'openai/gpt-oss-120b' });
    expect(onModelContextChanged).toHaveBeenCalledTimes(1);
    await update({ model: null });
    expect(onModelContextChanged).toHaveBeenCalledTimes(2);
    await h.call({ v: 1, type: 'RESET_PREFERENCES' }, options);
    expect(onModelContextChanged).toHaveBeenCalledTimes(3);
    await h.call(KEY_MESSAGES['CLEAR_ALL_DATA'], options);
    expect(onModelContextChanged).toHaveBeenCalledTimes(4);
  });

  it('does not fire for unrelated preferences or a rejected patch', async () => {
    const onModelContextChanged = vi.fn();
    const h = createHarness({ onModelContextChanged });
    await h.call({ v: 1, type: 'UPDATE_PREFERENCES', patch: { readingLevel: 'simple' } }, options);
    await h.call({ v: 1, type: 'UPDATE_PREFERENCES', patch: { model: '' } }, options);
    expect(onModelContextChanged).not.toHaveBeenCalled();
  });
});
