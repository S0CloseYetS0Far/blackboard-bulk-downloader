/**
 * Offscreen document (Chrome/Brave only). A service worker's
 * URL.createObjectURL isn't reliably usable by chrome.downloads.download,
 * so creating (and later revoking) the final downloadable blob: URL is
 * delegated to this hidden real page instead.
 */
const browserAPI = (typeof browser !== 'undefined' && browser.runtime) ? browser : chrome;

browserAPI.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== 'offscreen') return false;

  if (message.action === 'CREATE_BLOB_URL') {
    try {
      const bytes = BytesBase64.fromBase64(message.data);
      const blob = new Blob([bytes], { type: message.mimeType || 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      sendResponse({ success: true, url });
    } catch (e) {
      sendResponse({ success: false, error: e.message || String(e) });
    }
    return true;
  }

  if (message.action === 'REVOKE_BLOB_URL') {
    try {
      URL.revokeObjectURL(message.url);
    } catch (e) {}
    sendResponse({ success: true });
    return true;
  }

  return false;
});
