import { groupTabs, isInternalUrl } from './grouping.js';

chrome.runtime.onInstalled.addListener((details) => {
  chrome.storage.sync.get(null, (currentSettings) => {
    const defaultSettings = {
      autoGroup: false,
      collapseGroups: false,
      arrangeInFolders: true,     // Arrange in folders/tab groups
      applyFolderNames: true,     // Name folders/tab groups
      applyFolderColors: true,    // Colorize folders/tab groups
      groupMode: 'domain',         // 'domain', 'subdomain', 'keyword'
      keywords: [],
      totalThreshold: 5,
      groupThreshold: 3,
      sortStrategy: 'alphabetical'
    };
    
    // Migrate legacy vivaldi keys if present
    const settingsToSet = {};
    if (currentSettings.arrangeInFolders === undefined) {
      if (currentSettings.vivaldiNativeStacking !== undefined) {
        settingsToSet.arrangeInFolders = currentSettings.vivaldiNativeStacking;
      } else {
        settingsToSet.arrangeInFolders = defaultSettings.arrangeInFolders;
      }
    }
    if (currentSettings.applyFolderNames === undefined) {
      if (currentSettings.vivaldiApplyNames !== undefined) {
        settingsToSet.applyFolderNames = currentSettings.vivaldiApplyNames;
      } else {
        settingsToSet.applyFolderNames = defaultSettings.applyFolderNames;
      }
    }
    if (currentSettings.applyFolderColors === undefined) {
      if (currentSettings.vivaldiApplyColors !== undefined) {
        settingsToSet.applyFolderColors = currentSettings.vivaldiApplyColors;
      } else {
        settingsToSet.applyFolderColors = defaultSettings.applyFolderColors;
      }
    }

    // Only set defaults for keys that don't exist yet
    for (const key in defaultSettings) {
      if (currentSettings[key] === undefined && settingsToSet[key] === undefined) {
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
  chrome.storage.sync.get(['autoGroup'], (settings) => {
    if (settings.autoGroup) {
      debouncedGroupTabs();
    }
  });
});

// Listen for tab updates (URL change or page load completion)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' || changeInfo.url) {
    chrome.storage.sync.get(['autoGroup'], (settings) => {
      if (settings.autoGroup) {
        debouncedGroupTabs();
      }
    });
  }
});

// Listen for tab creation
chrome.tabs.onCreated.addListener((tab) => {
  // Empty/internal new tabs have no target URL yet; onUpdated will handle them when loaded.
  if (tab.url && !isInternalUrl(tab.url)) {
    chrome.storage.sync.get(['autoGroup'], (settings) => {
      if (settings.autoGroup) {
        debouncedGroupTabs();
      }
    });
  }
});

// Listen for tab removal
chrome.tabs.onRemoved.addListener(() => {
  chrome.storage.sync.get([
    'autoGroup', 'collapseGroups',
    'arrangeInFolders', 'vivaldiNativeStacking'
  ], (settings) => {
    const arrangeInFolders = settings.arrangeInFolders ?? settings.vivaldiNativeStacking ?? true;
    if (settings.autoGroup || (arrangeInFolders && settings.collapseGroups)) {
      debouncedGroupTabs();
    }
  });
});

// Listen for tab activation (switching active tab updates Tidy Mode collapsing)
chrome.tabs.onActivated.addListener((activeInfo) => {
  chrome.storage.sync.get([
    'autoGroup', 'collapseGroups', 'sortStrategy',
    'arrangeInFolders', 'vivaldiNativeStacking'
  ], (settings) => {
    const arrangeInFolders = settings.arrangeInFolders ?? settings.vivaldiNativeStacking ?? true;
    const needsTidyUpdate = arrangeInFolders && settings.collapseGroups;
    const needsActiveFirstReorder = settings.autoGroup && settings.sortStrategy === 'activeFirst';
    if (needsTidyUpdate || needsActiveFirstReorder) {
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
