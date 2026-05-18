/**
 * ═══════════════════════════════════════════════════════════════════
 *  TOKEN MANAGER — Persistent Brave Browser + Auto-Refresh OAuth
 * ═══════════════════════════════════════════════════════════════════
 *
 *  Keeps a Brave browser instance running in the background,
 *  automatically refreshes Google OAuth tokens before they expire
 *  (~50 min intervals), and exposes getToken() / refreshToken()
 *  for other modules (e.g. hybrid API) to consume.
 *
 *  Usage:
 *    const TokenManager = require('./token_manager');
 *    const tm = new TokenManager();
 *    await tm.initialize();
 *    const token = await tm.getToken();
 *    // ... later ...
 *    await tm.shutdown();
 *
 * ═══════════════════════════════════════════════════════════════════
 */

const { addExtra } = require('puppeteer-extra');
const puppeteerCore = require('puppeteer-core');
const puppeteer = addExtra(puppeteerCore);
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const EventEmitter = require('events');


// Path to the captcha extension (loaded into Puppeteer's browser)
// In production, we use extraFiles to place it next to the .exe for easy access by users.
const CAPTCHA_EXTENSION_PATH = __dirname.includes('app.asar')
    ? path.join(__dirname, '..', '..', 'captcha_extension')
    : path.join(__dirname, 'captcha_extension');

const DEFAULT_CONFIG = {
    // Brave browser executable
    // In packaged Electron app, asarUnpack files live under app.asar.unpacked
    bravePath: process.env.BRAVE_PATH
        || path.join(__dirname, 'brave', 'brave.exe').replace('app.asar', 'app.asar.unpacked'),

    // Cookie file path (reuses the existing Veo3 cookie system)
    cookieFile: path.join(os.homedir(), 'Veo3Data', 'cookies.json'),

    // ── Option A: Cookie Pool ─────────────────────────────────────────
    // DYNAMIC — the pool is discovered at runtime by scanning userDataDir
    // for cookies_slot*.json files. No hardcoded list needed.
    // Rebuilt at startup via _rebuildCookiePool() and on every slot change.
    cookiePool: [], // populated dynamically at runtime

    // Cookie expiry — Google sessions expire after ~18 hours
    cookieExpiryMs: 18 * 60 * 60 * 1000,


    // Browser profile for persistent sessions
    userDataDir: path.join(os.homedir(), 'Veo3Data', '.brave-profile'),

    // Target URL for token extraction
    targetUrl: 'https://labs.google/fx/vi/tools/flow/',

    // API key used by Google Labs frontend
    apiKey: 'AIzaSyBtrm0o5ab1c-Ec8ZuLcGt3oJAA5VWt3pY',

    // Token persistence file
    tokenFile: path.join(os.homedir(), 'Veo3Data', '.token_manager.json'),

    // Auto-refresh interval (ms) — 50 minutes (tokens expire at ~60 min)
    refreshIntervalMs: 50 * 60 * 1000,

    // Timeout for token capture during a single refresh attempt (ms)
    tokenCaptureTimeout: 30000,

    // Run browser headless (invisible) — set false if Google blocks headless
    headless: false,

    // ── Option G: Proxy Rotation (STANDBY — disabled by default) ──────
    // Set proxy.enabled = true and populate proxy.list to activate.
    // Each entry: { host, port, username, password } (HTTP/SOCKS5)
    proxy: {
        enabled: false,
        mode: 'roundrobin',   // 'roundrobin' | 'random'
        list: [],
        _activeIndex: 0,
    },
};

// ─── Logging ────────────────────────────────────────────────────────
function _log(msg, level = 'info') {
    const ts = new Date().toLocaleTimeString('vi-VN');
    const prefix = {
        info: '  ',
        success: '✅',
        warn: '⚠️ ',
        error: '❌',
        debug: '🔍',
    }[level] || '  ';
    console.log(`[${ts}] [TokenManager] ${prefix} ${msg}`);
}

// ═══════════════════════════════════════════════════════════════════
//  HWID + Decryption helpers (mirrors auth.js / debug_token.js)
// ═══════════════════════════════════════════════════════════════════

function _getHWID() {
    const hwidFile = path.join(os.homedir(), 'Veo3Data', '.hwid');
    try {
        if (fs.existsSync(hwidFile)) {
            const cached = fs.readFileSync(hwidFile, 'utf-8').trim();
            if (cached && /^[a-f0-9]{32}$/i.test(cached)) return cached;
        }
    } catch (e) { }

    let raw = os.hostname() + '|' + os.platform() + '|' + os.arch();
    const cpus = os.cpus();
    if (cpus && cpus.length > 0) raw += '|' + cpus[0].model;

    let osUuid = '';
    try {
        const { execSync } = require('child_process');
        if (os.platform() === 'win32') {
            const output = execSync(
                'REG QUERY HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography /v MachineGuid',
                { encoding: 'utf8', stdio: 'pipe' }
            );
            const match = output.match(/[a-f0-9]{8}-([a-f0-9]{4}-){3}[a-f0-9]{12}/i);
            if (match) osUuid = match[0];
        }
    } catch (e) { }

    if (osUuid) {
        raw += '|' + osUuid;
    } else {
        const networkInterfaces = os.networkInterfaces();
        let macs = [];
        for (const iface of Object.values(networkInterfaces)) {
            for (const info of iface) {
                if (!info.internal && info.mac && info.mac !== '00:00:00:00:00:00') {
                    macs.push(info.mac);
                }
            }
        }
        if (macs.length > 0) {
            macs.sort();
            raw += '|' + macs[0];
        }
    }

    const hwid = crypto.createHash('sha256').update(raw).digest('hex').substring(0, 32);
    try { fs.writeFileSync(hwidFile, hwid, 'utf-8'); } catch (e) { }
    return hwid;
}

