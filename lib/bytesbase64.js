/**
 * BytesBase64 - convert between Uint8Array and base64 strings so binary
 * data can cross an extension runtime.sendMessage boundary (JSON only,
 * no structured clone / transferables) between the service worker and the
 * offscreen document.
 */
(function (global) {
  const CHUNK_SIZE = 0x8000;

  function toBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK_SIZE));
    }
    return btoa(binary);
  }

  function fromBase64(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  const target = typeof self !== 'undefined' ? self : this;
  target.BytesBase64 = { toBase64, fromBase64 };
})();
