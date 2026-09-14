/**
 * Blackboard Bulk Downloader - Background Script (Event Page / Service Worker)
 * Orchestrates scanning, fetching file blobs with session credentials,
 * packaging into a organized ZIP archive using JSZip, and triggering browser downloads.
 */

const browserAPI = (typeof browser !== 'undefined' && browser.runtime) ? browser : chrome;

// Chrome/Brave (MV3 service worker) only loads this single file, so pull in
// the bundled libraries manually. Firefox's event-page background instead
// loads them all upfront via manifest.json's "background.scripts" array, in
// which case `importScripts` doesn't exist and this block is skipped.
const IS_SERVICE_WORKER = typeof importScripts === 'function';

if (IS_SERVICE_WORKER) {
  try {
    importScripts('../lib/jszip.min.js', '../lib/bytesbase64.js');
  } catch (e) {
    console.error('[BB-Downloader] Failed to load bundled libraries:', e);
  }
}

// =========================================================================
// Offscreen document bridge (Chrome/Brave only) - see offscreen/offscreen.js
//
// A service worker's URL.createObjectURL isn't reliably usable by
// chrome.downloads.download, so creating the final downloadable blob: URL
// is delegated to a hidden offscreen document (a real page context) on
// Chrome/Brave. Firefox's background page has no such restriction and
// creates the blob URL directly.
// =========================================================================

let offscreenDocumentReady = false;
let offscreenCreatePromise = null;

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

async function ensureOffscreenDocument() {
  if (!IS_SERVICE_WORKER || offscreenDocumentReady) return;

  if (!offscreenCreatePromise) {
    console.log('[BB-Downloader] Creating offscreen document...');
    offscreenCreatePromise = withTimeout(
      browserAPI.offscreen.createDocument({
        url: 'offscreen/offscreen.html',
        reasons: ['BLOBS'],
        justification: 'Create blob: URLs for chrome.downloads.download, which a service worker cannot do reliably.'
      }),
      15000,
      'offscreen.createDocument()'
    ).catch((e) => {
      // Chrome throws if a document already exists; that's fine, it's usable.
      if (!/already exists|single offscreen/i.test(e.message || '')) {
        throw e;
      }
    });
  }

  try {
    await offscreenCreatePromise;
  } catch (e) {
    offscreenCreatePromise = null; // allow a retry on the next call
    throw e;
  }
  offscreenDocumentReady = true;
  console.log('[BB-Downloader] Offscreen document ready.');
}

async function callOffscreen(action, payload) {
  await ensureOffscreenDocument();
  console.log(`[BB-Downloader] Sending "${action}" to offscreen document...`);
  const response = await withTimeout(
    browserAPI.runtime.sendMessage({ target: 'offscreen', action, ...payload }),
    45000,
    `offscreen "${action}"`
  );
  console.log(`[BB-Downloader] Offscreen "${action}" responded:`, response && response.success);
  if (!response || !response.success) {
    throw new Error((response && response.error) || `Offscreen action "${action}" failed`);
  }
  return response;
}

/**
 * Create a downloadable object URL for a Blob, and a matching revoke
 * function. Delegated to the offscreen document on Chrome/Brave, since
 * URL.createObjectURL from a service worker isn't reliably usable by
 * chrome.downloads.download.
 */
async function createDownloadUrl(blob) {
  if (IS_SERVICE_WORKER) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const base64 = BytesBase64.toBase64(bytes);
    const resp = await callOffscreen('CREATE_BLOB_URL', { data: base64, mimeType: blob.type });
    return {
      url: resp.url,
      revoke: () => callOffscreen('REVOKE_BLOB_URL', { url: resp.url }).catch(() => {})
    };
  }
  const url = URL.createObjectURL(blob);
  return { url, revoke: () => URL.revokeObjectURL(url) };
}

// Global download state tracker
let activeAbortController = null;
let currentDownloadState = {
  status: 'idle', // 'idle' | 'scanning' | 'downloading' | 'zipping' | 'completed' | 'error' | 'cancelled'
  courseTitle: '',
  current: 0,
  total: 0,
  percent: 0,
  message: '',
  currentFile: '',
  failedFiles: [],
  downloadId: null,
  error: null
};

/**
 * Persist current state to storage for popup reconnection
 */
async function updateState(updates) {
  currentDownloadState = { ...currentDownloadState, ...updates };
  try {
    await browserAPI.storage.local.set({ blackboardDownloadState: currentDownloadState });
  } catch (e) {}

  // Broadcast to popup
  try {
    browserAPI.runtime.sendMessage({
      action: 'DOWNLOAD_STATE_CHANGED',
      state: currentDownloadState
    }).catch(() => {});
  } catch (e) {}
}

/**
 * Sanitize filename for local filesystem
 */
