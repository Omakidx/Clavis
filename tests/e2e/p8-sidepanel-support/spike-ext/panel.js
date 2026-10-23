(async () => {
  const current = await chrome.tabs.getCurrent();
  chrome.runtime.sendMessage({
    type: 'panel-loaded',
    href: location.href,
    getCurrent: current ?? null,
  });
})();
