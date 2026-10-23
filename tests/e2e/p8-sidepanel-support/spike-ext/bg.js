// Spike: which patterns let the background open a per-tab side panel for a trusted click?
globalThis.log = [];
const note = (entry) => globalThis.log.push(entry);
chrome.sidePanel.setOptions({ enabled: false }).catch(() => {});

const tabPath = (tabId) => `panel.html?tab=${tabId}`;

chrome.runtime.onMessage.addListener((msg, sender, send) => {
  if (msg.type === 'panel-loaded') {
    note({
      kind: 'panel-loaded',
      url: sender.url,
      hasTab: sender.tab !== undefined,
      frameId: sender.frameId,
      id: sender.id === chrome.runtime.id,
      origin: sender.origin,
      ...msg,
    });
    send({ ok: true });
    return;
  }
  const tabId = sender.tab?.id ?? msg.tabId;
  const done = (variant) => (ok, err) => {
    note({ kind: 'result', variant, ok, err: err ? String(err.message ?? err) : undefined });
    send({ ok, err: err ? String(err.message ?? err) : undefined });
  };
  switch (msg.type) {
    case 'A-sync-setoptions-then-open': {
      // setOptions not awaited; open called in the same synchronous turn.
      void chrome.sidePanel.setOptions({ tabId, path: tabPath(tabId), enabled: true });
      chrome.sidePanel.open({ tabId }).then(
        () => done('A')(true),
        (e) => done('A')(false, e),
      );
      return true;
    }
    case 'B-await-setoptions-then-open': {
      chrome.sidePanel
        .setOptions({ tabId, path: tabPath(tabId), enabled: true })
        .then(() => chrome.sidePanel.open({ tabId }))
        .then(
          () => done('B')(true),
          (e) => done('B')(false, e),
        );
      return true;
    }
    case 'C-open-only-after-prepare': {
      // The panel was prepared earlier (message 'prepare'), open is the only call here.
      chrome.sidePanel.open({ tabId }).then(
        () => done('C')(true),
        (e) => done('C')(false, e),
      );
      return true;
    }
    case 'prepare': {
      chrome.sidePanel
        .setOptions({ tabId, path: tabPath(tabId), enabled: true })
        .then(() => send({ ok: true }));
      return true;
    }
    case 'D-delayed-open': {
      chrome.sidePanel.setOptions({ tabId, path: tabPath(tabId), enabled: true });
      setTimeout(() => {
        chrome.sidePanel.open({ tabId }).then(
          () => done('D')(true),
          (e) => done('D')(false, e),
        );
      }, 6000);
      return true;
    }
    case 'E-open-no-gesture': {
      // The test sends this from a programmatic (untrusted) call, not from a click.
      chrome.sidePanel.setOptions({ tabId, path: tabPath(tabId), enabled: true });
      chrome.sidePanel.open({ tabId }).then(
        () => done('E')(true),
        (e) => done('E')(false, e),
      );
      return true;
    }
    case 'E2-microtask-then-open': {
      void chrome.sidePanel.setOptions({ tabId, path: tabPath(tabId), enabled: true });
      Promise.resolve().then(() =>
        chrome.sidePanel.open({ tabId }).then(
          () => done('E2')(true),
          (e) => done('E2')(false, e),
        ),
      );
      return true;
    }
    case 'E3-open-only-never-prepared': {
      chrome.sidePanel.open({ tabId }).then(
        () => done('E3')(true),
        (e) => done('E3')(false, e),
      );
      return true;
    }
    case 'F-direct-from-extension-page': {
      send({ ok: true });
      return;
    }
  }
});
