// ===================================
// CONTENT SCRIPT — Inject injected.js into page MAIN world
// Chạy ở isolated world, cầu nối giữa page và extension background
// ===================================

(function () {
  const PREFIX = '[VEO3-CaptchaExt/Content]';

  function log(...a) { console.log(PREFIX, ...a); }
  function warn(...a) { console.warn(PREFIX, '⚠️', ...a); }
  function error(...a) { console.error(PREFIX, '❌', ...a); }

  log('Initializing...');

  // ── Inject a script into the page MAIN world ─────────────────
  function injectScript(filename) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = chrome.runtime.getURL(filename);
      script.type = 'text/javascript';
      (document.head || document.documentElement).appendChild(script);
      script.onload = () => {
        log(`✅ ${filename} loaded`);
        script.remove();
        resolve();
      };
      script.onerror = () => {
        error(`Failed to load ${filename}`);
        reject(new Error(`Failed to load ${filename}`));
      };
    });
  }

  // Inject socket.io bundle first, then our captcha script
  async function injectAll() {
    try {
      await injectScript('socket.io.min.js'); // must be first — injected.js uses window.io
      await injectScript('injected.js');
    } catch (e) {
      error('Injection failed:', e.message);
    }
  }

  // ── Message relay: page ↔ extension ──────────────────────────
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;

    // Forward settings request from injected.js to background
    if (event.data?.type === 'VEO3_GET_SETTINGS_REQUEST') {
      chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (response) => {
        if (chrome.runtime.lastError) {
          warn('GET_SETTINGS error:', chrome.runtime.lastError.message);
          return;
        }
        window.postMessage({ type: 'VEO3_GET_SETTINGS_RESPONSE', settings: response || {} }, '*');
      });
    }

    // Forward status updates from injected.js to background (optional, for popup)
    if (event.data?.type === 'VEO3_STATUS') {
      try {
        chrome.runtime.sendMessage({ type: 'STATUS_UPDATE', data: event.data.data });
      } catch (_) {}
    }
  });

  // ── Messages from background to content (→ injected.js) ───────
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // Proxy countdown timer updates into page
    if (request.type === 'COUNTDOWN_UPDATE') {
      window.postMessage({
        type: 'VEO3_COUNTDOWN_UPDATE',
        remainingSeconds: request.remainingSeconds,
        totalSeconds: request.totalSeconds,
      }, '*');
    }

    // Handle page info request
    if (request.type === 'GET_PAGE_INFO') {
      sendResponse({ url: window.location.href, title: document.title });
    }
  });

  // ── Inject when DOM is ready ──────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectAll);
  } else {
    injectAll();
  }

  log('✅ Content script ready');
})();
