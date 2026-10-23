const out = document.getElementById('out');
const say = (text) => (out.textContent += text + '\n');
async function tabId() {
  return (await chrome.tabs.getCurrent())?.id;
}
document.getElementById('f1').addEventListener('click', async () => {
  const id = await tabId();
  try {
    await chrome.sidePanel.setOptions({ tabId: id, path: `panel.html?tab=${id}`, enabled: true });
    await chrome.sidePanel.open({ tabId: id });
    say('F1 ok');
  } catch (e) {
    say('F1 fail ' + e.message);
  }
});
document.getElementById('f2').addEventListener('click', async () => {
  const id = await tabId();
  try {
    await chrome.sidePanel.open({ tabId: id });
    say('F2 ok');
  } catch (e) {
    say('F2 fail ' + e.message);
  }
});
