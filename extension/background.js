async function enableSidePanelOnClick() {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
}

chrome.runtime.onInstalled.addListener(() => {
  enableSidePanelOnClick();
});

chrome.runtime.onStartup.addListener(() => {
  enableSidePanelOnClick();
});

enableSidePanelOnClick();
