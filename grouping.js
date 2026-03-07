import Fuse from './lib/fuse.esm.js';

/**
 * Groups tabs based on the current settings in storage.
 */
export async function groupTabs(manualTrigger = false, forcedActiveTabId = null, forceMode = null) {
  console.log(`[SmartTabManager] groupTabs triggered. Manual: ${manualTrigger}, ForcedTab: ${forcedActiveTabId}, ForceMode: ${forceMode}`);

  const settings = await chrome.storage.sync.get([
    'groupMode', 'keywords', 'collapseGroups', 'totalThreshold', 'groupThreshold', 'autoGroup', 'sortStrategy'
  ]);
  const allTabs = await chrome.tabs.query({ currentWindow: true, pinned: false });
  const existingGroups = await chrome.tabGroups.query({ windowId: chrome.windows.WINDOW_ID_CURRENT });
  
  console.log(`[SmartTabManager] Settings:`, settings);
  console.log(`[SmartTabManager] Unpinned Tabs: ${allTabs.length}, Existing Groups: ${existingGroups.length}`);

  // Map by title, but also keep track of groups by their current tab contents if they have no title
  const groupMap = new Map();
  existingGroups.forEach(g => {
    if (g.title) {
      groupMap.set(g.title, g.id);
    }
  });

  // Find active tab to know which group to keep expanded
  let activeTabId = forcedActiveTabId;
  if (!activeTabId) {
    const activeTab = allTabs.find(t => t.active);
    activeTabId = activeTab ? activeTab.id : null;
  }
  
  const autoGroup = settings.autoGroup ?? false;
  const totalTabsCount = allTabs.length;
  const totalThreshold = Number(settings.totalThreshold ?? 5);
  const groupThreshold = Number(settings.groupThreshold ?? 3);
  
  // Setup Fuse if in keyword mode
  let fuse = null;
  const keywords = settings.keywords || [];
  if (settings.groupMode === 'keyword' && keywords.length > 0) {
    fuse = new Fuse(keywords.map(kw => ({ name: kw })), {
      keys: ['name'],
      threshold: 0.4
    });
  }

  // 1. Identify which group each tab belongs to
  const tabGroupAssignments = [];
  const newTabs = [];

  for (const tab of allTabs) {
    if (!tab.url || tab.url.startsWith('chrome-extension://')) {
      newTabs.push(tab.id);
      continue;
    }

    let url;
    try {
      url = new URL(tab.url);
    } catch (e) {
      console.warn(`Skipping invalid URL: ${tab.url}`);
      newTabs.push(tab.id);
      continue;
    }
    let groupKey = 'Other';

    if (settings.groupMode === 'domain') {
      groupKey = getRootDomain(url.hostname);
    } else if (settings.groupMode === 'subdomain') {
      groupKey = url.hostname;
    } else if (settings.groupMode === 'keyword') {
      groupKey = findFuzzyMatch(tab, fuse);
    }
    
    tabGroupAssignments.push({ tabId: tab.id, groupKey, currentGroupId: tab.groupId });
  }

  // 2. Sort groups and tabs to bring them together
  const strategy = settings.sortStrategy || 'alphabetical';
  let groupedKeys = [...new Set(tabGroupAssignments.map(a => a.groupKey))];
  console.log(`[SmartTabManager] Grouped Keys:`, groupedKeys);

  // ... (Strategy sorting logic remains the same)
  if (strategy === 'alphabetical') {
    groupedKeys.sort();
  } else if (strategy === 'manual') {
    const currentTabOrderKeys = [];
    for (const tab of allTabs) {
      if (tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
        const group = existingGroups.find(g => g.id === tab.groupId);
        if (group && group.title && !currentTabOrderKeys.includes(group.title)) {
          currentTabOrderKeys.push(group.title);
        }
      }
    }
    groupedKeys.sort((a, b) => {
      const idxA = currentTabOrderKeys.indexOf(a);
      const idxB = currentTabOrderKeys.indexOf(b);
      if (idxA === -1 && idxB === -1) return a.localeCompare(b);
      if (idxA === -1) return 1;
      if (idxB === -1) return -1;
      return idxA - idxB;
    });
  } else if (strategy === 'activeFirst') {
    const activeAssignment = tabGroupAssignments.find(a => a.tabId === activeTabId);
    const activeKey = activeAssignment ? activeAssignment.groupKey : null;
    groupedKeys.sort();
    if (activeKey) {
      groupedKeys = groupedKeys.filter(k => k !== activeKey);
      groupedKeys.unshift(activeKey);
    }
  }
  
  let currentIndex = 0;
  for (const key of groupedKeys) {
    const tabsInGroup = tabGroupAssignments.filter(a => a.groupKey === key).map(a => a.tabId);
    
    if (tabsInGroup.length > 0) {
      try {
        let groupId = groupMap.get(key);

        // ONLY MOVE & RE-GROUP IF:
        // ONLY RE-ORGANIZE IF:
        // 1. autoGroup is enabled
        // 2. OR it's a manual "Group Now" call and NOT a forceMode call
        // 3. OR the group doesn't exist yet
        const shouldReorganize = (autoGroup || (manualTrigger && !forceMode)) || !groupId;

        if (shouldReorganize) {
          for (const tabId of tabsInGroup) {
            await chrome.tabs.move(tabId, { index: currentIndex });
            currentIndex++;
          }
          groupId = await chrome.tabs.group({ 
            tabIds: tabsInGroup, 
            groupId: groupId 
          });
        } else {
          // Just track position for next groups and use existing groupId
          currentIndex += tabsInGroup.length;
        }

        const updateProps = { 
          title: key,
          color: getColorForKey(key)
        };

        // Advanced Collapsing Logic
        if (forceMode === 'collapseAll') {
          updateProps.collapsed = true;
        } else if (forceMode === 'expandAll') {
          updateProps.collapsed = false;
        } else if (settings.collapseGroups) {
          const containsActiveTab = tabsInGroup.includes(activeTabId);
          const meetsTotalThreshold = totalTabsCount >= totalThreshold;
          const meetsGroupThreshold = tabsInGroup.length >= groupThreshold;

          if (containsActiveTab) {
            updateProps.collapsed = false;
          } else if (meetsTotalThreshold && meetsGroupThreshold) {
            updateProps.collapsed = true;
          } else {
            updateProps.collapsed = false;
          }
        } else if (manualTrigger || !groupId) {
          updateProps.collapsed = false;
        }

        if (groupId) {
          // console.log(`[SmartTabManager] Group "${key}" -> collapsed: ${updateProps.collapsed}`);
          await chrome.tabGroups.update(groupId, updateProps);
        }
      } catch (e) {
        console.warn(`Could not update group "${key}":`, e.message);
        continue; 
      }
    }
  }

  // 3. Move New Tab pages to the end
  if (newTabs.length > 0 && (autoGroup || manualTrigger)) {
    try {
      await chrome.tabs.ungroup(newTabs);
      await chrome.tabs.move(newTabs, { index: -1 });
    } catch (e) {
      console.warn('Could not move new tabs:', e.message);
    }
  }
}

function getRootDomain(hostname) {
  const parts = hostname.split('.');
  if (parts.length < 2) return hostname;
  
  // List of common/regional TLDs to strip to show only brand name
  const commonTLDs = ['com', 'net', 'org', 'co', 'de', 'cn', 'uk', 'br', 'gov', 'edu'];
  
  const lastPart = parts[parts.length - 1];
  const secondToLast = parts[parts.length - 2];
  
  // Case 1: Complex regional TLDs (e.g., brand.com.br, brand.co.uk)
  if (commonTLDs.includes(secondToLast) && commonTLDs.includes(lastPart) && parts.length >= 3) {
    return parts[parts.length - 3];
  }
  
  // Case 2: Common single-part TLDs (e.g., google.com, reddit.org)
  if (commonTLDs.includes(lastPart)) {
    return secondToLast;
  }
  
  // Case 3: Specialized or uncommon TLDs (e.g., insecure.codes)
  // User wants to keep the full domain here
  return parts.slice(-2).join('.');
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
