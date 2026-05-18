// ===================================
// BACKGROUND SERVICE WORKER
// Manages extension settings, relays messages
// ===================================

const DEFAULT_SETTINGS = {
  serverUrl: 'http://127.0.0.1:3456',
  clearGrecaptcha: false,
};

// Keep settings in memory (chrome.storage.local for persistence)
let currentSettings = { ...DEFAULT_SETTINGS };

// Load persisted settings on startup
chrome.storage.local.get('settings', (result) => {
  if (result.settings) {
    currentSettings = { ...DEFAULT_SETTINGS, ...result.settings };

    // ── Migration: fix stale localhost -> 127.0.0.1 ────────────
    if (currentSettings.serverUrl && currentSettings.serverUrl.includes('localhost')) {
      currentSettings.serverUrl = currentSettings.serverUrl.replace('localhost', '127.0.0.1');
      chrome.storage.local.set({ settings: currentSettings });
      console.log('[VEO3-BG] Migrated serverUrl localhost → 127.0.0.1');
    }

    // ── Migration: fix stale port 3000/3001 → 3456 ─────────────
    if (currentSettings.serverUrl && (currentSettings.serverUrl.includes(':3000') || currentSettings.serverUrl.includes(':3001'))) {
      currentSettings.serverUrl = currentSettings.serverUrl.replace(/:300[01]/, ':3456');
      chrome.storage.local.set({ settings: currentSettings });
      console.log('[VEO3-BG] Migrated serverUrl port → 3456');
    }

    console.log('[VEO3-BG] Loaded settings:', currentSettings);
  }
});

// Handle messages from content scripts
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'GET_SETTINGS') {
    // Runtime safety: always enforce correct port
    if (currentSettings.serverUrl && !currentSettings.serverUrl.includes(':3456')) {
      currentSettings.serverUrl = 'http://127.0.0.1:3456';
      chrome.storage.local.set({ settings: currentSettings });
    }
    sendResponse(currentSettings);
    return true;
  }

  if (request.type === 'SAVE_SETTINGS') {
    currentSettings = { ...DEFAULT_SETTINGS, ...request.settings };
    chrome.storage.local.set({ settings: currentSettings });
    sendResponse({ ok: true });
    return true;
  }

  if (request.type === 'STATUS_UPDATE') {
    // Could update popup badge here
    return false;
  }
});
