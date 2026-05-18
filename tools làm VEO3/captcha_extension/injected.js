// ===================================
// INJECTED SCRIPT — Runs in PAGE MAIN world
// Has direct access to window.grecaptcha.enterprise
// Connects to captcha_server.js via Socket.IO
// ===================================

(async function () {
  const PREFIX = '[VEO3-CaptchaExt/Injected]';
  const SITE_KEY = '6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV';
  const FALLBACK_SERVER_URL = 'http://127.0.0.1:3456';

  function log(...a) { console.log(PREFIX, ...a); }
  function warn(...a) { console.warn(PREFIX, '⚠️', ...a); }
  function err(...a) { console.error(PREFIX, '❌', ...a); }
  function ok(...a) { console.log(PREFIX, '✅', ...a); }

  log('Starting...');

  // ── Countdown badge (shows proxy rotation timer) ─────────────
  function injectCountdownStyles() {
    const style = document.createElement('style');
    style.textContent = `
      #veo3-captcha-badge {
        position: fixed; bottom: 24px; right: 24px; min-width: 140px;
        height: 76px; border-radius: 12px;
        background: linear-gradient(135deg, #5b7cfa 0%, #748ffc 100%);
        display: flex; flex-direction: column; align-items: center;
        justify-content: center; color: white; z-index: 999999;
        font-family: -apple-system, 'Segoe UI', Roboto, sans-serif;
        box-shadow: 0 8px 24px rgba(91,124,250,0.4);
        transition: all .3s ease; padding: 12px 16px; gap: 4px;
        border: 1px solid rgba(255,255,255,0.2);
        backdrop-filter: blur(8px); cursor: default;
      }
      #veo3-captcha-badge.hidden { display: none; }
      #veo3-captcha-badge:hover { transform: translateY(-2px); }
      #veo3-captcha-badge-label { font-size: 10px; font-weight: 600;
        text-transform: uppercase; letter-spacing: .8px; opacity: .85; }
      #veo3-captcha-badge-time  { font-size: 32px; font-weight: 700;
        line-height: 1; font-variant-numeric: tabular-nums; letter-spacing: -1px; }
      #veo3-captcha-badge.warn  { background: linear-gradient(135deg,#ffa500,#ff8c00); }
      #veo3-captcha-badge.danger{ background: linear-gradient(135deg,#ff4757,#ff3838); }
    `;
    document.head.appendChild(style);
  }

  function createBadge() {
    if (document.getElementById('veo3-captcha-badge')) return;
    const badge = document.createElement('div');
    badge.id = 'veo3-captcha-badge';
    badge.className = 'hidden';
    badge.innerHTML = `
      <div id="veo3-captcha-badge-label">Reload in</div>
      <div id="veo3-captcha-badge-time">--</div>
    `;
    document.body?.appendChild(badge);
  }

  function updateBadge(remaining, total) {
    const badge = document.getElementById('veo3-captcha-badge');
    if (!badge) return;
    if (remaining <= 0) { badge.className = 'hidden'; return; }
    badge.className = '';
    const pct = remaining / total;
    badge.classList.toggle('warn', pct <= 0.6 && pct > 0.3);
    badge.classList.toggle('danger', pct <= 0.3);
    document.getElementById('veo3-captcha-badge-time').textContent =
      String(Math.max(0, remaining)).padStart(2, '0') + 's';
  }

  // ── Socket.IO is pre-injected by content.js (socket.io.min.js) ─
  // window.io is already available — no dynamic loading needed
  function getSocketIO() {
    if (!window.io) throw new Error('Socket.IO not loaded — check content.js injection order');
    return window.io;
  }

  // ── Wait for reCAPTCHA Enterprise to load ─────────────────────
  async function waitForRecaptcha(maxWaitMs = 30000) {
    log('Waiting for grecaptcha.enterprise...');
    const step = 300;
    for (let elapsed = 0; elapsed < maxWaitMs; elapsed += step) {
      if (window.grecaptcha?.enterprise?.execute) {
        ok('grecaptcha.enterprise ready');
        return;
      }
      await sleep(step);
    }
    throw new Error('reCAPTCHA Enterprise not available after 30s');
  }

  // ── Generate a reCAPTCHA token ────────────────────────────────
  async function solveRecaptcha(action = 'IMAGE_GENERATION') {
    log(`Solving reCAPTCHA (action: ${action})...`);
    const token = await window.grecaptcha.enterprise.execute(SITE_KEY, { action });
    ok(`Token obtained (${token.length} chars)`);

    // Optionally clear localStorage cache so next call gets a fresh score
    try { localStorage.removeItem('_grecaptcha'); } catch (_) { }

    return token;
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ── Main ──────────────────────────────────────────────────────
  try {
    injectCountdownStyles();
    // Badge is appended after body exists
    if (document.body) createBadge();
    else document.addEventListener('DOMContentLoaded', createBadge);

    // Listen for countdown updates from content.js
    window.addEventListener('message', (e) => {
      if (e.source !== window) return;
      if (e.data?.type === 'VEO3_COUNTDOWN_UPDATE') {
        updateBadge(e.data.remainingSeconds, e.data.totalSeconds);
      }
    });

    // Fetch server URL from extension background settings
    function getSettings() {
      return new Promise(resolve => {
        const timer = setTimeout(() => resolve({ serverUrl: FALLBACK_SERVER_URL }), 2000);
        const handler = (e) => {
          if (e.source !== window || e.data?.type !== 'VEO3_GET_SETTINGS_RESPONSE') return;
          clearTimeout(timer);
          window.removeEventListener('message', handler);
          resolve(e.data.settings || {});
        };
        window.addEventListener('message', handler);
        window.postMessage({ type: 'VEO3_GET_SETTINGS_REQUEST' }, '*');
      });
    }

    // Get server URL from background settings
    const settings = await getSettings();
    const SERVER_URL = settings.serverUrl || FALLBACK_SERVER_URL;
    log(`Server URL: ${SERVER_URL}`);

    // Get Socket.IO (pre-loaded by content.js before this script ran)
    const io = getSocketIO();
    ok('Socket.IO ready');

    // Connect to captcha server
    const socket = io(SERVER_URL, {
      transports: ['websocket', 'polling'],
      autoConnect: true,
      reconnection: true,
      reconnectionDelay: 2000,
      reconnectionAttempts: Infinity,
    });

    socket.on('connect', () => {
      ok(`Connected (socket: ${socket.id})`);
      // Detect browser type so the server can route requests correctly.
      // Headless Brave: navigator.webdriver=true OR UA contains "HeadlessChrome"
      const ua = navigator.userAgent || '';
      const isHeadless = navigator.webdriver === true || ua.includes('HeadlessChrome');
      const browserType = isHeadless ? 'brave' : 'chrome';
      socket.emit('client:ready', { timestamp: new Date().toISOString(), browserType });
    });

    socket.on('disconnect', (reason) => {
      warn(`Disconnected: ${reason}`);
    });

    socket.on('connect_error', (e) => {
      warn(`Connection error: ${e.message} — retrying...`);
    });

    // ── Handle captcha request from server ──────────────────────
    socket.on('server:request-captcha', async (data) => {
      log('Received captcha request:', data);
      const action = data?.action || 'IMAGE_GENERATION';

      try {
        await waitForRecaptcha(20000);
        const token = await solveRecaptcha(action);

        socket.emit('client:captcha-solved', {
          requestId: data?.requestId,
          token,
          timestamp: new Date().toISOString(),
        });

        log(`Token sent to server for requestId: ${data?.requestId}`);
      } catch (e) {
        let errorMsg = 'Lỗi reCAPTCHA không xác định';
        if (e) {
          if (typeof e === 'string') errorMsg = e;
          else if (e.message) errorMsg = e.message;
          else if (e.error?.message) errorMsg = e.error.message;
          else if (e.details) errorMsg = typeof e.details === 'string' ? e.details : JSON.stringify(e.details);
          else errorMsg = JSON.stringify(e);
        }

        err('Failed to solve captcha:', errorMsg);
        socket.emit('client:captcha-error', {
          requestId: data?.requestId,
          error: errorMsg,
          timestamp: new Date().toISOString(),
        });
      }
    });

    // ── Handle server asking to reload page ─────────────────────
    socket.on('server:reload-page', (data) => {
      warn('Server requested page reload');
      try { localStorage.removeItem('_grecaptcha'); } catch (_) { }
      const delay = data?.delay || 0;
      if (delay > 0) setTimeout(() => window.location.reload(), delay);
      else window.location.reload();
    });

    // ── Wait for recaptcha on first load, log status ─────────────
    await waitForRecaptcha().catch(e => warn('Initial recaptcha wait failed:', e.message));

    // Expose manual controls for debugging in browser console
    window.veo3CaptchaSolver = {
      socket,
      solve: () => solveRecaptcha(),
      solveAndSend: async () => {
        const token = await solveRecaptcha();
        socket.emit('client:captcha-manual', { token, timestamp: new Date().toISOString() });
        return token;
      },
      reload: (delay = 0) => {
        try { localStorage.removeItem('_grecaptcha'); } catch (_) { }
        delay > 0 ? setTimeout(() => window.location.reload(), delay) : window.location.reload();
      },
    };

    ok('Captcha solver ready. Commands: veo3CaptchaSolver.solve() / .solveAndSend() / .reload()');

  } catch (e) {
    err('Initialization failed:', e.message);
  }
})();