function _decryptData(encryptedText, hwid) {
    try {
        if (!encryptedText || !encryptedText.includes(':')) return null;
        const parts = encryptedText.split(':');
        if (parts.length < 2) return null;
        const iv = Buffer.from(parts[0], 'hex');
        const encrypted = parts.slice(1).join(':');
        const key = crypto.createHash('sha256').update(hwid).digest();
        const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
        let decrypted = decipher.update(encrypted, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (e) {
        return null;
    }
}

function _parseCookies(cookies) {
    let parsed = [];
    if (typeof cookies === 'string') {
        cookies = cookies.trim();
        if (cookies.startsWith('[')) {
            try {
                const jsonCookies = JSON.parse(cookies);
                parsed = jsonCookies.map(c => ({
                    name: c.name,
                    value: c.value,
                    domain: c.domain || '.google.com',
                    path: c.path || '/',
                    httpOnly: c.httpOnly || false,
                    secure: c.secure !== false,
                    sameSite: c.sameSite || 'Lax',
                }));
            } catch (e) {
                return [];
            }
        } else {
            parsed = cookies.split(/[;\n]/)
                .map(s => s.trim())
                .filter(s => s && s.includes('='))
                .map(s => {
                    const eq = s.indexOf('=');
                    return {
                        name: s.substring(0, eq).trim(),
                        value: s.substring(eq + 1).trim(),
                        domain: '.google.com',
                        path: '/',
                        httpOnly: false,
                        secure: true,
                        sameSite: 'Lax',
                    };
                })
                .filter(c => c.name && c.value);
        }
    } else if (Array.isArray(cookies)) {
        parsed = cookies;
    }
    return parsed;
}

function _loadCookies(cookieFile) {
    try {
        if (!fs.existsSync(cookieFile)) {
            _log(`Cookie file not found: ${cookieFile}`, 'warn');
            return null;
        }
        const raw = fs.readFileSync(cookieFile, 'utf-8').trim();
        if (!raw || raw.length < 10) {
            _log('Cookie file is empty or too short', 'warn');
            return null;
        }

        // Try 1: Direct parse
        let cookies = _parseCookies(raw);
        if (cookies.length > 0) return cookies;

        // Try 2: Decrypt with HWID
        const hwid = _getHWID();
        const decrypted = _decryptData(raw, hwid);
        if (decrypted) {
            cookies = _parseCookies(decrypted);
            if (cookies.length > 0) {
                _log(`Decrypted & parsed ${cookies.length} cookies`, 'success');
                return cookies;
            }
        }

        _log('No valid cookies parsed from file', 'error');
        return null;
    } catch (e) {
        _log(`Error reading cookie file: ${e.message}`, 'error');
        return null;
    }
}

// ─── Token Validation ───────────────────────────────────────────────
function _validateToken(token, apiKey) {
    return new Promise((resolve) => {
        const url = `https://aisandbox-pa.googleapis.com/v1/credits?key=${apiKey}`;
        const parsed = new URL(url);

        const options = {
            hostname: parsed.hostname,
            port: 443,
            path: parsed.pathname + parsed.search,
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': '*/*',
                'Referer': 'https://labs.google/',
                'sec-ch-ua': '"Chromium";v="147"',
                'sec-ch-ua-mobile': '?0',
                'sec-ch-ua-platform': '"Windows"',
            },
            timeout: 10000,
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    resolve({
                        status: res.statusCode,
                        data: json,
                        valid: res.statusCode >= 200 && res.statusCode < 300,
                    });
                } catch {
                    resolve({ status: res.statusCode, data, valid: false });
                }
            });
        });

        req.on('error', (e) => resolve({ status: 0, data: e.message, valid: false }));
        req.on('timeout', () => { req.destroy(); resolve({ status: 0, data: 'Timeout', valid: false }); });
        req.end();
    });
}


// ═══════════════════════════════════════════════════════════════════
//  TokenManager Class
// ═══════════════════════════════════════════════════════════════════

class TokenManager extends EventEmitter {
    /**
     * @param {Partial<typeof DEFAULT_CONFIG>} options
     */
    constructor(options = {}) {
        super();
        this.config = { ...DEFAULT_CONFIG, ...options };

        // State
        this._browser = null;
        this._page = null;
        this._cdp = null;
        this._token = null;
        this._tokenCapturedAt = null;   // Date when current token was captured
        this._refreshTimer = null;      // setInterval handle
        this._refreshMutex = Promise.resolve(); // concurrency guard
        this._initialized = false;
        this._shuttingDown = false;
        this._recaptchaCallCount = 0;   // tracks calls to rotate page every N calls

        // ── Option H: Token Warm-up state ────────────────────────────────
        this._warmupToken = null;         // { token, solvedAt } pre-solved token cache
        this._warmupPending = false;      // guard: only one background solve at a time
        this._warmupTimer = null;         // setTimeout handle for scheduled warmup

        // ── Option A: Cookie Pool state ───────────────────────────────────
        this._activeAccountIndex = 0;     // which slot is currently active
        this._accountSwitchCount = 0;     // total switches this session
        this._slotIndexMap = {};          // { slotIndex: filePath } — built by _rebuildCookiePool
        this._poolMeta = { slots: {} };   // saved-at / expiry metadata per slot

        // Try to load persisted token from disk (crash recovery)
        this._loadPersistedToken();
    }

    // ─── Public API ─────────────────────────────────────────────────

    /**
     * Launch Brave, inject cookies, capture the first token,
     * and start the auto-refresh timer.
     */
    async initialize() {
        if (this._initialized) {
            _log('Already initialized', 'warn');
            return;
        }

        _log('Initializing TokenManager...', 'info');

        // 0. Discover cookie pool slots on disk
        this._rebuildCookiePool();

        // 1. Check prerequisites
        if (!fs.existsSync(this.config.bravePath)) {
            throw new Error(`Brave browser not found at: ${this.config.bravePath}`);
        }

        // 2. Launch browser
        await this._launchBrowser();

        // 3. First token capture
        await this._captureToken();

        if (this._token) {
            _log(`Token acquired (${this._token.length} chars)`, 'success');
        } else {
            _log('Initial token capture failed — will retry on next refresh cycle', 'warn');
        }

        // 5. Start auto-refresh timer
        this._startRefreshTimer();

        this._initialized = true;
        _log(`Auto-refresh every ${Math.round(this.config.refreshIntervalMs / 60000)} minutes`, 'info');
        _log('TokenManager ready', 'success');
    }

    /**
     * Get the current valid token. If a refresh is in-flight, waits for it.
     * If no token is available, triggers an immediate refresh.
     * @returns {Promise<string|null>}
     */
    async getToken() {
        // Wait for any in-flight refresh
        await this._refreshMutex;

        // If we have a token, return it
        if (this._token) return this._token;

        // No token available — try a refresh
        _log('No cached token — triggering refresh...', 'warn');
        return this.refreshToken();
    }

    /**
     * Force-refresh the token immediately (e.g. if a 401 was received).
     * Safe to call concurrently — only one refresh runs at a time.
     * @returns {Promise<string|null>}
     */
    async refreshToken() {
        // Chain onto the mutex so concurrent calls wait
        const refreshPromise = this._refreshMutex.then(async () => {
            _log('Refreshing token...', 'info');
            try {
                // Ensure browser is alive
                if (!this._browser || !this._page) {
                    _log('Browser not running — relaunching...', 'warn');
                    await this._launchBrowser();
                }

                await this._captureToken();

                if (this._token) {
                    _log(`Token refreshed (${this._token.length} chars)`, 'success');
                    this.emit('token:refreshed', this._token);
                } else {
                    _log('Token refresh failed — no token captured', 'error');
                    this.emit('token:error', new Error('Token capture failed'));
                }

                return this._token;
            } catch (err) {
                _log(`Token refresh error: ${err.message}`, 'error');
                this.emit('token:error', err);
                return this._token; // return stale token if available
            }
        });

        this._refreshMutex = refreshPromise.catch(() => { }); // prevent unhandled rejection chain
        return refreshPromise;
    }

    /**
     * Generate a reCAPTCHA Enterprise token.
     * Option H: Checks the pre-solved warm-up cache first for zero latency.
     * Falls back to live solve if cache is missing or stale (>100s old).
     *
     * @param {string} [action='generate']
     * @returns {Promise<string|null>}
     */
    async getRecaptchaToken(action = 'generate') {
        if (!this._page) {
            _log('Cannot get recaptcha token — no browser page', 'error');
            return null;
        }

        // ── Option H: Consume pre-solved warm-up token if fresh ──────────
        const WARMUP_TTL_MS = 100_000; // 100s — safe margin inside 2min Google TTL
        if (this._warmupToken && (Date.now() - this._warmupToken.solvedAt) < WARMUP_TTL_MS) {
            const cached = this._warmupToken.token;
            this._warmupToken = null; // consume
            this._recaptchaCallCount = (this._recaptchaCallCount || 0) + 1;
            this._recaptchaTotalCount = (this._recaptchaTotalCount || 0) + 1;
            _log(`[Warmup] ⚡ Consumed pre-solved token #${this._recaptchaTotalCount} (${cached.length} chars)`, 'success');
            // Schedule next warmup in the background
            this._scheduleWarmup(action);
            this.emit('recaptcha:warmup-consumed', { total: this._recaptchaTotalCount });
            return cached;
        }

        // ── Rate limit constants — tuned per captcha mode ────────────────
        // real_chrome: Real Chrome session scores 0.7–0.9 → no need to rotate aggressively
        // auto (headless Brave): Fingerprint is static per session, not per call.
        //   Score doesn't degrade with call count, so heavy rotation is wasteful.
        const isRealChromeMode = (process.env.CAPTCHA_MODE === 'real_chrome');

        const MAX_CALLS_PER_ACCOUNT = isRealChromeMode ? 100 : 20;
        const ACCOUNT_COOLDOWN_MS = isRealChromeMode ? 0 : 30_000;  // real Chrome: no cooldown
        const MAX_CALLS_PER_SESSION = isRealChromeMode ? 50 : 5;      // headless: rotate every 5 (was 2)
        const MIN_GAP_MS = isRealChromeMode ? 0 : 2000;     // headless: 2s gap (was 3s)

        this._recaptchaTotalCount = (this._recaptchaTotalCount || 0);

        // ── Account-level rate limit ──────────────────────────────────────
        if (ACCOUNT_COOLDOWN_MS > 0) {
            if (this._recaptchaTotalCount === 0) {
                this._accountBatchStartAt = Date.now();
            } else if (this._recaptchaTotalCount % MAX_CALLS_PER_ACCOUNT === 0) {
                const elapsed = Date.now() - (this._accountBatchStartAt || 0);
                const remaining = ACCOUNT_COOLDOWN_MS - elapsed;
                if (remaining > 0) {
                    _log(`Account-level reCAPTCHA limit (${this._recaptchaTotalCount} total) — waiting ${Math.ceil(remaining / 1000)}s more...`, 'warn');
                    await new Promise(r => setTimeout(r, remaining));
                } else {
                    _log(`Account-level limit — window already elapsed (${Math.round(elapsed / 1000)}s)`, 'debug');
                }
                this._accountBatchStartAt = Date.now();
            }
        }

        // ── Proactive session rotation ────────────────────────────────────
        const isRotationDue = this._recaptchaCallCount > 0 &&
            this._recaptchaCallCount % MAX_CALLS_PER_SESSION === 0;

        if (isRotationDue) {
            await this._rotateRecaptchaSession(`proactive — session call #${this._recaptchaCallCount}`);
        }

        // ── Intra-session rate-limit ──────────────────────────────────────
        const now = Date.now();
        const gap = now - (this._lastRecaptchaAt || 0);
        if (!isRotationDue && MIN_GAP_MS > 0 && gap < MIN_GAP_MS) {
            await new Promise(r => setTimeout(r, MIN_GAP_MS - gap));
        }
        this._lastRecaptchaAt = Date.now();


        // ── Execute (with one reactive-retry on failure) ──────────────────
        const token = await this._executeRecaptcha(action);

        if (token) {
            this._recaptchaCallCount++;
            this._recaptchaTotalCount++;
            _log(`reCAPTCHA token #${this._recaptchaCallCount} (session) / #${this._recaptchaTotalCount} (total) — ${token.length} chars`, 'debug');
            // Schedule warmup now that we have an active session
            this._scheduleWarmup(action);
            return token;
        }

        // execute() returned null — session exhausted. Reload and retry.
        _log('reCAPTCHA null — rotating session and retrying...', 'warn');
        await this._rotateRecaptchaSession('reactive — execute() returned null');
        const retryToken = await this._executeRecaptcha(action);

        if (retryToken) {
            this._recaptchaCallCount++;
            this._recaptchaTotalCount++;
            _log(`reCAPTCHA retry succeeded (${retryToken.length} chars)`, 'success');
            this._scheduleWarmup(action);
        } else {
            _log('reCAPTCHA retry also failed — account may be rate-limited', 'error');
        }

        return retryToken;
    }

    // ─── Option H: Token Warm-up ────────────────────────────────────

    /**
     * Schedule a background token pre-solve.
     * Fires 90s after call (stays well within the 2min Google TTL).
     * Clears any pending warmup timer first to avoid stacking.
     * @private
     */
    _scheduleWarmup(action = 'generate') {
        if (this._warmupPending) return; // already one in flight
        if (this._warmupTimer) clearTimeout(this._warmupTimer);

        const WARMUP_DELAY_MS = 90_000; // 90s after last token use
        this._warmupTimer = setTimeout(async () => {
            if (this._shuttingDown || !this._page) return;
            this._warmupPending = true;
            try {
                _log('[Warmup] Pre-solving next reCAPTCHA token in background...', 'debug');
                const tok = await this._executeRecaptcha(action);
                if (tok) {
                    this._warmupToken = { token: tok, solvedAt: Date.now() };
                    _log(`[Warmup] ✅ Token cached (${tok.length} chars) — ready for next generation`, 'debug');
                    this.emit('recaptcha:warmup-ready');
                } else {
                    _log('[Warmup] Pre-solve returned null — will solve fresh on demand', 'warn');
                }
            } catch (e) {
                _log(`[Warmup] Error: ${e.message}`, 'warn');
            }
            this._warmupPending = false;
        }, WARMUP_DELAY_MS);
    }

    /** Discard any cached warmup token (e.g. after session rotation). */
    clearWarmup() {
        this._warmupToken = null;
        this._warmupPending = false;
        if (this._warmupTimer) { clearTimeout(this._warmupTimer); this._warmupTimer = null; }
        _log('[Warmup] Cache cleared', 'debug');
    }

    // ─── Option A: Cookie Pool / Account Switching ───────────────────

    /**
     * Rebuild cookiePool by scanning userDataDir for cookies_slot*.json files.
     * Also reads cookie_pool_meta.json to load expiry timestamps.
     * Called at startup and whenever a slot is added/removed.
     */
    _rebuildCookiePool() {
        const dir = this.config.userDataDir;
        let files = [];
        try {
            files = fs.readdirSync(dir)
                .filter(f => /^cookies_slot(\d+)\.json$/.test(f))
                .map(f => ({
                    index: parseInt(f.match(/\d+/)[0], 10),
                    file: path.join(dir, f),
                }))
                .sort((a, b) => a.index - b.index);
        } catch { /* dir may not exist yet */ }

        this.config.cookiePool = files.map(f => f.file);
        this._slotIndexMap = {};
        files.forEach(f => { this._slotIndexMap[f.index] = f.file; });

        // Load pool metadata (saved-at timestamps per slot)
        const metaFile = path.join(dir, 'cookie_pool_meta.json');
        try {
            this._poolMeta = fs.existsSync(metaFile)
                ? JSON.parse(fs.readFileSync(metaFile, 'utf-8'))
                : { slots: {} };
        } catch { this._poolMeta = { slots: {} }; }

        _log(`[Pool] Rebuilt cookie pool: ${files.length} slot(s) discovered`, 'debug');
        return files;
    }

    /**
     * Check if a slot's cookies are still within the 18-hour window.
     * @param {number} slotIndex
     * @returns {boolean} true = cookie is still fresh
     */
    _isSlotFresh(slotIndex) {
        const slotMeta = (this._poolMeta && this._poolMeta.slots)
            ? this._poolMeta.slots[String(slotIndex)]
            : null;
        if (!slotMeta || (!slotMeta.savedAt && !slotMeta.expiresAt)) return true; // no metadata — assume valid
        const expiryMs = this.config.cookieExpiryMs || (18 * 60 * 60 * 1000);
        const expiresAt = slotMeta.expiresAt || (slotMeta.savedAt ? slotMeta.savedAt + expiryMs : null);
        return expiresAt ? Date.now() < expiresAt : false;
    }

    /**
     * Switch to the next cookie slot in the pool.
     * Skips expired and missing slots. Re-injects cookies into the live
     * browser — no restart required. Resets all captcha counters.
     *
     * @param {string} [reason=''] - Reason for the switch (logged)
     * @returns {Promise<boolean>} true if switched successfully
     */
    async switchToNextAccount(reason = '') {
        // Always rebuild to pick up any newly added files
        this._rebuildCookiePool();

        const slotMap = this._slotIndexMap || {};
        // Only consider slots that exist on disk AND are not expired
        const validSlots = Object.entries(slotMap)
            .map(([idx, file]) => ({ index: parseInt(idx, 10), file }))
            .filter(s => fs.existsSync(s.file) && this._isSlotFresh(s.index))
            .sort((a, b) => a.index - b.index);

        if (validSlots.length < 2) {
            _log('[Pool] No eligible backup slot (all expired or missing) — cannot switch', 'warn');
            return false;
        }

        const fromIndex = this._activeAccountIndex;
        const currentPos = validSlots.findIndex(s => s.index === fromIndex);
        const nextPos = (currentPos + 1) % validSlots.length;
        const next = validSlots[nextPos];

        if (next.index === fromIndex) {
            _log('[Pool] Only 1 usable slot — no rotation possible', 'warn');
            return false;
        }

        _log(`[Pool] ⚡ Switching account: slot #${fromIndex} → slot #${next.index}${reason ? ` (${reason})` : ''}`, 'warn');

        this._activeAccountIndex = next.index;
        this._accountSwitchCount++;
        this._recaptchaCallCount = 0;
        this._recaptchaTotalCount = 0;
        this._lastRecaptchaAt = 0;
        this._accountBatchStartAt = Date.now();
        this.clearWarmup();

        if (this._cdp && this._page) {
            this.config.cookieFile = next.file;
            await this._injectCookies();
            await this._rotateRecaptchaSession(`account switch to slot #${next.index}`);

            // CHECK IF ALIVE!
            const currentUrl = this._page.url();
            if (currentUrl.includes('accounts.google') || currentUrl.includes('signin') || currentUrl.includes('login')) {
                _log(`[Pool] Slot #${next.index} is dead (redirected to login). Marking as expired...`, 'warn');

                // Expire the metadata so it doesn't get picked again in the loop
                if (this._poolMeta && this._poolMeta.slots && this._poolMeta.slots[next.index]) {
                    this._poolMeta.slots[next.index].expiresAt = 0; // Mark as expired
                    this._poolMeta.slots[next.index].savedAt = 0;
                    const metaFile = path.join(this.config.userDataDir, 'cookie_pool_meta.json');
                    try { fs.writeFileSync(metaFile, JSON.stringify(this._poolMeta, null, 2)); } catch (e) { }
                }
                // Try next account recursively
                return this.switchToNextAccount('dead session cascade');
            }
        }

        this.emit('account:switched', {
            from: fromIndex,
            to: next.index,
            reason,
            switchCount: this._accountSwitchCount,
        });

        _log(`[Pool] ✅ Now on account slot #${next.index}`, 'success');
        return true;
    }

    /**
     * Get current cookie pool status for UI display.
     * Returns expiry info per slot for the cookie expiry countdown.
     * @returns {{ slots: Array, activeIndex: number, switchCount: number }}
     */
    getPoolStatus() {
        const slotMap = this._slotIndexMap || {};
        const meta = (this._poolMeta && this._poolMeta.slots) || {};
        const expiryMs = this.config.cookieExpiryMs || (18 * 60 * 60 * 1000);
        const now = Date.now();

        const slots = Object.entries(slotMap).map(([idx, file]) => {
            const i = parseInt(idx, 10);
            const slotMeta = meta[String(i)] || {};
            const savedAt = slotMeta.savedAt || null;
            const expiresAt = slotMeta.expiresAt || (savedAt ? savedAt + expiryMs : null);
            return {
                index: i,
                file,
                exists: fs.existsSync(file),
                isActive: i === this._activeAccountIndex,
                label: slotMeta.label || `Account ${i + 1}`,
                savedAt,
                expiresAt,
                remainingMs: expiresAt ? Math.max(0, expiresAt - now) : null,
                isExpired: expiresAt ? now >= expiresAt : false,
            };
        }).sort((a, b) => a.index - b.index);

        return {
            slots,
            activeIndex: this._activeAccountIndex,
            switchCount: this._accountSwitchCount,
            recaptchaTotalCount: this._recaptchaTotalCount || 0,
            recaptchaCallCount: this._recaptchaCallCount || 0,
        };
    }




    // ─── Option G: Proxy Rotation Stub (STANDBY) ────────────────────

    /**
     * Returns the next proxy config to inject into Puppeteer launch args.
     * Returns null when proxy is disabled (default).
     * @private
     */
    _getNextProxy() {
        const cfg = this.config.proxy;
        if (!cfg || !cfg.enabled || !cfg.list || cfg.list.length === 0) return null;

        let idx = cfg._activeIndex || 0;
        if (cfg.mode === 'random') {
            idx = Math.floor(Math.random() * cfg.list.length);
        } else {
            // roundrobin
            idx = idx % cfg.list.length;
        }
        cfg._activeIndex = idx + 1;
        return cfg.list[idx] || null;
    }

    /**
     * Advance to the next proxy in the pool (call externally when a proxy fails).
     * No-op when proxy is disabled.
     */
    rotateProxy() {
        const cfg = this.config.proxy;
        if (!cfg || !cfg.enabled || !cfg.list || cfg.list.length === 0) return;
        cfg._activeIndex = ((cfg._activeIndex || 0) + 1) % cfg.list.length;
        _log(`[Proxy] Rotated to proxy index ${cfg._activeIndex}`, 'debug');
    }

    /**
     * Reload the Flow page to get a fresh reCAPTCHA session.
     * Resets the per-session call counter and rate-limit timestamp.
     * @private
     */
    async _rotateRecaptchaSession(reason = '') {
        if (this._rotationInProgress) {
            _log(`Session rotation already in progress, waiting...`, 'debug');
            return this._rotationMutex;
        }

        const now = Date.now();
        if (this._lastRotationAt && (now - this._lastRotationAt < 30000)) {
            _log(`Session rotated recently (<30s). Skipping redundant rotation.`, 'debug');
            return;
        }

        this._rotationInProgress = true;
        this._rotationMutex = (async () => {
            _log(`Rotating reCAPTCHA session${reason ? ` (${reason})` : ''}...`, 'debug');
            try {
                await this._page.goto(this.config.targetUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
                await new Promise(r => setTimeout(r, 3000)); // wait for grecaptcha to load
            } catch (e) {
                _log(`Session rotation navigation failed: ${e.message}`, 'warn');
            }
            this._recaptchaCallCount = 0;    // reset — fresh session
            this._lastRecaptchaAt = 0;       // no gap needed after reload
            this._accountBatchStartAt = 0;   // reset burst window
            this.clearWarmup();              // purge any stale pre-solved token from the old flagged session
            this._lastRotationAt = Date.now();
        })();

        try {
            await this._rotationMutex;
        } finally {
            this._rotationInProgress = false;
        }
    }

    /**
     * Call grecaptcha.enterprise.execute() in the page context.
     * If CAPTCHA_SOLVER_URL is set, tries the external solver first for higher-score tokens.
     * Falls back to Puppeteer grecaptcha.enterprise.execute() if solver is unavailable.
     * @private
     */
    async _executeRecaptcha(action) {
        // ── External Captcha Solver (if configured) ──────────────────────
        if (process.env.CAPTCHA_SOLVER_URL) {
            try {
                _log(`Requesting token from external solver for action: ${action}`, 'debug');
                const solverUrl = new URL(process.env.CAPTCHA_SOLVER_URL);
                solverUrl.searchParams.set('action', action);
                solverUrl.searchParams.set('sitekey', '6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV');
                solverUrl.searchParams.set('url', 'https://labs.google/fx/vi/tools/flow');

                const res = await fetch(solverUrl.toString());
                if (res.ok) {
                    const text = await res.text();
                    let token = text;
                    try {
                        const json = JSON.parse(text);
                        token = json.captcha || json.token || json.result || json.data || text;
                    } catch { }
                    if (typeof token === 'string' && token.length > 50) {
                        _log(`✅ External solver returned token (${token.length} chars)`, 'success');
                        return token;
                    }
                }

                // ── Solver failed — decide what to do based on mode ──────────
                if (process.env.CAPTCHA_MODE === 'real_chrome') {
                    // In real_chrome mode: DO NOT fall back to Puppeteer.
                    // A timeout means real Chrome is not connected or slow.
                    // Surfacing this as an error lets the retry loop try again cleanly.
                    _log(`🚫 [Real Chrome] Solver failed (HTTP ${res.status}) — NOT falling back to headless Brave. Ensure extension is loaded in real Chrome and labs.google is open.`, 'error');
                    return null;
                }

                _log(`⚠️ Solver failed (HTTP ${res.status}). Falling back to Puppeteer.`, 'warn');
            } catch (err) {
                if (process.env.CAPTCHA_MODE === 'real_chrome') {
                    _log(`🚫 [Real Chrome] Solver error (${err.message}) — NOT falling back to headless Brave.`, 'error');
                    return null;
                }
                _log(`⚠️ Solver connection error (${err.message}). Falling back to Puppeteer.`, 'warn');
            }
        }

        // ── Puppeteer fallback (auto mode only) ──────────────────────────
        // Skipped in real_chrome mode — Brave is OAuth-only, not a captcha solver.
        if (process.env.CAPTCHA_MODE === 'real_chrome') {
            _log('🚫 [Real Chrome] No external solver available and Puppeteer fallback is disabled in this mode.', 'error');
            return null;
        }

        try {
            return await this._page.evaluate(async (siteKey, act) => {
                // Wait up to 3s for grecaptcha to be available (e.g. right after page load)
                for (let i = 0; i < 6; i++) {
                    if (typeof grecaptcha !== 'undefined' && grecaptcha.enterprise?.execute) break;
                    await new Promise(r => setTimeout(r, 500));
                }
                if (typeof grecaptcha === 'undefined' || !grecaptcha.enterprise?.execute) return null;
                try {
                    return await grecaptcha.enterprise.execute(siteKey, { action: act });
                } catch (e) {
                    console.error('[VEO3] grecaptcha.execute error:', e.message);
                    return null;
                }
            }, '6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV', action);
        } catch (err) {
            _log(`_executeRecaptcha threw: ${err.message}`, 'error');
            return null;
        }
    }


    /**
     * Gracefully shut down: stop auto-refresh, close Brave browser.
     */
    async shutdown() {
        if (this._shuttingDown) return;
        this._shuttingDown = true;

        _log('Shutting down...', 'info');

        // Stop refresh timer
        if (this._refreshTimer) {
            clearInterval(this._refreshTimer);
            this._refreshTimer = null;
        }

        // Close browser
        if (this._browser) {
            try { await this._browser.close(); } catch { }
            this._browser = null;
            this._page = null;
            this._cdp = null;
        }

        this._initialized = false;
        this._shuttingDown = false;
        _log('Shutdown complete', 'success');
    }

    /**
     * Returns current status (for diagnostics / API routes).
     */
    getStatus() {
        const tokenAge = this._tokenCapturedAt
            ? Math.round((Date.now() - this._tokenCapturedAt) / 1000)
            : null;

        return {
            initialized: this._initialized,
            hasToken: !!this._token,
            tokenLength: this._token ? this._token.length : 0,
            tokenAgeSeconds: tokenAge,
            browserAlive: !!(this._browser && this._page),
            refreshIntervalMin: Math.round(this.config.refreshIntervalMs / 60000),
        };
    }

    // ─── Private: Browser Lifecycle ─────────────────────────────────

    async _launchBrowser() {

        // Close existing browser if any
        if (this._browser) {
            try { await this._browser.close(); } catch { }
            this._browser = null;
            this._page = null;
            this._cdp = null;
        }

        // Ensure user data dir exists
        if (!fs.existsSync(this.config.userDataDir)) {
            fs.mkdirSync(this.config.userDataDir, { recursive: true });
        }

        _log('Launching Brave browser...', 'info');

        // Extension args — load captcha extension into Brave ONLY in auto mode.
        // In real_chrome mode: user's real Chrome handles captcha via captcha_server.js.
        // Brave only needs to run for OAuth token capture — no extension required.
        const extensionArgs = [];
        const isRealChromeMode = (process.env.CAPTCHA_MODE === 'real_chrome');
        if (isRealChromeMode) {
            _log('Real Chrome captcha mode — NOT loading extension into Brave (Brave = OAuth only)', 'info');
        } else if (fs.existsSync(CAPTCHA_EXTENSION_PATH)) {
            extensionArgs.push(
                `--load-extension=${CAPTCHA_EXTENSION_PATH}`,
                `--disable-extensions-except=${CAPTCHA_EXTENSION_PATH}`,
            );
            _log(`Captcha extension loaded into Brave: ${CAPTCHA_EXTENSION_PATH}`, 'debug');
        } else {
            _log('Captcha extension not found — skipping extension load', 'warn');
        }

        // Option G: Proxy injection (STANDBY — only active when proxy.enabled = true)
        const proxyArgs = [];
        const activeProxy = this._getNextProxy();
        if (activeProxy) {
            const auth = activeProxy.username ? `${activeProxy.username}:${activeProxy.password}@` : '';
            proxyArgs.push(`--proxy-server=http://${auth}${activeProxy.host}:${activeProxy.port}`);
            _log(`[Proxy] Routing through ${activeProxy.host}:${activeProxy.port}`, 'debug');
        }

        this._browser = await puppeteer.launch({
            headless: this.config.headless,
            executablePath: this.config.bravePath,
            userDataDir: this.config.userDataDir,
            defaultViewport: null,
            timeout: 30000,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--no-first-run',
                '--no-default-browser-check',
                '--disable-popup-blocking',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding',
                '--disable-session-crashed-bubble',
                '--disable-blink-features=AutomationControlled',
                '--window-size=1280,900',
                '--allow-insecure-localhost',
                '--ignore-certificate-errors',
                // ── Brave Shield bypass ──────────────────────────────
                '--disable-brave-shields',
                '--disable-brave-rewards-extension',
                '--disable-component-update',
                '--disable-brave-update',
                ...extensionArgs,
                ...proxyArgs,
            ],

        });

        // Handle unexpected browser disconnect
        this._browser.on('disconnected', () => {
            if (!this._shuttingDown) {
                _log('Browser disconnected unexpectedly!', 'error');
                this._browser = null;
                this._page = null;
                this._cdp = null;
                this.emit('token:error', new Error('Browser disconnected'));
            }
        });

        // Clean up old/restored tabs, create a fresh one
        const existingPages = await this._browser.pages();
        this._page = await this._browser.newPage();
        for (const oldPage of existingPages) {
            try { await oldPage.close(); } catch { }
        }

        // Create CDP session
        this._cdp = await this._page.createCDPSession();

        // Inject cookies
        await this._injectCookies();

        // Inject MAIN world interceptor (before navigation)
        await this._injectInterceptor();

        // Enable CDP network monitoring as backup
        await this._enableCDPNetworkCapture();

        _log('Browser ready', 'success');
    }

    // ─── Private: Cookie Injection ──────────────────────────────────

    async _injectCookies() {
        const cookies = _loadCookies(this.config.cookieFile);
        if (!cookies || cookies.length === 0) {
            _log('No cookies available — relying on existing browser profile session', 'warn');
            return;
        }

        let injected = 0;
        // Inject vào tất cả domains cần thiết
        const domains = ['.google.com', 'google.com', 'labs.google', '.labs.google'];
        for (const cookie of cookies) {
            // Xác định domains phù hợp cho từng cookie
            const targetDomains = cookie.domain ? [cookie.domain] : domains;
            for (const domain of targetDomains) {
                try {
                    await this._cdp.send('Network.setCookie', {
                        name: cookie.name,
                        value: cookie.value,
                        domain: domain,
                        path: cookie.path || '/',
                        httpOnly: cookie.httpOnly || false,
                        secure: cookie.secure !== false,
                        sameSite: cookie.sameSite || 'Lax',
                        url: domain.includes('labs.google') ? 'https://labs.google' : 'https://accounts.google.com',
                    });
                    injected++;
                } catch (e) { /* skip */ }
            }
        }

        _log(`Injected ${injected} cookie slots for ${cookies.length} cookies across all domains`, injected > 0 ? 'success' : 'warn');
    }

    // ─── Private: MAIN World Interceptor ────────────────────────────

    async _injectInterceptor() {
        await this._page.evaluateOnNewDocument(() => {
            // Storage for captured tokens
            window.__CAPTURED_TOKENS__ = [];

            // ─── Monkey-patch fetch() ──────────────────────────────
            const originalFetch = window.fetch;
            window.fetch = function (...args) {
                try {
                    const [resource, init] = args;
                    const url = typeof resource === 'string' ? resource : (resource?.url || '');
                    const headers = init?.headers || {};

                    let authValue = null;
                    if (headers instanceof Headers) {
                        authValue = headers.get('Authorization') || headers.get('authorization');
                    } else if (typeof headers === 'object' && !Array.isArray(headers)) {
                        authValue = headers['Authorization'] || headers['authorization'];
                    } else if (Array.isArray(headers)) {
                        const entry = headers.find(([k]) => k.toLowerCase() === 'authorization');
                        if (entry) authValue = entry[1];
                    }

                    if (authValue && authValue.startsWith('Bearer ya29.')) {
                        window.__CAPTURED_TOKENS__.push({
                            token: authValue.substring(7),
                            url: url.substring(0, 120),
                            source: 'fetch',
                            timestamp: Date.now(),
                        });
                    }
                } catch (e) { /* silent */ }

                return originalFetch.apply(this, args);
            };

            // ─── Monkey-patch XMLHttpRequest ───────────────────────
            const originalOpen = XMLHttpRequest.prototype.open;
            const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

            XMLHttpRequest.prototype.open = function (method, url, ...rest) {
                this.__url = url;
                return originalOpen.call(this, method, url, ...rest);
            };

            XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
                if (
                    (name === 'Authorization' || name === 'authorization') &&
                    typeof value === 'string' &&
                    value.startsWith('Bearer ya29.')
                ) {
                    window.__CAPTURED_TOKENS__.push({
                        token: value.substring(7),
                        url: (this.__url || '').substring(0, 120),
                        source: 'xhr',
                        timestamp: Date.now(),
                    });
                }
                return originalSetRequestHeader.call(this, name, value);
            };
        });

        _log('MAIN world fetch/XHR interceptor injected', 'debug');
    }

    // ─── Private: CDP Network Capture (backup) ──────────────────────

    async _enableCDPNetworkCapture() {
        // Track the latest CDP-captured token in a temporary holder
        this._cdpCapturedToken = null;

        // Map: mediaId → signed GCS URL (captured from browser network traffic)
        this._cdpMediaUrls = this._cdpMediaUrls || new Map();

        await this._cdp.send('Network.enable');
        this._cdp.on('Network.requestWillBeSent', (params) => {
            const url = params.request.url;
            const headers = params.request.headers;
            const auth = headers['authorization'] || headers['Authorization'];

            // 1) Bearer token capture (existing)
            if (
                url.includes('aisandbox-pa.googleapis.com') &&
                auth &&
                auth.startsWith('Bearer ya29.')
            ) {
                this._cdpCapturedToken = auth.substring(7);
                _log(`[CDP] Token captured from: ${url.substring(0, 70)}...`, 'debug');
            }

            // 1b) LOG ALL getMediaUrlRedirect requests — to find what mediaUrlType the UI uses for videos
            if (url.includes('getMediaUrlRedirect')) {
                const parsed = new URL(url);
                const urlType = parsed.searchParams.get('mediaUrlType') || '?';
                const name = parsed.searchParams.get('name') || '?';
                const secFetch = headers['sec-fetch-dest'] || headers['Sec-Fetch-Dest'] || 'none';
                // _log(`[CDP] 📡 getMediaUrlRedirect: type=${urlType} secFetchDest=${secFetch} id=${name.substring(0, 16)}...`, 'debug');
            }

            // 1c) LOG ALL labs.google tRPC API calls — to discover unknown endpoints
            if (url.includes('labs.google/fx/api/trpc') && !url.includes('getMediaUrlRedirect')) {
                const proc = url.split('/trpc/')[1]?.split('?')[0] || url;
                // _log(`[CDP] 🔮 tRPC: ${proc}`, 'debug');
            }

            // 2) Media URL capture: GCS signed URLs for generated videos/images
            // URL pattern: https://storage.googleapis.com/ai-sandbox-videofx/.../{mediaId}?...
            if (url.includes('storage.googleapis.com/ai-sandbox-videofx')) {
                try {
                    const urlObj = new URL(url);
                    const pathParts = urlObj.pathname.split('/').filter(Boolean);
                    const mediaId = pathParts[pathParts.length - 1]; // UUID
                    if (mediaId && mediaId.length > 30) {
                        // Phân biệt thumbnail (image/) vs video (video/)
                        const isVideoPath = urlObj.pathname.includes('/video/');
                        if (isVideoPath) {
                            this._cdpVideoUrls = this._cdpVideoUrls || new Map();
                            this._cdpVideoUrls.set(mediaId, url);
                            // _log(`[CDP] VIDEO URL captured: ${mediaId.substring(0, 20)}... (${url.substring(0, 60)}...)`, 'debug');
                        } else {
                            this._cdpMediaUrls.set(mediaId, url);
                            // _log(`[CDP] Media URL captured: ${mediaId.substring(0, 20)}... → ${url.substring(0, 60)}...`, 'debug');
                        }
                    }
                } catch { }
            }
        });

        // Network.responseReceived: log all getMediaUrlRedirect redirects to see GCS path
        this._cdp.on('Network.responseReceived', (params) => {
            const url = params.response.url;
            const status = params.response.status;
            const contentType = params.response.headers['content-type'] || params.response.headers['Content-Type'] || '';

            // Log redirect destination for getMediaUrlRedirect
            if (url.includes('getMediaUrlRedirect') && (status === 307 || status === 302 || status === 301)) {
                const location = params.response.headers['location'] || params.response.headers['Location'] || '?';
                // _log(`[CDP] 🔀 getMediaUrlRedirect ${status} → ${location.substring(0, 100)}`, 'debug');
            }

            // Log any GCS response (shows what path/type GCS is serving)
            if (url.includes('storage.googleapis.com/ai-sandbox-videofx') && status < 400) {
                const gcsPath = url.replace('https://storage.googleapis.com/ai-sandbox-videofx/', '').split('?')[0];
                // _log(`[CDP] 📦 GCS served: ${gcsPath.substring(0, 60)} → ct=${contentType.substring(0, 30)} status=${status}`, 'debug');
            }

            // Capture video/* responses  
            if (contentType.startsWith('video/') || contentType.includes('mp4')) {
                // _log(`[CDP] 🎬 VIDEO RESPONSE: ct=${contentType} status=${status} url=${url}`, 'debug');
                // _log(`[CDP] 🎬 VIDEO HEADERS: ${JSON.stringify(params.response.headers).substring(0, 300)}`, 'debug');
                try {
                    const urlObj = new URL(url);
                    const pathParts = urlObj.pathname.split('/').filter(Boolean);
                    const mediaId = pathParts[pathParts.length - 1];
                    if (mediaId && mediaId.length > 30) {
                        this._cdpVideoUrls = this._cdpVideoUrls || new Map();
                        this._cdpVideoUrls.set(mediaId, url);
                        // _log(`[CDP] Video response captured (content-type: ${contentType.substring(0, 20)}): ${mediaId.substring(0, 20)}...`, 'debug');
                    }
                } catch { }
            }
        });

    }

    /**
     * Chờ cho đến khi browser fetch media URL cho mediaId (qua CDP capture).
     * @param {string} mediaId - UUID của media cần đợi URL
     * @param {number} [timeoutMs=30000] - Timeout ms
     * @returns {Promise<string|null>} URL hoặc null nếu timeout
     */
    async waitForMediaUrl(mediaId, timeoutMs = 30000) {
        if (!this._cdpMediaUrls) this._cdpMediaUrls = new Map();
        if (!this._cdpVideoUrls) this._cdpVideoUrls = new Map();

        // Kiểm tra ngay nếu đã có VIDEO URL (ưu tiên MP4)
        if (this._cdpVideoUrls.has(mediaId)) return this._cdpVideoUrls.get(mediaId);
        // Fallback: thumbnail URL (image)
        if (this._cdpMediaUrls.has(mediaId)) return this._cdpMediaUrls.get(mediaId);

        // Poll chờ CDP capture URL — ưu tiên video, fallback thumbnail
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            await new Promise(r => setTimeout(r, 500));
            if (this._cdpVideoUrls.has(mediaId)) return this._cdpVideoUrls.get(mediaId);
            if (this._cdpMediaUrls.has(mediaId)) return this._cdpMediaUrls.get(mediaId);
        }
        return null;
    }

    /**
     * Xóa cache URL đã capture cho một mediaId cụ thể.
     */
    clearCapturedMediaUrl(mediaId) {
        this._cdpMediaUrls?.delete(mediaId);
        this._cdpVideoUrls?.delete(mediaId);
    }


    // ─── Private: Token Capture Orchestra ───────────────────────────

    async _captureToken() {

        if (!this._page) throw new Error('Browser page not available');

        // Reset CDP capture for this cycle
        this._cdpCapturedToken = null;

        // Navigate to Google Flow
        _log(`Navigating to ${this.config.targetUrl}`, 'info');
        try {
            await this._page.goto(this.config.targetUrl, {
                waitUntil: 'networkidle2',
                timeout: 30000,
            });
        } catch (navErr) {
            _log(`Navigation timeout (normal for heavy pages): ${navErr.message}`, 'warn');
        }

        await new Promise(r => setTimeout(r, 3000));

        // Check if redirected to login
        const currentUrl = this._page.url();
        if (currentUrl.includes('accounts.google.com')) {
            _log('Redirected to Google Login — cookies are expired!', 'error');
            this.emit('token:expired', 'Cookies expired — redirected to login');
            return;
        }

        // ── Method 1: Read tokens from MAIN world interceptor ────────
        let captured = false;
        try {
            const capturedData = await this._page.evaluate(() => ({
                tokens: window.__CAPTURED_TOKENS__ || [],
            }));

            if (capturedData.tokens.length > 0) {
                const latest = capturedData.tokens[capturedData.tokens.length - 1];
                this._setToken(latest.token);
                _log(`[Method 1] Token via interceptor (${latest.source} → ${latest.url})`, 'success');
                captured = true;
            }
        } catch (e) {
            _log(`Interceptor read failed: ${e.message}`, 'warn');
        }

        // ── Method 2: CDP backup token ───────────────────────────────
        if (!captured && this._cdpCapturedToken) {
            this._setToken(this._cdpCapturedToken);
            _log('[Method 2] Token via CDP network capture', 'success');
            captured = true;
        }

        // ── Method 3: Page context evaluation ────────────────────────
        if (!captured) {
            _log('Trying page context evaluation...', 'debug');
            try {
                const pageToken = await this._page.evaluate(() => {
                    const tokenRegex = /ya29\.[a-zA-Z0-9_\-\.]{50,}/;

                    // __NEXT_DATA__
                    if (window.__NEXT_DATA__) {
                        const data = JSON.stringify(window.__NEXT_DATA__);
                        const match = data.match(tokenRegex);
                        if (match) return match[0];
                    }

                    // sessionStorage
                    for (let i = 0; i < sessionStorage.length; i++) {
                        const val = sessionStorage.getItem(sessionStorage.key(i));
                        if (val) {
                            const match = val.match(tokenRegex);
                            if (match) return match[0];
                        }
                    }

                    // localStorage
                    for (let i = 0; i < localStorage.length; i++) {
                        const val = localStorage.getItem(localStorage.key(i));
                        if (val) {
                            const match = val.match(tokenRegex);
                            if (match) return match[0];
                        }
                    }

                    // Global objects
                    const targets = ['gapi', 'google', '__GOOGLE_LABS_CONFIG__', '__cData', '__pData', '__wData'];
                    for (const name of targets) {
                        try {
                            const obj = window[name];
                            if (obj) {
                                const str = JSON.stringify(obj);
                                const match = str.match(tokenRegex);
                                if (match) return match[0];
                            }
                        } catch (e) { }
                    }

                    return null;
                });

                if (pageToken) {
                    this._setToken(pageToken);
                    _log('[Method 3] Token via page context scan', 'success');
                    captured = true;
                }
            } catch (e) {
                _log(`Page eval failed: ${e.message}`, 'warn');
            }
        }

        // ── Method 4: Reload and re-try ──────────────────────────────
        if (!captured) {
            _log('Reloading page for fresh token...', 'info');
            try {
                await this._page.reload({ waitUntil: 'networkidle2', timeout: 20000 });
            } catch (e) { /* timeout is normal */ }

            await new Promise(r => setTimeout(r, 3000));

            // Re-check interceptor
            try {
                const tokens = await this._page.evaluate(() => window.__CAPTURED_TOKENS__ || []);
                if (tokens.length > 0) {
                    this._setToken(tokens[tokens.length - 1].token);
                    _log('[Method 4] Token via interceptor after reload', 'success');
                    captured = true;
                }
            } catch (e) { }

            // Re-check CDP
            if (!captured && this._cdpCapturedToken) {
                this._setToken(this._cdpCapturedToken);
                _log('[Method 4] Token via CDP after reload', 'success');
                captured = true;
            }
        }

        // ── Validate captured token ──────────────────────────────────
        if (captured && this._token) {
            const validation = await _validateToken(this._token, this.config.apiKey);
            if (validation.valid) {
                _log(`Token validated — HTTP ${validation.status}`, 'success');
                if (validation.data && validation.data.credits !== undefined) {
                    _log(`Credits: ${validation.data.credits}, Tier: ${validation.data.sku || 'unknown'}`, 'debug');
                }
            } else {
                _log(`Token validation FAILED — HTTP ${validation.status}`, 'error');
                // Don't clear the token — it may still work for non-credits endpoints
            }

            // Persist to disk
            this._persistToken();
        }
    }

    // ─── Private: Token State ───────────────────────────────────────

    _setToken(token) {
        this._token = token;
        this._tokenCapturedAt = Date.now();
    }

    _persistToken() {
        if (!this._token) return;
        try {
            const data = {
                token: this._token,
                capturedAt: new Date(this._tokenCapturedAt).toISOString(),
                refreshIntervalMs: this.config.refreshIntervalMs,
            };
            fs.writeFileSync(this.config.tokenFile, JSON.stringify(data, null, 2), 'utf-8');
        } catch (e) {
            _log(`Failed to persist token: ${e.message}`, 'warn');
        }
    }

    _loadPersistedToken() {
        try {
            if (!fs.existsSync(this.config.tokenFile)) return;
            const raw = fs.readFileSync(this.config.tokenFile, 'utf-8');
            const data = JSON.parse(raw);

            if (data.token && data.capturedAt) {
                const age = Date.now() - new Date(data.capturedAt).getTime();
                // Only use persisted token if it's less than 55 minutes old
                if (age < 55 * 60 * 1000) {
                    this._token = data.token;
                    this._tokenCapturedAt = new Date(data.capturedAt).getTime();
                    _log(`Loaded persisted token (age: ${Math.round(age / 60000)} min)`, 'info');
                } else {
                    _log('Persisted token too old — will refresh on initialize()', 'debug');
                }
            }
        } catch (e) { /* ignore */ }
    }

    // ─── Private: Auto-Refresh Timer ────────────────────────────────

    _startRefreshTimer() {
        if (this._refreshTimer) {
            clearInterval(this._refreshTimer);
        }

        this._refreshTimer = setInterval(() => {
            if (this._shuttingDown) return;
            _log('Auto-refresh cycle triggered', 'info');
            this.refreshToken().catch(err => {
                _log(`Auto-refresh failed: ${err.message}`, 'error');
            });
        }, this.config.refreshIntervalMs);

        // Don't let the timer keep the process alive if everything else is done
        if (this._refreshTimer.unref) {
            this._refreshTimer.unref();
        }
    }
}

// ─── Module Export ──────────────────────────────────────────────────
module.exports = TokenManager;