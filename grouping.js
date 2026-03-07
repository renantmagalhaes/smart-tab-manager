import Fuse from './lib/fuse.esm.js';

/**
 * Groups tabs based on the current settings in storage.
 */
export async function groupTabs() {
  const settings = await chrome.storage.sync.get(['groupMode', 'keywords']);
  const tabs = await chrome.tabs.query({ currentWindow: true, pinned: false });
  
  const groups = {};

  // Setup Fuse if in keyword mode
  let fuse = null;
  if (settings.groupMode === 'keyword' && settings.keywords && settings.keywords.length > 0) {
    fuse = new Fuse(settings.keywords.map(kw => ({ name: kw })), {
      keys: ['name'],
      threshold: 0.4
    });
  }

  for (const tab of tabs) {
    const url = new URL(tab.url);
    let groupKey = '';

    if (settings.groupMode === 'domain') {
      groupKey = getRootDomain(url.hostname);
    } else if (settings.groupMode === 'subdomain') {
      groupKey = url.hostname;
    } else if (settings.groupMode === 'keyword') {
      groupKey = findFuzzyMatch(tab, fuse);
    }

    if (groupKey) {
      if (!groups[groupKey]) {
        groups[groupKey] = [];
      }
      groups[groupKey].push(tab.id);
    }
  }

  // Ungroup all first to avoid mixing groups
  // (Alternatively, we could reconcile existing groups, but clearing is cleaner for a "reorganize")
  const existingGroups = await chrome.tabGroups.query({ windowId: chrome.windows.WINDOW_ID_CURRENT });
  // We don't necessarily want to ungroup everything if we are auto-grouping one tab, 
  // but for a manual "Group Now", it's better.
  
  // Create groups in the browser
  for (const [title, tabIds] of Object.entries(groups)) {
    if (tabIds.length > 1) {
      const groupId = await chrome.tabs.group({ tabIds });
      await chrome.tabGroups.update(groupId, { title });
    }
  }
}

function getRootDomain(hostname) {
  const parts = hostname.split('.');
  if (parts.length >= 2) {
    // Basic root domain logic (e.g. google.com, bbc.co.uk is complex but this covers most)
    return parts.slice(-2).join('.');
  }
  return hostname;
}

function findFuzzyMatch(tab, fuse) {
  if (!fuse) return 'Other';
  
  // Try matching with title first, then URL
  const titleResult = fuse.search(tab.title);
  if (titleResult.length > 0) {
    return titleResult[0].item.name;
  }
  
  const urlResult = fuse.search(tab.url);
  if (urlResult.length > 0) {
    return urlResult[0].item.name;
  }
  
  return 'Other';
}
