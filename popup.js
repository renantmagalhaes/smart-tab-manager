const elements = {
  autoGroupToggle: document.getElementById('autoGroupToggle'),
  groupMode: document.getElementById('groupMode'),
  keywordSection: document.getElementById('keywordSection'),
  keywordInput: document.getElementById('keywordInput'),
  groupNowBtn: document.getElementById('groupNowBtn')
};

// Initialize settings from storage
chrome.storage.sync.get(['autoGroup', 'groupMode', 'keywords'], (settings) => {
  elements.autoGroupToggle.checked = settings.autoGroup || false;
  elements.groupMode.value = settings.groupMode || 'domain';
  elements.keywordInput.value = (settings.keywords || []).join(', ');
  
  toggleKeywordSection(elements.groupMode.value);
});

// Event Listeners
elements.autoGroupToggle.addEventListener('change', () => {
  chrome.storage.sync.set({ autoGroup: elements.autoGroupToggle.checked });
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
