// popup.js — VEO3 Captcha Solver popup logic
// Must be a separate file; MV3 CSP blocks inline <script> in extension HTML pages.

// Server URL is read from extension settings (background.js DEFAULT_SETTINGS → chrome.storage.local)
let SERVER = 'http://127.0.0.1:3456'; // fallback until settings load

// Load server URL from background settings
chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (response) => {
  if (chrome.runtime.lastError || !response?.serverUrl) return;
  SERVER = response.serverUrl;
  // Update footer to show actual URL
  const footer = document.querySelector('.footer');
  if (footer) {
    const url = new URL(SERVER);
    footer.textContent = `labs.google/fx/vi/tools/flow → port ${url.port || 80}`;
  }
  checkHealth();
});

function setStatus(dotId, statusId, color, text) {
  const dot = document.getElementById(dotId);
  const el  = document.getElementById(statusId);
  if (dot) { dot.className = ''; dot.classList.add('dot'); if (color) dot.classList.add(color); }
  if (el)  el.textContent = text;
}

// Check server health
async function checkHealth() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const r = await fetch(`${SERVER}/health`, { signal: controller.signal });
    clearTimeout(timer);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    const n = d.connectedClients ?? 0;
    setStatus('server-dot', 'server-status', 'green',
      n > 0 ? `${n} client(s)` : '0 clients — open Chrome!');
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') {
      setStatus('server-dot', 'server-status', 'yellow', 'Timeout');
    } else {
      setStatus('server-dot', 'server-status', 'red', 'Not running');
    }
  }
}

// Check if active tab is on labs.google
function checkPage() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (chrome.runtime.lastError) {
      setStatus('page-dot', 'page-status', 'yellow', 'No tab access');
      return;
    }
    const tab = tabs && tabs[0];
    if (!tab) {
      setStatus('page-dot', 'page-status', 'yellow', 'No active tab');
      return;
    }
    if (tab.url && tab.url.includes('labs.google')) {
      setStatus('page-dot', 'page-status', 'green', '✅ labs.google');
    } else {
      setStatus('page-dot', 'page-status', 'yellow', 'Open labs.google!');
    }
  });
}

// Test button — request a real captcha token
document.getElementById('btn-test').addEventListener('click', async () => {
  const btn = document.getElementById('btn-test');
  btn.textContent = '⏳ Solving...';
  btn.disabled = true;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 35000);
  try {
    const r = await fetch(`${SERVER}/captcha?action=IMAGE_GENERATION`,
      { signal: controller.signal });
    clearTimeout(timer);
    const d = await r.json();
    if (d.captcha) {
      btn.textContent = `✅ ${d.captcha.length} chars`;
    } else {
      btn.textContent = `❌ ${d.error || 'No token'}`;
    }
  } catch (e) {
    clearTimeout(timer);
    btn.textContent = e.name === 'AbortError' ? '❌ Timeout (30s)' : `❌ ${e.message.substring(0, 28)}`;
  } finally {
    btn.disabled = false;
    setTimeout(() => { btn.textContent = '🧪 Test Captcha'; }, 4000);
  }
});

// Force refresh button — tell all browser clients to reload
document.getElementById('btn-refresh').addEventListener('click', async () => {
  try {
    await fetch(`${SERVER}/force-refresh`, { method: 'POST' });
    document.getElementById('btn-refresh').textContent = '✅ Refreshed';
    setTimeout(() => { document.getElementById('btn-refresh').textContent = '🔄 Force Refresh'; }, 2000);
  } catch (e) {}
});

// Init
checkHealth();
checkPage();
setInterval(checkHealth, 3000);
setInterval(checkPage,  5000);
