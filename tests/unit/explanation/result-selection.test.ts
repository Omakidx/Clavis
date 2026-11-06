// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { resultSelectionFromRange } from '../../../components/explanation/result-selection';

function fixture(text = 'The river bank was grassy.') {
  const panel = document.createElement('div');
  panel.dataset['clavis'] = 'card-panel';
  const result = document.createElement('div');
  result.dataset['clavis'] = 'card-result';
  const leaf = document.createElement('p');
  leaf.dataset['clavis'] = 'card-result-text';
  leaf.textContent = text;
  const label = document.createElement('p');
  label.className = 'ec__label';
  label.textContent = 'Meaning';
  const other = document.createElement('p');
  other.dataset['clavis'] = 'card-result-text';
  other.textContent = 'Other leaf';
  result.append(leaf, label, other);
  panel.append(result);
  document.body.append(panel);
  const select = (start: number, end: number, target = leaf.firstChild!): Range => {
    const range = document.createRange();
    range.setStart(target, start);
    range.setEnd(target, end);
    return range;
  };
  return { panel, leaf, select };
}

describe('generated result selection', () => {
  it('captures one generated leaf with local bounded context', () => {
    const { panel, select } = fixture();
    expect(resultSelectionFromRange(select(10, 14), panel)).toEqual({
      kind: 'ready',
      input: { text: 'bank', contextBefore: 'The river', contextAfter: 'was grassy.' },
    });
    panel.remove();
  });

  it('rejects a label, a cross-leaf range, and a hidden panel', () => {
    const { panel, leaf, select } = fixture();
    const label = panel.querySelector('.ec__label')!.firstChild!;
    expect(resultSelectionFromRange(select(0, 4, label), panel)).toBeNull();
    const cross = document.createRange();
    cross.setStart(leaf.firstChild!, 0);
    cross.setEnd(panel.querySelectorAll('[data-clavis="card-result-text"]')[1]!.firstChild!, 5);
    expect(resultSelectionFromRange(cross, panel)).toBeNull();
    panel.hidden = true;
    expect(resultSelectionFromRange(select(10, 14), panel)).toBeNull();
    panel.remove();
  });

  it('rejects over-limit text without truncating and caps combined context', () => {
    const { panel, select } = fixture(`${'a'.repeat(900)}${'b'.repeat(2001)}${'c'.repeat(900)}`);
    expect(resultSelectionFromRange(select(900, 2901), panel)).toEqual({ kind: 'over-limit' });
    const around = resultSelectionFromRange(select(900, 901), panel);
    expect(around?.kind).toBe('ready');
    if (around?.kind === 'ready') {
      expect(around.input.contextBefore?.length).toBeLessThanOrEqual(500);
      expect(around.input.contextAfter?.length).toBeLessThanOrEqual(500);
      expect(
        (around.input.contextBefore?.length ?? 0) + (around.input.contextAfter?.length ?? 0),
      ).toBeLessThanOrEqual(1000);
    }
    panel.remove();
  });
});
