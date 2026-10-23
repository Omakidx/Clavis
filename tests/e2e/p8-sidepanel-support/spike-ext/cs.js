// Four buttons in a closed shadow root: a trusted click sends the message; so does a script.
const host = document.createElement('div');
host.style.cssText = 'position:fixed;top:60px;left:10px;z-index:2147483647;display:flex;gap:6px';
const root = host.attachShadow({ mode: 'closed' });
for (const [label, type] of [
  ['A', 'A-sync-setoptions-then-open'],
  ['B', 'B-await-setoptions-then-open'],
  ['C', 'C-open-only-after-prepare'],
  ['D', 'D-delayed-open'],
  ['E', 'E-open-no-gesture'],
]) {
  const button = document.createElement('button');
  button.textContent = label;
  button.style.cssText = 'width:60px;height:40px;font-size:20px';
  button.addEventListener('click', (event) => {
    chrome.runtime.sendMessage({ type, trusted: event.isTrusted }, (reply) => {
      globalThis.__lastReply = { type, reply };
    });
  });
  root.append(button);
}
document.documentElement.append(host);
globalThis.__send = (message) => chrome.runtime.sendMessage(message);
// A script-driven path (no user gesture): the page's own world fires an event, we forward it.
document.addEventListener('spike-send', (event) => {
  chrome.runtime.sendMessage(JSON.parse(event.detail), (reply) => {
    globalThis.__lastReply = { type: 'scripted', reply };
  });
});
// No click at all: a timer fires the message on its own. The page URL fragment names the message
// and the delay, e.g. #auto=E-open-no-gesture@7000. (page.evaluate is NOT a valid "no gesture"
// probe: Playwright evaluates with userGesture: true.)
const auto = /^#auto=([\w-]+)@(\d+)$/.exec(location.hash);
if (auto) {
  setTimeout(() => chrome.runtime.sendMessage({ type: auto[1] }), Number(auto[2]));
}
