import { groupTabs } from './grouping.js';

chrome.runtime.onInstalled.addListener((details) => {
  chrome.storage.sync.get(null, (currentSettings) => {
    const defaultSettings = {
      autoGroup: false,
      collapseGroups: false,
      vivaldiNativeStacking: true, // Arrange in folders/stacks
      vivaldiApplyNames: true,     // Name folders/stacks
      vivaldiApplyColors: true,    // Colorize folders/stacks
      groupMode: 'domain',         // 'domain', 'subdomain', 'keyword'
      keywords: [],
      totalThreshold: 5,
      groupThreshold: 3,
      sortStrategy: 'alphabetical'
    };
    
    // Only set defaults for keys that don't exist yet
    const settingsToSet = {};
    for (const key in defaultSettings) {
      if (currentSettings[key] === undefined) {
        settingsToSet[key] = defaultSettings[key];
      }
    }
    
    if (Object.keys(settingsToSet).length > 0) {
      chrome.storage.sync.set(settingsToSet);
    }
  });
});

// Helper to debounce grouping calls to prevent race conditions
let groupDebounceTimer = null;
function debouncedGroupTabs(manual = false, forcedTabId = null, forceMode = null) {
  if (groupDebounceTimer) clearTimeout(groupDebounceTimer);
  groupDebounceTimer = setTimeout(() => {
    groupTabs(manual, forcedTabId, forceMode);
  }, 150);
}

// Listen for browser startup
chrome.runtime.onStartup.addListener(() => {
  chrome.storage.sync.get(['autoGroup', 'collapseGroups'], (settings) => {
    if (settings.autoGroup || settings.collapseGroups) {
      debouncedGroupTabs();
    }
  });
});

// Listen for tab updates (URL change or page load completion)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' || changeInfo.url) {
    chrome.storage.sync.get(['autoGroup', 'collapseGroups'], (settings) => {
      if (settings.autoGroup || settings.collapseGroups) {
        debouncedGroupTabs();
      }
    });
  }
});

// Listen for tab creation
chrome.tabs.onCreated.addListener(() => {
  chrome.storage.sync.get(['autoGroup', 'collapseGroups'], (settings) => {
    if (settings.autoGroup || settings.collapseGroups) {
      debouncedGroupTabs();
    }
  });
});

// Listen for tab removal
chrome.tabs.onRemoved.addListener(() => {
  chrome.storage.sync.get(['autoGroup', 'collapseGroups'], (settings) => {
    if (settings.autoGroup || settings.collapseGroups) {
      debouncedGroupTabs();
    }
  });
});

// Listen for tab activation (switching active tab updates Tidy Mode collapsing)
chrome.tabs.onActivated.addListener((activeInfo) => {
  chrome.storage.sync.get(['autoGroup', 'collapseGroups'], (settings) => {
    if (settings.autoGroup || settings.collapseGroups) {
      debouncedGroupTabs(false, activeInfo.tabId);
    }
  });
});

// Listen for keyboard commands (e.g. Ctrl+Shift+G)
if (chrome.commands && chrome.commands.onCommand) {
  chrome.commands.onCommand.addListener((command) => {
    if (command === 'group-tabs') {
      debouncedGroupTabs(true);
    }
  });
}

// Listen for messages from the popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[SmartTabManager] Message received:', message);
  if (message.action === 'triggerGroup') {
    groupTabs(true);
    sendResponse({ status: 'started' });
  } else if (message.action === 'forceCollapseAll') {
    groupTabs(true, null, 'collapseAll');
    sendResponse({ status: 'collapse_started' });
  } else if (message.action === 'forceExpandAll') {
    groupTabs(true, null, 'expandAll');
    sendResponse({ status: 'expand_started' });
  }
  return true;
});
