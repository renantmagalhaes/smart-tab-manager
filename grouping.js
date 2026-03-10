import Fuse from './lib/fuse.esm.js';

let cachedIsVivaldi = null;
const isVivaldi = async () => {
  if (cachedIsVivaldi !== null) return cachedIsVivaldi;
  const tabs = await chrome.tabs.query({ windowType: 'normal' });
  // Vivaldi-specific properties: vivExtData or splitViewId
  cachedIsVivaldi = tabs.length > 0 && ('vivExtData' in tabs[0] || 'splitViewId' in tabs[0]);
  return cachedIsVivaldi;
};

/**
 * Groups tabs based on the current settings in storage.
 */
export async function groupTabs(manualTrigger = false, forcedActiveTabId = null, forceMode = null) {
  const browserIsVivaldi = await isVivaldi();
  console.log(`[SmartTabManager] groupTabs triggered. Manual: ${manualTrigger}, ForcedTab: ${forcedActiveTabId}, ForceMode: ${forceMode}`);

  const settings = await chrome.storage.sync.get([
    'groupMode', 'keywords', 'collapseGroups', 'totalThreshold', 'groupThreshold', 'autoGroup', 'sortStrategy', 'vivaldiNativeStacking'
  ]);
  const allTabs = await chrome.tabs.query({ currentWindow: true, pinned: false });
  const existingGroups = await chrome.tabGroups.query({ windowId: chrome.windows.WINDOW_ID_CURRENT });
  
  const vivaldiNative = settings.vivaldiNativeStacking ?? true;

  console.log(`[SmartTabManager] Browser: ${browserIsVivaldi ? 'Vivaldi' : 'Chrome/Other'}`);
  if (browserIsVivaldi && vivaldiNative) {
    console.log(`[SmartTabManager] Vivaldi Native Stacking: Enabled`);
  }
  if (allTabs.length > 0) {
    const sampleTab = allTabs[0];
    console.log(`[SmartTabManager] Sample Tab Keys:`, Object.keys(sampleTab));
    console.log(`[SmartTabManager] Sample Tab Metadata:`, JSON.stringify(sampleTab, (key, value) => {
      if (key === 'vivExtData') return (value && value.length > 50) ? value.substring(0, 50) + '...' : value;
      return value;
    }, 2));
    
    // Log Vivaldi-specific fields specifically as they might be hidden from stringify
    if (browserIsVivaldi) {
      console.log(`[SmartTabManager] Vivaldi Global Object Check:`, typeof vivaldi);
      console.log(`[SmartTabManager] Vivaldi Fields - splitViewId: ${sampleTab.splitViewId}, workspaceId: ${sampleTab.workspaceId}, extData: ${sampleTab.extData}`);
      
      // Try to see if any hidden properties exist by checking common Vivaldi names
      const vivaldiKeys = ['vivExtData', 'extData', 'vivWorkspaceId', 'vivaldiGroup'];
      vivaldiKeys.forEach(k => {
        if (sampleTab[k]) console.log(`[SmartTabManager] Found hidden Vivaldi key "${k}":`, sampleTab[k]);
      });
      if (sampleTab.vivExtData) {
        try {
          console.log(`[SmartTabManager] Vivaldi Ext Data (Parsed):`, JSON.parse(sampleTab.vivExtData));
        } catch (e) {
          console.log(`[SmartTabManager] Vivaldi Ext Data (Raw):`, sampleTab.vivExtData);
        }
      }
    }
  }
  
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
      groupKey = getRootDomain(url.hostname) || 'Other';
    } else if (settings.groupMode === 'subdomain') {
      groupKey = url.hostname || 'Other';
    } else if (settings.groupMode === 'keyword') {
      groupKey = findFuzzyMatch(tab, fuse) || 'Other';
    }
    
    // Ensure key is never just whitespace
    if (!groupKey.trim()) groupKey = 'Other';
    
    tabGroupAssignments.push({ 
      tabId: tab.id, 
      groupKey, 
      currentGroupId: tab.groupId,
      hostname: url.hostname,
      url: tab.url
    });
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
    const groupAssignments = tabGroupAssignments.filter(a => a.groupKey === key);
    
    // Sort within group if strategy is alphabetical (or by default for better organization)
    if (strategy === 'alphabetical' || strategy === 'activeFirst') {
      groupAssignments.sort((a, b) => {
        const hostA = a.hostname || '';
        const hostB = b.hostname || '';
        const comp = hostA.localeCompare(hostB);
        if (comp !== 0) return comp;
        return (a.url || '').localeCompare(b.url || '');
      });
    }
    
    const tabsInGroup = groupAssignments.map(a => a.tabId);
    
    console.log(`[SmartTabManager] Processing Group "${key}":`, {
      originalOrder: tabGroupAssignments.filter(a => a.groupKey === key).map(a => a.hostname),
      sortedOrder: groupAssignments.map(a => a.hostname),
      tabsInGroup
    });
    
    if (tabsInGroup.length > 0) {
      try {
        let groupId = groupMap.get(key);

        // ONLY RE-ORGANIZE IF:
        // 1. autoGroup is enabled
        // 2. OR it's a manual "Group Now" call and NOT a forceMode call
        // 3. OR the group doesn't exist yet
        let shouldReorganize = (autoGroup || (manualTrigger && !forceMode)) || !groupId;

        // VIVALDI OPTIMIZATION:
        // If we are in Vivaldi, and the tabs are already in THIS group, avoid moving them 
        // to prevent Vivaldi's tab stack logic from flickering or resetting.
        if (browserIsVivaldi && groupId) {
          const allAlreadyInGroup = tabsInGroup.every(tid => {
            const assignment = tabGroupAssignments.find(a => a.tabId === tid);
            return assignment && assignment.currentGroupId === groupId;
          });
          if (allAlreadyInGroup && !manualTrigger) {
            console.log(`[SmartTabManager] Vivaldi: Tabs already in group "${key}", skipping move.`);
            shouldReorganize = false;
          }
        }

        if (shouldReorganize) {
          console.log(`[SmartTabManager] Reorganizing group "${key}" at index ${currentIndex}`);
          
          for (const tabId of tabsInGroup) {
            try {
              await chrome.tabs.move(tabId, { index: currentIndex });
              currentIndex++;
            } catch (moveError) {
              console.warn(`[SmartTabManager] Failed to move tab ${tabId}: ${moveError.message}`);
              // Continue anyway
            }
            
            // VIVALDI NATIVE STACKING WORKAROUND
            if (browserIsVivaldi && vivaldiNative) {
              await new Promise(r => setTimeout(r, 10)); // Breathe
              try {
                const vivData = JSON.stringify({
                  group: `smart-group-${key}`,
                  fixedGroupTitle: key
                });
                await chrome.tabs.update(tabId, { vivExtData: vivData });
              } catch (e) {}
            }
          }

          // ONLY CREATE GROUPS IF:
          // 1. We are not in Vivaldi
          // 2. OR we are in Vivaldi and Native Stacking is ENABLED
          if (!browserIsVivaldi || (browserIsVivaldi && vivaldiNative)) {
            groupId = await chrome.tabs.group({ 
              tabIds: tabsInGroup, 
              groupId: groupId 
            });

            if (browserIsVivaldi) {
              // Forced sticking for Vivaldi
              await chrome.tabGroups.update(groupId, { title: key, color: getColorForKey(key) });
            }
          } else {
            // Un-group tabs if they were in a group before and we are turning stacking OFF
            try {
              await chrome.tabs.ungroup(tabsInGroup);
            } catch (e) {}
            groupId = undefined;
          }
        } else {
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
          try {
            await chrome.tabGroups.update(groupId, updateProps);
            console.log(`[SmartTabManager] Group "${key}" updated successfully.`);
          } catch (updateError) {
            console.warn(`[SmartTabManager] Failed to update group "${key}":`, updateError.message);
            // Fallback: try setting only title if full update fails
            if (browserIsVivaldi) {
               await chrome.tabGroups.update(groupId, { title: key });
            }
          }
        }
      } catch (e) {
        console.warn(`Could not process group "${key}":`, e.message);
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
  if (!hostname) return 'Other';
  
  // Handle IP addresses (e.g., 127.0.0.1, 192.168.1.1)
  const ipRegex = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/;
  if (ipRegex.test(hostname) || hostname === 'localhost') {
    return hostname;
  }

  const parts = hostname.split('.');
  if (parts.length < 2) return hostname;
  
  // List of common/regional TLDs to strip to show only brand name
  const commonTLDs = ['com', 'net', 'org', 'co', 'de', 'cn', 'uk', 'br', 'gov', 'edu'];
  
  const lastPart = parts[parts.length - 1];
  const secondToLast = parts[parts.length - 2];
  
  // Case 1: Complex regional TLDs (e.g., brand.com.br, brand.co.uk)
  if (commonTLDs.includes(secondToLast) && commonTLDs.includes(lastPart) && parts.length >= 3) {
    return parts[parts.length - 3] || secondToLast;
  }
  
  // Case 2: Common single-part TLDs (e.g., google.com, reddit.org)
  if (commonTLDs.includes(lastPart)) {
    return secondToLast || lastPart;
  }
  
  // Case 3: Specialized or uncommon TLDs (e.g., insecure.codes)
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
