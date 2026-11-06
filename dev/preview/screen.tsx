import './boot';

/**
 * One extension screen in its own document: `screen.html?screen=<id>&state=<scenario>&theme=<...>`.
 * The real entrypoint modules are imported as they are (their own `main.tsx` mounts into #root),
 * so React Fast Refresh and CSS hot updates work exactly as in the extension.
 */
const params = new URLSearchParams(location.search);
const screen = params.get('screen') ?? 'settings';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(find: () => T | null | undefined, timeoutMs = 8000): Promise<T | null> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const found = find();
    if (found) return found;
    await wait(50);
  }
  return null;
}

/** Reader `pdf=name`: hand a fixture from tests/fixtures/pdf to the file input like a user pick. */
async function openSamplePdf(name: string): Promise<void> {
  const input = await until(() => document.querySelector<HTMLInputElement>('input[type="file"]'));
  if (input === null) return;
  const response = await fetch(`/tests/fixtures/pdf/${encodeURIComponent(name)}.pdf`);
  if (!response.ok) {
    console.warn(
      `Preview: tests/fixtures/pdf/${name}.pdf could not be fetched (${response.status})`,
    );
    return;
  }
  const file = new File([await response.arrayBuffer()], `${name}.pdf`, { type: 'application/pdf' });
  const transfer = new DataTransfer();
  transfer.items.add(file);
  input.files = transfer.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

switch (screen) {
  case 'settings':
    await import('../../entrypoints/options/main');
    break;
  case 'onboarding': {
    const [{ createRoot }, { App }, { STEPS }] = await Promise.all([
      import('react-dom/client'),
      import('../../entrypoints/onboarding/App'),
      import('../../components/onboarding/steps'),
    ]);
    const requestedStep = Number(params.get('step') ?? '1');
    const initialStep = STEPS[requestedStep - 1] ?? STEPS[0];
    const root = document.getElementById('root');
    if (root) createRoot(root).render(<App initialStep={initialStep} />);
    break;
  }
  case 'popup':
    await import('../../entrypoints/popup/main');
    break;
  case 'practice':
    await import('../../entrypoints/practice/main');
    break;
  case 'reader':
    await import('../../entrypoints/reader/main');
    if (params.get('pdf')) void openSamplePdf(params.get('pdf') ?? '');
    break;
  case 'sidepanel':
    await import('../../entrypoints/sidepanel/main');
    break;
  case 'webpage':
    await import('./screens/webpage');
    break;
  default: {
    const message = document.createElement('p');
    message.textContent = `Unknown screen "${screen}".`;
    document.body.append(message);
  }
}
