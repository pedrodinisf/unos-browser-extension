(function() {
    'use strict';
  
    // Cache DOM elements
    const toggleBtn = document.getElementById('toggleEnabled');
    const grepStrEl = document.getElementById('grepStr');
    const clearEl = document.getElementById('clear');
    const downloadEl = document.getElementById('download');
    const listEl = document.getElementById('list');
    const statusEl = document.getElementById('status');
  
    // Debounce function for input
    function debounce(func, wait) {
      let timeout;
      return function executedFunction(...args) {
        const later = () => {
          clearTimeout(timeout);
          func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
      };
    }
  
    // Update status message
    function setStatus(message, isError = false) {
      if (statusEl) {
        statusEl.textContent = message;
        statusEl.className = isError ? 'error' : 'success';
        if (message) {
          setTimeout(() => {
            if (statusEl.textContent === message) {
              statusEl.textContent = '';
            }
          }, 3000);
        }
      }
    }
  
    // Load settings and list
    function loadData() {
      chrome.storage.local.get(['enabled', 'grepStr', 'urlList'], function(data) {
        if (chrome.runtime.lastError) {
          console.error('Error loading data:', chrome.runtime.lastError);
          setStatus('Error loading data', true);
          return;
        }
        updateToggleButton(!!data.enabled);
        grepStrEl.value = data.grepStr || '';
        updateList(data.urlList || []);
      });
    }
  
    // Listen for storage changes to update list in real-time
    chrome.storage.onChanged.addListener(function(changes, area) {
      if (area === 'local' && changes.urlList) {
        updateList(changes.urlList.newValue || []);
      }
    });
  
    function updateToggleButton(isEnabled) {
      toggleBtn.textContent = isEnabled ? 'Enabled' : 'Enable';
      toggleBtn.className = isEnabled ? 'on' : 'off';
    }

    // Save settings
    function saveSettings() {
      chrome.storage.local.set({
        enabled: toggleBtn.className === 'on',
        grepStr: grepStrEl.value
      }, function() {
        if (chrome.runtime.lastError) {
          console.error('Error saving settings:', chrome.runtime.lastError);
          setStatus('Error saving settings', true);
        }
      });
    }
  
    // Debounced save for input (300ms delay)
    const debouncedSaveSettings = debounce(saveSettings, 300);
  
    // Event listeners
    toggleBtn.addEventListener('click', function() {
      const isNowEnabled = toggleBtn.className !== 'on';
      updateToggleButton(isNowEnabled);
      saveSettings();
    });
    grepStrEl.addEventListener('input', debouncedSaveSettings);
  
    // Clear list
    clearEl.addEventListener('click', function() {
      if (confirm('Are you sure you want to clear all URLs?')) {
        chrome.storage.local.set({ urlList: [] }, function() {
          if (chrome.runtime.lastError) {
            console.error('Error clearing list:', chrome.runtime.lastError);
            setStatus('Error clearing list', true);
          } else {
            updateList([]);
            setStatus('List cleared');
          }
        });
      }
    });
  
    // Download list
    downloadEl.addEventListener('click', function() {
      chrome.storage.local.get('urlList', function(data) {
        if (chrome.runtime.lastError) {
          console.error('Error loading URLs:', chrome.runtime.lastError);
          setStatus('Error loading URLs', true);
          return;
        }
  
        const list = data.urlList || [];
        if (list.length === 0) {
          setStatus('No URLs to download', true);
          return;
        }
  
        // Disable button during download
        downloadEl.disabled = true;
        downloadEl.textContent = 'Downloading...';
  
        const text = list.join('\n');
        const blob = new Blob([text], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        
        chrome.downloads.download({
          url: url,
          filename: 'url_grepper_chrome_extension/output/urls.txt',
          saveAs: false
        }, function(downloadId) {
          // Re-enable button
          downloadEl.disabled = false;
          downloadEl.textContent = 'Download urls.txt';
          
          if (chrome.runtime.lastError) {
            console.error('Download failed:', chrome.runtime.lastError);
            setStatus('Download failed', true);
          } else {
            setStatus(`Downloaded ${list.length} URL${list.length !== 1 ? 's' : ''}`);
          }
          URL.revokeObjectURL(url);
        });
      });
    });
  
    // Update list display
    function updateList(list) {
      if (list.length === 0) {
        listEl.innerHTML = '<div class="empty">No matching URLs yet.</div>';
        return;
      }
      
      // Use DocumentFragment for better performance
      const fragment = document.createDocumentFragment();
      list.forEach(url => {
        const div = document.createElement('div');
        div.className = 'url';
        div.textContent = url;
        fragment.appendChild(div);
      });
      
      listEl.innerHTML = '';
      listEl.appendChild(fragment);
      
      // Update count if element exists
      const countEl = document.getElementById('count');
      if (countEl) {
        countEl.textContent = `${list.length} URL${list.length !== 1 ? 's' : ''}`;
      }
    }
  
    // Initialize
    loadData();

    // --- Capture Section ---

    const captureBtn = document.getElementById('captureFullPage');
    const scrollDelayEl = document.getElementById('scrollDelay');
    const progressContainer = document.getElementById('progressContainer');
    const progressBar = document.getElementById('progressBar');
    const progressText = document.getElementById('progressText');

    // Load capture status on popup open
    function loadCaptureStatus() {
      chrome.storage.local.get(['captureStatus', 'captureProgress', 'captureError'], function(data) {
        if (chrome.runtime.lastError) return;
        updateCaptureUI(data.captureStatus, data.captureProgress, data.captureError);
      });
    }

    // Listen for capture progress updates
    chrome.storage.onChanged.addListener(function(changes, area) {
      if (area !== 'local') return;

      var status = null;
      var progress = null;

      if (changes.captureStatus) status = changes.captureStatus.newValue;
      if (changes.captureProgress) progress = changes.captureProgress.newValue;

      if (status !== null || progress !== null) {
        // Get full state to render correctly
        chrome.storage.local.get(['captureStatus', 'captureProgress', 'captureError'], function(data) {
          if (chrome.runtime.lastError) return;
          updateCaptureUI(data.captureStatus, data.captureProgress, data.captureError);
        });
      }
    });

    function updateCaptureUI(status, progress, error) {
      if (!status || status === 'done' || status === 'error') {
        // Not capturing
        captureBtn.disabled = false;
        captureBtn.textContent = 'Capture Full Page';

        if (status === 'done') {
          progressContainer.classList.add('active');
          progressBar.style.width = '100%';
          progressText.textContent = 'Done! Saved to Downloads.';
          setStatus('Capture saved to Downloads');
          // Clear status after showing
          setTimeout(function() {
            chrome.storage.local.remove(['captureStatus', 'captureProgress', 'captureError']);
            progressContainer.classList.remove('active');
          }, 5000);
        } else if (status === 'error') {
          progressContainer.classList.add('active');
          progressBar.style.width = '0%';
          progressText.textContent = 'Error: ' + (error || 'Capture failed');
          setStatus(error || 'Capture failed', true);
          setTimeout(function() {
            chrome.storage.local.remove(['captureStatus', 'captureProgress', 'captureError']);
            progressContainer.classList.remove('active');
          }, 5000);
        } else {
          progressContainer.classList.remove('active');
        }
      } else {
        // Capturing or stitching
        captureBtn.disabled = true;

        if (status === 'capturing') {
          captureBtn.textContent = 'Capturing...';
          progressContainer.classList.add('active');
          progressBar.style.width = (progress || 0) + '%';
          progressText.textContent = 'Capturing... ' + (progress || 0) + '%';
        } else if (status === 'stitching') {
          captureBtn.textContent = 'Stitching...';
          progressContainer.classList.add('active');
          progressBar.style.width = '96%';
          progressText.textContent = 'Stitching frames...';
        }
      }
    }

    // Start capture
    captureBtn.addEventListener('click', function() {
      captureBtn.disabled = true;
      captureBtn.textContent = 'Starting...';
      progressContainer.classList.add('active');
      progressBar.style.width = '0%';
      progressText.textContent = 'Starting capture...';

      var delay = parseInt(scrollDelayEl.value, 10) || 300;

      chrome.runtime.sendMessage({
        action: 'startCapture',
        options: { delay: delay }
      }, function(response) {
        if (chrome.runtime.lastError) {
          console.error('Failed to start capture:', chrome.runtime.lastError);
          setStatus('Failed to start capture', true);
          captureBtn.disabled = false;
          captureBtn.textContent = 'Capture Full Page';
          progressContainer.classList.remove('active');
        }
        // Response handling is done via storage change listener
      });
    });

    loadCaptureStatus();
  })();
  