import { groupTabs } from './grouping.js';

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.set({
    autoGroup: false,
    groupMode: 'domain', // 'domain', 'subdomain', 'keyword'
    keywords: []
  });
});

// Listen for tab updates to trigger auto-grouping
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) {
    chrome.storage.sync.get(['autoGroup'], (settings) => {
      if (settings.autoGroup) {
        groupTabs();
      }
    });
  }
});

// Listen for the keyboard command
chrome.commands.onCommand.addListener((command) => {
  if (command === 'group-tabs') {
    groupTabs();
  }
});

// Listen for messages from the popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'triggerGroup') {
    groupTabs();
    sendResponse({ status: 'started' });
  }
});
