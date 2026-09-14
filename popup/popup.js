/**
 * Blackboard Bulk Downloader - Popup Script
 * Manages user interactions, settings, status detection, and download progress.
 */

const browserAPI = (typeof browser !== 'undefined' && browser.runtime) ? browser : chrome;

// DOM Elements
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const courseDetails = document.getElementById('courseDetails');
const courseName = document.getElementById('courseName');
const courseMode = document.getElementById('courseMode');

const actionSection = document.getElementById('actionSection');
const downloadBtn = document.getElementById('downloadBtn');
const downloadBtnText = document.getElementById('downloadBtnText');

const progressSection = document.getElementById('progressSection');
const progressStatus = document.getElementById('progressStatus');
const progressPercent = document.getElementById('progressPercent');
const progressBarFill = document.getElementById('progressBarFill');
const progressFileInfo = document.getElementById('progressFileInfo');
const cancelBtn = document.getElementById('cancelBtn');

const resultSection = document.getElementById('resultSection');
const resultIcon = document.getElementById('resultIcon');
const resultTitle = document.getElementById('resultTitle');
const resultMessage = document.getElementById('resultMessage');
const resetBtn = document.getElementById('resetBtn');

const optionsToggle = document.getElementById('optionsToggle');
const optionsContent = document.getElementById('optionsContent');
const skipVideosCheckbox = document.getElementById('skipVideos');
const maxDepthSelect = document.getElementById('maxDepth');

let activeTabId = null;
let currentCourseInfo = null;

/**
 * Initialize Popup
 */
document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  setupOptionsToggle();
  setupEventHandlers();

  // Check existing download state first
  const bgState = await getBackgroundState();
  if (bgState && ['scanning', 'downloading', 'zipping'].includes(bgState.status)) {
    renderProgressState(bgState);
  } else if (bgState && bgState.status === 'completed') {
    renderCompletedState(bgState);
  } else if (bgState && bgState.status === 'error') {
    renderErrorState(bgState);
  } else {
    // Detect active tab course
    await detectCurrentTab();
  }
});

/**
 * Load persisted user settings
 */
async function loadSettings() {
  try {
    const data = await browserAPI.storage.local.get(['bbSettings']);
    const settings = data.bbSettings || {};

    if (settings.outputMode) {
      const radio = document.querySelector(`input[name="outputMode"][value="${settings.outputMode}"]`);
      if (radio) radio.checked = true;
    }

    if (settings.skipVideos !== undefined) {
      skipVideosCheckbox.checked = !!settings.skipVideos;
    }

    if (settings.maxDepth) {
      maxDepthSelect.value = String(settings.maxDepth);
    }
  } catch (e) {}
}

/**
 * Save current settings to storage
 */
async function saveSettings() {
  const outputMode = document.querySelector('input[name="outputMode"]:checked')?.value || 'zip';
  const settings = {
    outputMode,
    skipVideos: skipVideosCheckbox.checked,
    maxDepth: parseInt(maxDepthSelect.value, 10) || 5
  };

  try {
    await browserAPI.storage.local.set({ bbSettings: settings });
  } catch (e) {}
  return settings;
}

/**
 * Toggle Options Accordion
 */
function setupOptionsToggle() {
  optionsToggle.addEventListener('click', () => {
    const isExpanded = optionsToggle.getAttribute('aria-expanded') === 'true';
    optionsToggle.setAttribute('aria-expanded', !isExpanded);
    optionsContent.style.display = isExpanded ? 'none' : 'flex';
  });

  // Save changes whenever settings change
  document.querySelectorAll('input[name="outputMode"]').forEach(r => {
    r.addEventListener('change', saveSettings);
  });
  skipVideosCheckbox.addEventListener('change', saveSettings);
  maxDepthSelect.addEventListener('change', saveSettings);
}

/**
 * Detect Blackboard course on active tab
 */
async function detectCurrentTab() {
  try {
    const [tab] = await browserAPI.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) {
      showUnconnectedState('No active tab found.');
      return;
    }

    activeTabId = tab.id;

    // Check if the URL matches Blackboard
    const tabUrl = tab.url || '';
    if (!tabUrl.includes('blackboard') && !tabUrl.includes('/ultra/') && !tabUrl.includes('/webapps/')) {
      showUnconnectedState('Navigate to a Blackboard course to download files.');
      return;
    }

    // Try communicating with content script
    let info = null;
    try {
      info = await browserAPI.tabs.sendMessage(tab.id, { action: 'DETECT_COURSE' });
    } catch (e) {
      // Content script may not be injected yet, try injecting
      try {
        await browserAPI.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content/content.js']
        });
        await new Promise(r => setTimeout(r, 100));
        info = await browserAPI.tabs.sendMessage(tab.id, { action: 'DETECT_COURSE' });
      } catch (err) {
        console.warn('Could not inject content script:', err);
      }
    }

    if (info && info.isBlackboard) {
      currentCourseInfo = info;
      showConnectedState(info);
    } else {
      showUnconnectedState('Blackboard course not detected on this page.');
    }
  } catch (err) {
    console.error('Detection error:', err);
    showUnconnectedState('Unable to inspect active tab.');
  }
}

