import Fuse from '../shared/vendor/fuse.esm.js';

/**
 * Checks if a URL is an internal or special browser page that should not be grouped.
 */
export function isInternalUrl(url) {
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
 * Uses standard Chromium Tab Groups and Tabs APIs.
 */
export async function groupTabs(manualTrigger = false, forcedActiveTabId = null, forceMode = null) {
  try {
    console.log(`[SmartTabManager] groupTabs triggered. Manual: ${manualTrigger}, ForcedTab: ${forcedActiveTabId}, ForceMode: ${forceMode}`);

    const settings = await chrome.storage.sync.get([
      'groupMode', 'keywords', 'collapseGroups', 'totalThreshold', 'groupThreshold',
      'autoGroup', 'sortStrategy', 'arrangeInFolders', 'applyFolderNames', 'applyFolderColors',
      'vivaldiNativeStacking', 'vivaldiApplyNames', 'vivaldiApplyColors'
    ]);
    console.log('[SmartTabManager] Current Settings:', settings);

    const autoGroup = settings.autoGroup ?? false;
    const createTabGroups = (settings.arrangeInFolders ?? settings.vivaldiNativeStacking) !== false;
    const applyNames = (settings.applyFolderNames ?? settings.vivaldiApplyNames) !== false;
    const applyColors = (settings.applyFolderColors ?? settings.vivaldiApplyColors) !== false;
    const totalThreshold = Number(settings.totalThreshold ?? 5);
    const groupThreshold = Number(settings.groupThreshold ?? 3);
    const strategy = settings.sortStrategy || 'alphabetical';

    const canMoveTabs = autoGroup || (manualTrigger && !forceMode);

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

    if (!allTabs || allTabs.length === 0) {
      console.log('[SmartTabManager] No unpinned tabs found to organize.');
      return;
    }

    const targetWindowId = allTabs[0].windowId;
    let pinnedTabs = [];
    try {
      pinnedTabs = await chrome.tabs.query({ windowId: targetWindowId, pinned: true });
    } catch (e) {
      console.warn('[SmartTabManager] Failed to query pinned tabs:', e.message);
    }

    const totalTabsCount = allTabs.length + pinnedTabs.length;

    // 2. Check Tab Groups API availability
    const hasTabsGroupApi = typeof chrome.tabs?.group === 'function';
    const hasTabGroupsApi = !!chrome.tabGroups;

    // If folders are disabled, ensure all tabs in this window are ungrouped once
    if (!createTabGroups) {
      const tabsToUngroup = allTabs
        .filter(t => t.groupId && t.groupId !== -1 && t.groupId !== chrome.tabGroups?.TAB_GROUP_ID_NONE)
        .map(t => t.id);

      if (tabsToUngroup.length > 0 && hasTabsGroupApi) {
        try {
          await chrome.tabs.ungroup(tabsToUngroup);
          console.log(`[SmartTabManager] Ungrouped ${tabsToUngroup.length} tabs because folder mode is disabled.`);
        } catch (e) {
          console.warn('[SmartTabManager] Could not ungroup tabs:', e.message);
        }
      }
    }

    // Check if any further action is required
    const needsTidyCheck = createTabGroups && settings.collapseGroups;
    if (!canMoveTabs && !forceMode && !needsTidyCheck) {
      console.log('[SmartTabManager] No action required based on current settings and trigger.');
      return;
    }

    let existingGroups = [];
    if (createTabGroups && hasTabGroupsApi && typeof chrome.tabGroups.query === 'function') {
      try {
        existingGroups = await chrome.tabGroups.query({ windowId: targetWindowId });
      } catch (e) {
        console.warn('[SmartTabManager] Failed to query tabGroups:', e.message);
      }
    }

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

    // 4. Sort groups and determine desired tab order
    let groupedKeys = [...new Set(tabGroupAssignments.map(a => a.groupKey))];

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

    // Build map of sorted assignments per group and full targetTabOrder
    const groupAssignmentsMap = new Map();
    const targetTabOrder = [];

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
      groupAssignmentsMap.set(key, groupAssignments);
      for (const a of groupAssignments) {
        targetTabOrder.push(a.tabId);
      }
    }
    for (const tid of internalTabs) {
      targetTabOrder.push(tid);
    }

    const currentTabIds = allTabs.map(t => t.id);
    const isOrderIdentical = currentTabIds.length === targetTabOrder.length &&
      currentTabIds.every((id, idx) => id === targetTabOrder[idx]);

    let trackedTabIds = [...currentTabIds];
    const pinnedCount = pinnedTabs.length;
    let currentIndex = pinnedCount;

    // Move tabs ONLY if reorganization is allowed and order is not already identical
    if (canMoveTabs && !isOrderIdentical) {
      console.log('[SmartTabManager] Tab order needs updating. Moving out-of-order tabs...');
      for (const key of groupedKeys) {
        const assignments = groupAssignmentsMap.get(key) || [];
        const tabsInGroup = assignments.map(a => a.tabId);
        if (tabsInGroup.length === 0) continue;

        const sliceStart = currentIndex - pinnedCount;
        const currentSlice = trackedTabIds.slice(sliceStart, sliceStart + tabsInGroup.length);
        const isGroupInPlace = currentSlice.length === tabsInGroup.length &&
          currentSlice.every((id, idx) => id === tabsInGroup[idx]);

        if (!isGroupInPlace) {
          try {
            await chrome.tabs.move(tabsInGroup, { index: currentIndex });
          } catch (moveError) {
            console.warn(`[SmartTabManager] Batch move failed for group "${key}", moving sequentially:`, moveError.message);
            let seqIdx = currentIndex;
            for (const tabId of tabsInGroup) {
              try {
                await chrome.tabs.move(tabId, { index: seqIdx++ });
              } catch (seqError) {
                console.warn(`[SmartTabManager] Failed to move tab ${tabId}:`, seqError.message);
              }
            }
          }
          // Update tracked array
          const remaining = trackedTabIds.filter(id => !tabsInGroup.includes(id));
          remaining.splice(sliceStart, 0, ...tabsInGroup);
          trackedTabIds = remaining;
        }
        currentIndex += tabsInGroup.length;
      }
    } else {
      console.log('[SmartTabManager] Tab order already identical or tab movement disabled. Skipping tabs.move.');
    }

    // 5. Handle Folders (Tab Groups) when createTabGroups is enabled
    if (createTabGroups && hasTabsGroupApi) {
      for (const key of groupedKeys) {
        const assignments = groupAssignmentsMap.get(key) || [];
        const tabsInGroup = assignments.map(a => a.tabId);
        if (tabsInGroup.length === 0) continue;

        try {
          let groupId = groupMap.get(key);
          if (!groupId) {
            const matchingTab = allTabs.find(t => tabsInGroup.includes(t.id) && t.groupId && t.groupId !== -1 && t.groupId !== chrome.tabGroups?.TAB_GROUP_ID_NONE);
            if (matchingTab) groupId = matchingTab.groupId;
          }

          // Check if tabs are already grouped exclusively in groupId
          const isAlreadyFullyGrouped = !!groupId &&
            tabsInGroup.every(tid => {
              const tab = allTabs.find(t => t.id === tid);
              return tab && tab.groupId === groupId;
            }) &&
            !allTabs.some(t => t.groupId === groupId && !tabsInGroup.includes(t.id));

          if (!isAlreadyFullyGrouped) {
            const groupOptions = { tabIds: tabsInGroup };
            if (groupId !== undefined && groupId !== null && groupId !== chrome.tabGroups?.TAB_GROUP_ID_NONE) {
              groupOptions.groupId = groupId;
            }

            try {
              groupId = await chrome.tabs.group(groupOptions);
              groupMap.set(key, groupId);
            } catch (groupError) {
              console.warn(`[SmartTabManager] Grouping failed with groupId for "${key}", creating new group:`, groupError.message);
              try {
                groupId = await chrome.tabs.group({ tabIds: tabsInGroup });
                groupMap.set(key, groupId);
              } catch (retryError) {
                console.error(`[SmartTabManager] Failed to group tabs for "${key}":`, retryError);
                groupId = undefined;
              }
            }
          }

          // Apply group title and color
          if (groupId && hasTabGroupsApi) {
            const existingGroup = existingGroups.find(g => g.id === groupId);
            const colorResult = getColorForKey(key);
            const updateProps = {};

            if (applyNames && (!existingGroup || existingGroup.title !== key)) {
              updateProps.title = key;
            }
            if (applyColors && (!existingGroup || existingGroup.color !== colorResult.name)) {
              updateProps.color = colorResult.name;
            }

            if (Object.keys(updateProps).length > 0) {
              try {
                await chrome.tabGroups.update(groupId, updateProps);
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

            // Handle Collapsing (Tidy Mode)
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
            } else if (manualTrigger || !existingGroup) {
              targetCollapsed = false;
            }

            if (targetCollapsed !== null && (!existingGroup || existingGroup.collapsed !== targetCollapsed)) {
              try {
                await chrome.tabGroups.update(groupId, { collapsed: targetCollapsed });
              } catch (collapseError) {
                console.debug(`[SmartTabManager] Collapsed update not applied for "${key}":`, collapseError.message);
              }
            }
          }
        } catch (e) {
          console.warn(`[SmartTabManager] Could not process group "${key}":`, e.message);
          continue;
        }
      }

      // 6. Handle internal/new tabs (keep them ungrouped)
      if (internalTabs.length > 0 && (autoGroup || manualTrigger)) {
        try {
          const groupedInternalTabs = allTabs
            .filter(t => internalTabs.includes(t.id) && t.groupId && t.groupId !== -1 && t.groupId !== chrome.tabGroups?.TAB_GROUP_ID_NONE)
            .map(t => t.id);

          if (groupedInternalTabs.length > 0) {
            await chrome.tabs.ungroup(groupedInternalTabs);
          }
        } catch (e) {
          console.warn('[SmartTabManager] Could not ungroup internal tabs:', e.message);
        }
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

export function getColorForKey(key) {
  const colorMap = [
    { name: 'grey', hex: '#5F6368' },
    { name: 'blue', hex: '#1A73E8' },
    { name: 'red', hex: '#D93025' },
    { name: 'yellow', hex: '#F9AB00' },
    { name: 'green', hex: '#1E8E3E' },
    { name: 'pink', hex: '#D01884' },
    { name: 'purple', hex: '#9334E6' },
    { name: 'cyan', hex: '#12B5CB' },
    { name: 'orange', hex: '#E8710A' }
  ];
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = key.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colorMap[Math.abs(hash) % colorMap.length];
}
