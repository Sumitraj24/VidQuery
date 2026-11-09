// VidQuery service worker: opens the side panel, wires shortcuts and the context
// menu, and makes sure YouTube tabs that were open before install get the content script.

const YT_MATCH = /^https:\/\/www\.youtube\.com\//;

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  chrome.contextMenus.create({
    id: 'vq-ask-selection',
    title: 'Ask VidQuery about “%s”',
    contexts: ['selection'],
    documentUrlPatterns: ['https://www.youtube.com/*'],
  });
  chrome.contextMenus.create({
    id: 'vq-explain-moment',
    title: 'Explain this moment with VidQuery',
    contexts: ['page', 'video'],
    documentUrlPatterns: ['https://www.youtube.com/watch*'],
  });

  // Content scripts only load on new page loads; inject into tabs that are already open.
  const tabs = await chrome.tabs.query({ url: 'https://www.youtube.com/*' });
  for (const tab of tabs) injectContent(tab.id);

  if (reason === 'install') {
    chrome.storage.local.set({ 'vq:onboarding': true });
  }
});

async function injectContent(tabId) {
  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['content/content.css'] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/content.js'] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/page-bridge.js'], world: 'MAIN' });
  } catch (e) {
    // Tab may be discarded or still loading; the manifest content script covers new loads.
  }
}

// Actions the side panel should run once it is open (it may still be loading).
async function queueAction(action) {
  await chrome.storage.session.set({ 'vq:pending': { ...action, at: Date.now() } });
}

async function openPanel(tabId) {
  try {
    await chrome.sidePanel.open({ tabId });
    return true;
  } catch (e) {
    return false;
  }
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  // open() must run synchronously inside the user gesture, so call it first.
  const opened = openPanel(tab.id);
  if (info.menuItemId === 'vq-ask-selection' && info.selectionText) {
    await queueAction({ type: 'ask', text: info.selectionText.slice(0, 500), tabId: tab.id });
  } else if (info.menuItemId === 'vq-explain-moment') {
    await queueAction({ type: 'explain', tabId: tab.id });
  }
  await opened;
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'explain-moment' || !tab?.id) return;
  const opened = openPanel(tab.id);
  await queueAction({ type: 'explain', tabId: tab.id });
  await opened;
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'vq:open-panel' && sender.tab?.id) {
    openPanel(sender.tab.id).then(async (ok) => {
      if (ok && msg.action) await queueAction({ ...msg.action, tabId: sender.tab.id });
      sendResponse({ ok });
    });
    return true; // async response
  }
  if (msg?.type === 'vq:inject' && typeof msg.tabId === 'number') {
    injectContent(msg.tabId).then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});

// Keep the toolbar badge honest: show a dot on YouTube watch pages.
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (!change.url && change.status !== 'complete') return;
  const onVideo = YT_MATCH.test(tab.url || '') && /[?&]v=|\/shorts\//.test(tab.url || '');
  chrome.action.setBadgeText({ tabId, text: onVideo ? '●' : '' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#3B82F6' }).catch(() => {});
});