/**
 * UI State: Connected to Blackboard
 */
function showConnectedState(info) {
  statusDot.className = 'dot connected';
  statusText.textContent = 'Blackboard Course Detected';

  courseDetails.style.display = 'flex';
  courseName.textContent = info.courseTitle || 'Course Materials';
  courseMode.textContent = info.mode === 'ultra' ? 'Ultra View' : 'Original View';

  downloadBtn.disabled = false;
  actionSection.style.display = 'flex';
  progressSection.style.display = 'none';
  resultSection.style.display = 'none';
}

/**
 * UI State: Not connected / not on Blackboard
 */
function showUnconnectedState(message) {
  statusDot.className = 'dot warning';
  statusText.textContent = message;
  courseDetails.style.display = 'none';

  downloadBtn.disabled = true;
  actionSection.style.display = 'flex';
  progressSection.style.display = 'none';
  resultSection.style.display = 'none';
}

/**
 * Setup Button Click Handlers
 */
function setupEventHandlers() {
  // Download Button Click
  downloadBtn.addEventListener('click', async () => {
    if (!activeTabId) return;

    const settings = await saveSettings();
    downloadBtn.disabled = true;

    // Show initial progress UI
    progressSection.style.display = 'flex';
    actionSection.style.display = 'none';
    resultSection.style.display = 'none';

    progressStatus.textContent = 'Starting download...';
    progressPercent.textContent = '0%';
    progressBarFill.style.width = '0%';
    progressFileInfo.textContent = 'Scanning course structure...';

    // Notify background script
    await browserAPI.runtime.sendMessage({
      action: 'START_DOWNLOAD',
      tabId: activeTabId,
      settings
    });
  });

  // Cancel Button Click
  cancelBtn.addEventListener('click', async () => {
    cancelBtn.disabled = true;
    cancelBtn.textContent = 'Cancelling...';
    await browserAPI.runtime.sendMessage({ action: 'CANCEL_DOWNLOAD' });
  });

  // Reset / Done Button Click
  resetBtn.addEventListener('click', async () => {
    await browserAPI.runtime.sendMessage({ action: 'RESET_DOWNLOAD_STATE' });
    cancelBtn.disabled = false;
    cancelBtn.textContent = 'Cancel Download';
    resultSection.style.display = 'none';
    progressSection.style.display = 'none';
    actionSection.style.display = 'flex';
    downloadBtn.disabled = false;
    await detectCurrentTab();
  });
}

/**
 * Render Active Download Progress
 */
function renderProgressState(state) {
  actionSection.style.display = 'none';
  resultSection.style.display = 'none';
  progressSection.style.display = 'flex';

  progressStatus.textContent = state.message || 'Processing...';
  progressPercent.textContent = `${state.percent || 0}%`;
  progressBarFill.style.width = `${state.percent || 0}%`;

  if (state.currentFile) {
    progressFileInfo.textContent = state.currentFile;
    progressFileInfo.title = state.currentFile;
  } else if (state.total > 0) {
    progressFileInfo.textContent = `Progress: ${state.current} / ${state.total} files`;
  } else {
    progressFileInfo.textContent = '';
  }

  cancelBtn.disabled = false;
  cancelBtn.textContent = 'Cancel Download';
}

/**
 * Render Completed State
 */
function renderCompletedState(state) {
  actionSection.style.display = 'none';
  progressSection.style.display = 'none';
  resultSection.style.display = 'flex';

  resultIcon.innerHTML = `
    <svg class="result-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
      <polyline points="22 4 12 14.01 9 11.01"></polyline>
    </svg>
  `;
  resultTitle.textContent = 'Download Complete!';
  resultMessage.textContent = state.message || 'All course files have been downloaded.';
}

/**
 * Render Error State
 */
function renderErrorState(state) {
  actionSection.style.display = 'none';
  progressSection.style.display = 'none';
  resultSection.style.display = 'flex';

  resultIcon.innerHTML = `
    <svg class="result-icon error" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="12" r="10"></circle>
      <line x1="15" y1="9" x2="9" y2="15"></line>
      <line x1="9" y1="9" x2="15" y2="15"></line>
    </svg>
  `;
  resultTitle.textContent = 'Download Failed';
  resultMessage.textContent = state.error || 'An error occurred during file extraction.';
}

/**
 * Query background script for current state
 */
async function getBackgroundState() {
  try {
    const response = await browserAPI.runtime.sendMessage({ action: 'GET_DOWNLOAD_STATE' });
    return response?.state || null;
  } catch (e) {
    return null;
  }
}

/**
 * Listen for live background updates
 */
browserAPI.runtime.onMessage.addListener((message) => {
  if (message.action === 'DOWNLOAD_STATE_CHANGED' && message.state) {
    const state = message.state;
    if (['scanning', 'downloading', 'zipping'].includes(state.status)) {
      renderProgressState(state);
    } else if (state.status === 'completed') {
      renderCompletedState(state);
    } else if (state.status === 'error') {
      renderErrorState(state);
    } else if (state.status === 'cancelled') {
      renderErrorState({ error: 'Download was cancelled.' });
    }
  }
});

