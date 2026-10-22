import type { SelectionSnapshot } from '../../../lib/contracts';

export const UUID_A = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
export const UUID_B = '9b2f5c1e-7d1a-4c8e-8b57-2f6a1e4d9c10';

export function snapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    selectionId: UUID_A,
    source: 'webpage',
    kind: 'word',
    text: 'bank',
    ...overrides,
  };
}

export function validSnapshot(): SelectionSnapshot {
  return snapshot() as unknown as SelectionSnapshot;
}

export function explainRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: UUID_B,
    snapshot: snapshot(),
    mode: 'core',
    detailLevel: 'standard',
    ...overrides,
  };
}
