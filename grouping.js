import Fuse from './lib/fuse.esm.js';

/**
 * Groups tabs based on the current settings in storage.
 */
export async function groupTabs(manualTrigger = false) {
  const settings = await chrome.storage.sync.get(['groupMode', 'keywords', 'collapseGroups']);
  const allTabs = await chrome.tabs.query({ currentWindow: true, pinned: false });
  const existingGroups = await chrome.tabGroups.query({ windowId: chrome.windows.WINDOW_ID_CURRENT });
  const groupMap = new Map(existingGroups.map(g => [g.title, g.id]));
  
  // Setup Fuse if in keyword mode
  let fuse = null;
  if (settings.groupMode === 'keyword' && settings.keywords && settings.keywords.length > 0) {
    fuse = new Fuse(settings.keywords.map(kw => ({ name: kw })), {
      keys: ['name'],
      threshold: 0.4
    });
  }

  // 1. Identify which group each tab belongs to
  // Separate "New Tab" pages to keep them at the end
  const tabGroupAssignments = [];
  const newTabs = [];

  for (const tab of allTabs) {
    if (tab.url.startsWith('chrome://newtab') || tab.url === 'about:newtab' || (tab.url === 'about:blank' && !tab.title)) {
      newTabs.push(tab.id);
      continue;
    }

    const url = new URL(tab.url);
    let groupKey = 'Other';

    if (settings.groupMode === 'domain') {
      groupKey = getRootDomain(url.hostname);
    } else if (settings.groupMode === 'subdomain') {
      groupKey = url.hostname;
    } else if (settings.groupMode === 'keyword') {
      groupKey = findFuzzyMatch(tab, fuse);
    }
    
    tabGroupAssignments.push({ tabId: tab.id, groupKey });
  }

  // 2. Sort groups and tabs to bring them together
  const groupedKeys = [...new Set(tabGroupAssignments.map(a => a.groupKey))].sort();
  
  let currentIndex = 0;
  for (const key of groupedKeys) {
    const tabsInGroup = tabGroupAssignments.filter(a => a.groupKey === key).map(a => a.tabId);
    
    if (tabsInGroup.length > 0) {
      for (const tabId of tabsInGroup) {
        await chrome.tabs.move(tabId, { index: currentIndex });
        currentIndex++;
      }

      const existingGroupId = groupMap.get(key);
      const groupId = await chrome.tabs.group({ 
        tabIds: tabsInGroup, 
        groupId: existingGroupId 
      });

      const updateProps = { 
        title: key,
        color: getColorForKey(key)
      };

      if (!existingGroupId || manualTrigger) {
        updateProps.collapsed = settings.collapseGroups ?? true;
      }

      await chrome.tabGroups.update(groupId, updateProps);
    }
  }

  // 3. Move New Tab pages to the end
  if (newTabs.length > 0) {
    // Ungroup new tabs if they were previously grouped by mistake
    await chrome.tabs.ungroup(newTabs);
    await chrome.tabs.move(newTabs, { index: -1 });
  }
}

function getRootDomain(hostname) {
  const parts = hostname.split('.');
  if (parts.length >= 2) {
    return parts.slice(-2).join('.');
  }
  return hostname;
}

function findFuzzyMatch(tab, fuse) {
  if (!fuse) return 'Other';
  const titleResult = fuse.search(tab.title);
  if (titleResult.length > 0) return titleResult[0].item.name;
  const urlResult = fuse.search(tab.url);
  if (urlResult.length > 0) return urlResult[0].item.name;
  return 'Other';
}

function getColorForKey(key) {
  const colors = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = key.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}
