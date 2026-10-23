import { render } from '@testing-library/react';
import { act } from 'react';
import { vi } from 'vitest';
import { SidePanelApp, type PanelDeps } from '../../../components/sidepanel/SidePanelApp';
import { NOTHING, type PanelClient } from '../../../components/sidepanel/client';
import type {
  ExplainResult,
  SelectionKind,
  SidePanelHandoff,
  SidePanelState,
} from '../../../lib/contracts';
import type { ListenController } from '../../../lib/selection/listen';
import type { RunContext } from '../../../lib/selection/ui-api';
import { createFakeBackend, makeSnapshot, resultFor } from '../explanation/support';

export { installCatalog } from '../ui-client/support';

type Mode = ExplainResult['mode'];

/** A hand-off as the card would send it: the selection and the tabs it had loaded. */
export function makeHandoff(
  options: {
    kind?: SelectionKind;
    text?: string;
    modes?: Mode[];
    active?: Mode;
    overrides?: Partial<Record<Mode, Partial<ExplainResult>>>;
    snapshot?: Partial<ReturnType<typeof makeSnapshot>>;
  } = {},
): SidePanelHandoff {
  const snapshot = makeSnapshot(options.kind ?? 'word', options.text ?? 'bank', options.snapshot);
  const modes = options.modes ?? ['core'];
  const results = modes.map((mode, index) => {
    const request = {
      requestId: `00000000-0000-4000-8000-${String(900 + index).padStart(12, '0')}`,
      snapshot,
      mode,
      detailLevel: 'standard' as const,
    };
    const { selectedText: _selected, ...result } = resultFor(request, options.overrides?.[mode]);
    return result;
  });
  return { snapshot, results, active: options.active ?? modes[0] ?? 'core' };
}

export interface PanelSetup {
  deps: PanelDeps;
  fake: ReturnType<typeof createFakeBackend>;
  fetchState: ReturnType<typeof vi.fn>;
  /** Pretend the service worker said the hand-off changed. */
  push(state: SidePanelState): Promise<void>;
  /** Every Listen run the panel started. */
  runs: RunContext[];
  speech: ListenController & { listen: ReturnType<typeof vi.fn> };
  copied: string[];
  state: { online: boolean; copyOk: boolean; now: number };
}

export function makeDeps(
  initial: SidePanelState | undefined,
  options: { tabId?: number | undefined } = {},
): PanelSetup {
  const fake = createFakeBackend();
  let current: SidePanelState = initial ?? NOTHING;
  let listener: (() => void) | undefined;
  const fetchState = vi.fn(() => Promise.resolve(current));
  const client: PanelClient = {
    fetchState,
    onUpdated: (_tab, next) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
  };
  const runs: RunContext[] = [];
  const speech = {
    listen: vi.fn((context: RunContext) => {
      runs.push(context);
    }),
    openVoiceSettings: vi.fn(),
    handleEvent: vi.fn(() => false),
  };
  const copied: string[] = [];
  const state = { online: true, copyOk: true, now: 1_000_000 };
  let ids = 0;
  const deps: PanelDeps = {
    tabId: 'tabId' in options ? options.tabId : 7,
    client,
    backend: fake.backend,
    speech,
    newId: () => `00000000-0000-4000-8000-${String((ids += 1)).padStart(12, '0')}`,
    now: () => state.now,
    copy: (text) => {
      copied.push(text);
      return Promise.resolve(state.copyOk);
    },
    online: () => state.online,
  };
  return {
    deps,
    fake,
    fetchState,
    async push(next) {
      current = next;
      await act(async () => {
        listener?.();
        await Promise.resolve();
      });
    },
    runs,
    speech,
    copied,
    state,
  };
}

/** Render the panel and let its first fetch settle. */
export async function mountPanel(setup: PanelSetup) {
  const view = render(<SidePanelApp deps={setup.deps} />);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return view;
}

export const stateOf = (handoff: SidePanelHandoff, revision = 1): SidePanelState => ({
  revision,
  handoff,
});