function sanitizeFilename(name) {
  if (!name) return 'course_files';
  return name.trim()
    .replace(/[\/\\:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .substring(0, 100);
}

/**
 * Ensure unique filename inside a ZIP folder
 */
function getUniqueZipPath(existingPaths, folder, filename) {
  const cleanFolder = folder ? folder.trim().replace(/^\/+|\/+$/g, '') : '';
  const cleanFile = filename.trim();

  let targetPath = cleanFolder ? `${cleanFolder}/${cleanFile}` : cleanFile;
  if (!existingPaths.has(targetPath)) {
    existingPaths.add(targetPath);
    return targetPath;
  }

  // File with duplicate name in same folder: append (1), (2), etc.
  const dotIndex = cleanFile.lastIndexOf('.');
  const base = dotIndex !== -1 ? cleanFile.substring(0, dotIndex) : cleanFile;
  const ext = dotIndex !== -1 ? cleanFile.substring(dotIndex) : '';

  let counter = 1;
  while (true) {
    const candidateFile = `${base} (${counter})${ext}`;
    const candidatePath = cleanFolder ? `${cleanFolder}/${candidateFile}` : candidateFile;
    if (!existingPaths.has(candidatePath)) {
      existingPaths.add(candidatePath);
      return candidatePath;
    }
    counter++;
  }
}

/**
 * Handle Start Download Request
 */
async function handleStartDownload(tabId, settings = {}) {
  if (activeAbortController) {
    activeAbortController.abort();
  }
  activeAbortController = new AbortController();
  const signal = activeAbortController.signal;

  await updateState({
    status: 'scanning',
    courseTitle: '',
    current: 0,
    total: 0,
    percent: 0,
    message: 'Initializing scan...',
    currentFile: '',
    failedFiles: [],
    error: null
  });

  try {
    // 1. Ensure content script is injected
    try {
      await browserAPI.tabs.sendMessage(tabId, { action: 'DETECT_COURSE' });
    } catch (e) {
      // Inject content script if needed
      await browserAPI.scripting.executeScript({
        target: { tabId },
        files: ['content/content.js']
      });
      // Small delay for script setup
      await new Promise(r => setTimeout(r, 150));
    }

    // 2. Request file scan from content script
    await updateState({ message: 'Discovering course materials & folders...' });

    const scanResult = await browserAPI.tabs.sendMessage(tabId, {
      action: 'SCAN_COURSE_FILES',
      options: settings
    });

    if (signal.aborted) return;

    if (!scanResult || !scanResult.success) {
      throw new Error(scanResult?.error || 'Failed to scan course files.');
    }

    const files = scanResult.files || [];
    const courseInfo = scanResult.courseInfo || {};
    const courseTitle = sanitizeFilename(courseInfo.courseTitle || 'Blackboard_Course');

    if (files.length === 0) {
      await updateState({
        status: 'completed',
        courseTitle,
        total: 0,
        current: 0,
        percent: 100,
        message: 'No downloadable files found in this course.'
      });
      return;
    }

    // 3. Begin Downloading Files
    await updateState({
      status: 'downloading',
      courseTitle,
      total: files.length,
      current: 0,
      percent: 0,
      message: `Found ${files.length} files. Fetching files...`
    });

    const isZipMode = settings.outputMode !== 'individual';

    if (isZipMode) {
      await downloadAsZip(files, courseTitle, signal);
    } else {
      await downloadIndividually(files, courseTitle, signal);
    }

  } catch (err) {
    if (signal.aborted) {
      await updateState({ status: 'cancelled', message: 'Download was cancelled.' });
    } else {
      console.error('[BB-Downloader] Download process error:', err);
      await updateState({
        status: 'error',
        error: err.message || 'An unexpected error occurred during download.'
      });
    }
  } finally {
    activeAbortController = null;
  }
}

/**
 * Package all files into a structured ZIP file
 */
async function downloadAsZip(files, courseTitle, signal) {
  const ZipConstructor = typeof JSZip !== 'undefined' ? JSZip : globalThis.JSZip;
  if (!ZipConstructor) {
    throw new Error('JSZip library is not available in background context.');
  }

  const zip = new ZipConstructor();
  const rootFolder = zip.folder(courseTitle);
  const existingPaths = new Set();
  const failedList = [];

  let completedCount = 0;

  for (let i = 0; i < files.length; i++) {
    if (signal.aborted) return;

    const file = files[i];
    await updateState({
      current: i + 1,
      total: files.length,
      percent: Math.round(((i) / files.length) * 85), // 0-85% for fetching
      message: `Fetching file ${i + 1} of ${files.length}`,
      currentFile: file.filename
    });

    try {
      const response = await fetch(file.url, {
        credentials: 'include',
        redirect: 'follow',
        signal
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      const blob = await response.blob();
      const zipPath = getUniqueZipPath(existingPaths, file.folderPath, file.filename);
      rootFolder.file(zipPath, blob);
      completedCount++;
    } catch (e) {
      if (signal.aborted) return;
      console.warn(`[BB-Downloader] Failed to fetch: ${file.filename} (${file.url})`, e);
      failedList.push({
        filename: file.filename,
        folder: file.folderPath,
        url: file.url,
        error: e.message || 'Network error'
      });
    }
  }

  if (signal.aborted) return;

  // Add a summary report if any files failed
  let summaryText = `Blackboard Course Download Summary\nCourse: ${courseTitle}\nTotal Discovered: ${files.length}\nSuccessfully Downloaded: ${completedCount}\nFailed: ${failedList.length}\n\n`;

  if (failedList.length > 0) {
    summaryText += `Files that could not be downloaded:\n`;
    failedList.forEach((f, idx) => {
      summaryText += `${idx + 1}. [${f.folder || 'Root'}] ${f.filename}\n   URL: ${f.url}\n   Reason: ${f.error}\n\n`;
    });
  } else {
    summaryText += `All files were downloaded successfully!\n`;
  }

  rootFolder.file('_DOWNLOAD_REPORT.txt', summaryText);

  // 4. Generate ZIP archive
  await updateState({
    status: 'zipping',
    percent: 88,
    message: 'Compressing files into ZIP archive...',
    currentFile: ''
  });

  const zipBlob = await rootFolder.generateAsync(
    {
      type: 'blob',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 }
    },
    (metadata) => {
      if (signal.aborted) return;
      const zipPercent = 88 + Math.round((metadata.percent / 100) * 10);
      updateState({
        percent: Math.min(99, zipPercent),
        message: `Compressing files: ${Math.round(metadata.percent)}%`
      });
    }
  );

  if (signal.aborted) return;

  // 5. Trigger browser download
  const { url: blobUrl, revoke: revokeBlobUrl } = await createDownloadUrl(zipBlob);
  const zipFilename = `${courseTitle}_files.zip`;

  const downloadId = await browserAPI.downloads.download({
    url: blobUrl,
    filename: zipFilename,
    saveAs: true
  });

  await updateState({
    status: 'completed',
    current: files.length,
    total: files.length,
    percent: 100,
    downloadId,
    failedFiles: failedList,
    message: failedList.length > 0
      ? `Completed! ${completedCount} downloaded (${failedList.length} skipped).`
      : `Complete! All ${completedCount} files saved to ${zipFilename}`
  });

  // Clean up blob URL after 60 seconds
  setTimeout(() => {
    revokeBlobUrl();
  }, 60000);
}

/**
 * Individual files download mode
 */
async function downloadIndividually(files, courseTitle, signal) {
  let completed = 0;
  const failedList = [];

  for (let i = 0; i < files.length; i++) {
    if (signal.aborted) return;

    const file = files[i];
    await updateState({
      current: i + 1,
      total: files.length,
      percent: Math.round(((i + 1) / files.length) * 100),
      message: `Downloading file ${i + 1} of ${files.length}`,
      currentFile: file.filename
    });

    try {
      const folder = file.folderPath ? `${file.folderPath}/` : '';
      const destPath = `${courseTitle}/${folder}${file.filename}`.replace(/[\/]+/g, '/');

      await browserAPI.downloads.download({
        url: file.url,
        filename: destPath,
        saveAs: false
      });
      completed++;

      // Small delay between downloads to prevent flooding
      await new Promise(r => setTimeout(r, 200));
    } catch (e) {
      if (signal.aborted) return;
      console.warn(`[BB-Downloader] Individual download failed: ${file.filename}`, e);
      failedList.push({ filename: file.filename, error: e.message });
    }
  }

  await updateState({
    status: 'completed',
    current: files.length,
    total: files.length,
    percent: 100,
    failedFiles: failedList,
    message: `Completed! ${completed} files queued for download.`
  });
}

/**
 * Handle Cancel Request
 */
function handleCancelDownload() {
  if (activeAbortController) {
    activeAbortController.abort();
    activeAbortController = null;
  }
  updateState({
    status: 'cancelled',
    message: 'Download was cancelled by user.'
  });
}

// =========================================================================
// Runtime Message Listener
// =========================================================================

browserAPI.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'GET_DOWNLOAD_STATE') {
    sendResponse({ success: true, state: currentDownloadState });
    return true;
  }

  if (message.action === 'START_DOWNLOAD') {
    handleStartDownload(message.tabId, message.settings || {});
    sendResponse({ success: true });
    return true;
  }

  if (message.action === 'CANCEL_DOWNLOAD') {
    handleCancelDownload();
    sendResponse({ success: true });
    return true;
  }

  if (message.action === 'RESET_DOWNLOAD_STATE') {
    updateState({
      status: 'idle',
      courseTitle: '',
      current: 0,
      total: 0,
      percent: 0,
      message: '',
      currentFile: '',
      failedFiles: [],
      error: null
    });
    sendResponse({ success: true });
    return true;
  }

  if (message.action === 'SCAN_PROGRESS') {
    if (message.data) {
      updateState({
        message: message.data.message || 'Scanning course...',
        currentFile: message.data.foundCount ? `Found ${message.data.foundCount} files so far` : ''
      });
    }
  }
});

