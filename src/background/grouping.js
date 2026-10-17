import Fuse from '../shared/vendor/fuse.esm.js';

let cachedIsVivaldi = null;
const isVivaldi = async () => {
  if (cachedIsVivaldi !== null) return cachedIsVivaldi;
  try {
    const tabs = await chrome.tabs.query({ windowType: 'normal' });
    cachedIsVivaldi = tabs.length > 0 && ('vivExtData' in tabs[0] || 'splitViewId' in tabs[0]);
  } catch (e) {
    cachedIsVivaldi = false;
  }
  return cachedIsVivaldi;
};

/**
 * Checks if a URL is an internal or special browser page that should not be grouped.
 */
function isInternalUrl(url) {
  if (!url) return true;
  return (
    url.startsWith('chrome://') ||
    url.startsWith('chrome-extension://') ||
    url.startsWith('vivaldi://') ||
    url.startsWith('edge://') ||
    url.startsWith('about:') ||
    url.startsWith('devtools://') ||
    url.startsWith('view-source:')
  );
}

/**
 * Groups tabs based on the current settings in storage.
 * Supports both Chromium Tab Groups API (VB-131507) and Vivaldi vivExtData Tab Stacking.
 */
export async function groupTabs(manualTrigger = false, forcedActiveTabId = null, forceMode = null) {
  try {
    const browserIsVivaldi = await isVivaldi();
    console.log(`[SmartTabManager] groupTabs triggered. Manual: ${manualTrigger}, ForcedTab: ${forcedActiveTabId}, ForceMode: ${forceMode}, Browser: ${browserIsVivaldi ? 'Vivaldi' : 'Chromium'}`);

    const settings = await chrome.storage.sync.get([
      'groupMode', 'keywords', 'collapseGroups', 'totalThreshold', 'groupThreshold',
      'autoGroup', 'sortStrategy', 'vivaldiNativeStacking', 'vivaldiApplyNames', 'vivaldiApplyColors'
    ]);
    console.log('[SmartTabManager] Current Settings:', settings);

    // 1. Retrieve tabs from the active window with fallbacks
    let allTabs = [];
    try {
      allTabs = await chrome.tabs.query({ lastFocusedWindow: true, pinned: false });
    } catch (e) {
      console.warn('[SmartTabManager] lastFocusedWindow query failed:', e.message);
    }

    if (!allTabs || allTabs.length === 0) {
      try {
        allTabs = await chrome.tabs.query({ currentWindow: true, pinned: false });
      } catch (e) {
        console.warn('[SmartTabManager] currentWindow query failed:', e.message);
      }
    }

    if (!allTabs || allTabs.length === 0) {
      try {
        const windows = await chrome.windows.getAll({ windowTypes: ['normal'], populate: true });
        const targetWin = windows.find(w => w.focused) || windows[0];
        if (targetWin && targetWin.tabs) {
          allTabs = targetWin.tabs.filter(t => !t.pinned);
        }
      } catch (e) {
        console.warn('[SmartTabManager] windows.getAll query failed:', e.message);
      }
    }

    console.log(`[SmartTabManager] Unpinned Tabs found: ${allTabs?.length || 0}`);
    if (!allTabs || allTabs.length === 0) {
      console.warn('[SmartTabManager] No tabs found to organize in target window.');
      return;
    }

    const targetWindowId = allTabs[0].windowId;
    console.log(`[SmartTabManager] Target Window ID: ${targetWindowId}`);

    if (allTabs.length > 0 && browserIsVivaldi) {
      console.log(`[SmartTabManager] Sample Tab vivExtData:`, allTabs[0].vivExtData);
    }

    let pinnedTabs = [];
    try {
      pinnedTabs = await chrome.tabs.query({ windowId: targetWindowId, pinned: true });
    } catch (e) {
      console.warn('[SmartTabManager] Failed to query pinned tabs:', e.message);
    }

    // 2. Check Tab Groups API availability
    const hasTabsGroupApi = typeof chrome.tabs?.group === 'function';
    const hasTabGroupsApi = !!chrome.tabGroups;
    console.log('[SmartTabManager] Tab Group API Support:', {
      hasTabsGroupApi,
      hasTabGroupsApi,
      tabGroupsObject: chrome.tabGroups ? Object.keys(chrome.tabGroups) : null
    });

    let existingGroups = [];
    if (hasTabGroupsApi && typeof chrome.tabGroups.query === 'function') {
      try {
        existingGroups = await chrome.tabGroups.query({ windowId: targetWindowId });
        console.log(`[SmartTabManager] Existing tab groups count: ${existingGroups.length}`);
      } catch (e) {
        console.warn('[SmartTabManager] Failed to query tabGroups:', e.message);
      }
    }

    // Mode options
    const autoGroup = settings.autoGroup ?? false;
    const createTabGroups = settings.vivaldiNativeStacking !== false;
    const applyNames = settings.vivaldiApplyNames !== false;
    const applyColors = settings.vivaldiApplyColors !== false;
    const totalTabsCount = allTabs.length + pinnedTabs.length;
    const totalThreshold = Number(settings.totalThreshold ?? 5);
    const groupThreshold = Number(settings.groupThreshold ?? 3);

    console.log('[SmartTabManager] Organization flags:', {
      createTabGroups,
      applyNames,
      applyColors,
      autoGroup,
      totalTabsCount
    });

    // Map existing groups by title
    const groupMap = new Map();
    existingGroups.forEach(g => {
      if (g.title) {
        groupMap.set(g.title, g.id);
      }
    });

    // Find active tab
    let activeTabId = forcedActiveTabId;
    if (!activeTabId) {
      const activeTab = allTabs.find(t => t.active);
      activeTabId = activeTab ? activeTab.id : null;
    }

    // Setup Fuse if in keyword mode
    let fuse = null;
    const keywords = settings.keywords || [];
    if (settings.groupMode === 'keyword' && keywords.length > 0) {
      fuse = new Fuse(keywords.map(kw => ({ name: kw })), {
        keys: ['name'],
        threshold: 0.4
      });
    }

    // 3. Identify which group each tab belongs to
    const tabGroupAssignments = [];
    const internalTabs = [];

    for (const tab of allTabs) {
      if (isInternalUrl(tab.url)) {
        internalTabs.push(tab.id);
        continue;
      }

      let url;
      try {
        url = new URL(tab.url);
      } catch (e) {
        console.warn(`[SmartTabManager] Skipping invalid URL: ${tab.url}`);
        internalTabs.push(tab.id);
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

      if (!groupKey.trim()) groupKey = 'Other';

      tabGroupAssignments.push({
        tabId: tab.id,
        groupKey,
        currentGroupId: tab.groupId,
        hostname: url.hostname,
        url: tab.url
      });
    }

    // 4. Sort groups and tabs
    const strategy = settings.sortStrategy || 'alphabetical';
    let groupedKeys = [...new Set(tabGroupAssignments.map(a => a.groupKey))];
    console.log('[SmartTabManager] Identified Group Keys:', groupedKeys);

    if (strategy === 'alphabetical') {
      groupedKeys.sort();
    } else if (strategy === 'manual') {
      const currentTabOrderKeys = [];
      for (const tab of allTabs) {
        if (tab.groupId && tab.groupId !== chrome.tabGroups?.TAB_GROUP_ID_NONE) {
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

    // Account for pinned tabs so we never try to move unpinned tabs to pinned positions
    let currentIndex = pinnedTabs.length;

    for (const key of groupedKeys) {
      const groupAssignments = tabGroupAssignments.filter(a => a.groupKey === key);

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
      if (tabsInGroup.length === 0) continue;

      console.log(`[SmartTabManager] Processing Group "${key}" with ${tabsInGroup.length} tabs:`, tabsInGroup);

      try {
        let groupId = groupMap.get(key);

        // Check if tabs are already consecutive and assigned to this group
        let shouldReorganize = (autoGroup || (manualTrigger && !forceMode)) || !groupId;
        if (groupId) {
          const allAlreadyInGroup = tabsInGroup.every(tid => {
            const assignment = tabGroupAssignments.find(a => a.tabId === tid);
            return assignment && assignment.currentGroupId === groupId;
          });
          if (allAlreadyInGroup && !manualTrigger) {
            shouldReorganize = false;
          }
        }

        // Move tabs contiguously if reorganization is needed
        if (shouldReorganize) {
          try {
            await chrome.tabs.move(tabsInGroup, { index: currentIndex });
            currentIndex += tabsInGroup.length;
          } catch (moveError) {
            console.warn(`[SmartTabManager] Batch move failed for group "${key}", moving sequentially:`, moveError.message);
            for (const tabId of tabsInGroup) {
              try {
                await chrome.tabs.move(tabId, { index: currentIndex });
                currentIndex++;
              } catch (seqError) {
                console.warn(`[SmartTabManager] Failed to move tab ${tabId}:`, seqError.message);
              }
            }
          }
        } else {
          currentIndex += tabsInGroup.length;
        }

        // Group tabs
        if (createTabGroups) {
          // --- Method A: Chromium Tab Groups API (VB-131507) ---
          if (hasTabsGroupApi) {
            const groupOptions = { tabIds: tabsInGroup };
            if (groupId !== undefined && groupId !== null && groupId !== chrome.tabGroups?.TAB_GROUP_ID_NONE) {
              groupOptions.groupId = groupId;
            }

            console.log(`[SmartTabManager] Calling chrome.tabs.group for "${key}" with options:`, groupOptions);
            try {
              groupId = await chrome.tabs.group(groupOptions);
              console.log(`[SmartTabManager] chrome.tabs.group succeeded for "${key}", groupId: ${groupId}`);
              groupMap.set(key, groupId);
            } catch (groupError) {
              console.warn(`[SmartTabManager] Grouping failed with groupId for "${key}", creating new group:`, groupError.message);
              try {
                groupId = await chrome.tabs.group({ tabIds: tabsInGroup });
                console.log(`[SmartTabManager] chrome.tabs.group retry succeeded for "${key}", groupId: ${groupId}`);
                groupMap.set(key, groupId);
              } catch (retryError) {
                console.error(`[SmartTabManager] Failed to group tabs for "${key}":`, retryError);
                groupId = undefined;
              }
            }

            // Apply group title and color using standard Chromium tabGroups API
            if (groupId && hasTabGroupsApi) {
              const colorResult = getColorForKey(key);
              const updateProps = {};

              if (applyNames) updateProps.title = key;
              if (applyColors) updateProps.color = colorResult.name;

              if (Object.keys(updateProps).length > 0) {
                console.log(`[SmartTabManager] Updating group ${groupId} ("${key}") with:`, updateProps);
                try {
                  await chrome.tabGroups.update(groupId, updateProps);
                  console.log(`[SmartTabManager] Group ${groupId} title/color updated successfully.`);
                } catch (updateError) {
                  console.warn(`[SmartTabManager] Failed to update title/color for "${key}":`, updateError.message);
                  if (updateProps.title) {
                    try {
                      await chrome.tabGroups.update(groupId, { title: updateProps.title });
                    } catch (fallbackError) {
                      console.warn(`[SmartTabManager] Title fallback failed:`, fallbackError.message);
                    }
                  }
                }
              }

              // Handle Collapsing (Tidy Mode) separately
              let targetCollapsed = null;
              if (forceMode === 'collapseAll') {
                targetCollapsed = true;
              } else if (forceMode === 'expandAll') {
                targetCollapsed = false;
              } else if (settings.collapseGroups) {
                const containsActiveTab = tabsInGroup.includes(activeTabId);
                const meetsTotalThreshold = totalTabsCount >= totalThreshold;
                const meetsGroupThreshold = tabsInGroup.length >= groupThreshold;

                if (containsActiveTab) {
                  targetCollapsed = false;
                } else if (meetsTotalThreshold && meetsGroupThreshold) {
                  targetCollapsed = true;
                } else {
                  targetCollapsed = false;
                }
              } else if (manualTrigger || !groupMap.has(key)) {
                targetCollapsed = false;
              }

              if (targetCollapsed !== null) {
                try {
                  await chrome.tabGroups.update(groupId, { collapsed: targetCollapsed });
                } catch (collapseError) {
                  console.debug(`[SmartTabManager] Collapsed update not applied for "${key}":`, collapseError.message);
                }
              }
            }
          }
        } else {
          // Folders turned off: ungroup tabs via standard API
          if (hasTabsGroupApi) {
            try {
              await chrome.tabs.ungroup(tabsInGroup);
            } catch (e) {}
          }
          groupId = undefined;
        }
      } catch (e) {
        console.warn(`[SmartTabManager] Could not process group "${key}":`, e.message);
        continue;
      }
    }

    // 5. Handle internal/new tabs (keep them ungrouped)
    if (internalTabs.length > 0 && (autoGroup || manualTrigger)) {
      try {
        const groupedInternalTabs = allTabs
          .filter(t => internalTabs.includes(t.id) && t.groupId && t.groupId !== chrome.tabGroups?.TAB_GROUP_ID_NONE)
          .map(t => t.id);

        if (groupedInternalTabs.length > 0 && hasTabsGroupApi) {
          await chrome.tabs.ungroup(groupedInternalTabs);
        }
      } catch (e) {
        console.warn('[SmartTabManager] Could not ungroup internal tabs:', e.message);
      }
    }

    console.log('[SmartTabManager] groupTabs completed successfully.');
  } catch (fatalError) {
    console.error('[SmartTabManager] Fatal error in groupTabs:', fatalError);
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
  const colorMap = [
    { name: 'grey', hex: '#5F6368', vivaldiId: 'color1', vivaldiIndex: 1 },
    { name: 'blue', hex: '#1A73E8', vivaldiId: 'color2', vivaldiIndex: 2 },
    { name: 'red', hex: '#D93025', vivaldiId: 'color3', vivaldiIndex: 3 },
    { name: 'yellow', hex: '#F9AB00', vivaldiId: 'color4', vivaldiIndex: 4 },
    { name: 'green', hex: '#1E8E3E', vivaldiId: 'color5', vivaldiIndex: 5 },
    { name: 'pink', hex: '#D01884', vivaldiId: 'color6', vivaldiIndex: 6 },
    { name: 'purple', hex: '#9334E6', vivaldiId: 'color7', vivaldiIndex: 7 },
    { name: 'cyan', hex: '#12B5CB', vivaldiId: 'color8', vivaldiIndex: 8 },
    { name: 'orange', hex: '#E8710A', vivaldiId: 'color9', vivaldiIndex: 9 }
  ];
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = key.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colorMap[Math.abs(hash) % colorMap.length];
}
