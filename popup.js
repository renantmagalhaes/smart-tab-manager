const elements = {
  autoGroupToggle: document.getElementById('autoGroupToggle'),
  collapseToggle: document.getElementById('collapseToggle'),
  thresholdSettings: document.getElementById('thresholdSettings'),
  totalThreshold: document.getElementById('totalThreshold'),
  groupThreshold: document.getElementById('groupThreshold'),
  groupMode: document.getElementById('groupMode'),
  sortStrategy: document.getElementById('sortStrategy'),
  keywordSection: document.getElementById('keywordSection'),
  keywordInput: document.getElementById('keywordInput'),
  groupNowBtn: document.getElementById('groupNowBtn'),
  vivaldiStackingToggle: document.getElementById('vivaldiStackingToggle'),
  extraOptionsHeader: document.getElementById('extraOptionsHeader'),
  extraOptionsContent: document.getElementById('extraOptionsContent'),
  // closeAllBtn: document.getElementById('closeAllBtn'),
  // openAllBtn: document.getElementById('openAllBtn')
};

// Initialize settings from storage
chrome.storage.sync.get(['autoGroup', 'collapseGroups', 'totalThreshold', 'groupThreshold', 'groupMode', 'sortStrategy', 'keywords', 'vivaldiNativeStacking'], (settings) => {
  elements.autoGroupToggle.checked = settings.autoGroup || false;
  elements.collapseToggle.checked = settings.collapseGroups ?? false;
  elements.totalThreshold.value = settings.totalThreshold || 5;
  elements.groupThreshold.value = settings.groupThreshold || 3;
  elements.groupMode.value = settings.groupMode || 'domain';
  elements.sortStrategy.value = settings.sortStrategy || 'alphabetical';
  elements.keywordInput.value = (settings.keywords || []).join(', ');
  elements.vivaldiStackingToggle.checked = settings.vivaldiNativeStacking ?? false;
  
  toggleKeywordSection(elements.groupMode.value);
  toggleThresholdSettings(elements.collapseToggle.checked);
});

// Accordion toggle
elements.extraOptionsHeader.addEventListener('click', () => {
  const isHidden = elements.extraOptionsContent.classList.contains('hidden');
  elements.extraOptionsContent.classList.toggle('hidden');
  elements.extraOptionsHeader.querySelector('.chevron').style.transform = isHidden ? 'rotate(180deg)' : 'rotate(0deg)';
});

// Event Listeners
elements.sortStrategy.addEventListener('change', () => {
  chrome.storage.sync.set({ sortStrategy: elements.sortStrategy.value });
});

elements.autoGroupToggle.addEventListener('change', () => {
  chrome.storage.sync.set({ autoGroup: elements.autoGroupToggle.checked });
});

elements.collapseToggle.addEventListener('change', () => {
  const enabled = elements.collapseToggle.checked;
  chrome.storage.sync.set({ collapseGroups: enabled });
  toggleThresholdSettings(enabled);
});

elements.totalThreshold.addEventListener('change', () => {
  chrome.storage.sync.set({ totalThreshold: parseInt(elements.totalThreshold.value) });
});

elements.groupThreshold.addEventListener('change', () => {
  chrome.storage.sync.set({ groupThreshold: parseInt(elements.groupThreshold.value) });
});

elements.groupMode.addEventListener('change', () => {
  const mode = elements.groupMode.value;
  chrome.storage.sync.set({ groupMode: mode });
  toggleKeywordSection(mode);
});

elements.keywordInput.addEventListener('input', () => {
  const keywords = elements.keywordInput.value.split(',').map(k => k.trim()).filter(k => k !== '');
  chrome.storage.sync.set({ keywords });
});

elements.vivaldiStackingToggle.addEventListener('change', () => {
  chrome.storage.sync.set({ vivaldiNativeStacking: elements.vivaldiStackingToggle.checked });
});

/* 
elements.closeAllBtn.addEventListener('click', () => {
  const originalText = elements.closeAllBtn.innerText;
  elements.closeAllBtn.innerText = 'Closing...';
  elements.closeAllBtn.disabled = true;
  chrome.runtime.sendMessage({ action: 'forceCollapseAll' }, () => {
    setTimeout(() => {
      elements.closeAllBtn.innerText = originalText;
      elements.closeAllBtn.disabled = false;
    }, 500);
  });
});

elements.openAllBtn.addEventListener('click', () => {
  const originalText = elements.openAllBtn.innerText;
  elements.openAllBtn.innerText = 'Opening...';
  elements.openAllBtn.disabled = true;
  chrome.runtime.sendMessage({ action: 'forceExpandAll' }, () => {
    setTimeout(() => {
      elements.openAllBtn.innerText = originalText;
      elements.openAllBtn.disabled = false;
    }, 500);
  });
});
*/

elements.groupNowBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'triggerGroup' }, (response) => {
    // Optional: show a loading state or success animation
    const originalText = elements.groupNowBtn.innerText;
    elements.groupNowBtn.innerText = 'Organizing...';
    elements.groupNowBtn.disabled = true;
    
    setTimeout(() => {
      elements.groupNowBtn.innerText = 'Done!';
      setTimeout(() => {
        elements.groupNowBtn.innerText = originalText;
        elements.groupNowBtn.disabled = false;
      }, 1000);
    }, 800);
  });
});

function toggleKeywordSection(mode) {
  if (mode === 'keyword') {
    elements.keywordSection.classList.remove('hidden');
  } else {
    elements.keywordSection.classList.add('hidden');
  }
}

function toggleThresholdSettings(enabled) {
  if (enabled) {
    elements.thresholdSettings.classList.remove('hidden');
  } else {
    elements.thresholdSettings.classList.add('hidden');
  }
}
