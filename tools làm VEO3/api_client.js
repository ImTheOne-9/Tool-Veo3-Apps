/**
 * ═══════════════════════════════════════════════════════════════════
 *  API Client — Direct HTTP calls to Google Flow APIs
 * ═══════════════════════════════════════════════════════════════════
 *
 *  Replaces all Puppeteer DOM interactions with direct API calls.
 *  Uses OAuth token from TokenManager + recaptcha from browser page.
 *
 *  Architecture:
 *    TokenManager (background Brave) → OAuth token + recaptcha token
 *    ApiClient → Direct HTTP to aisandbox-pa.googleapis.com
 *
 * ═══════════════════════════════════════════════════════════════════
 */

const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const { EventEmitter } = require('events');

// ─── Constants ─────────────────────────────────────────────────────
const API_BASE = 'https://aisandbox-pa.googleapis.com';
const LABS_BASE = 'https://labs.google';
const API_KEY = 'AIzaSyBtrm0o5ab1c-Ec8ZuLcGt3oJAA5VWt3pY';
const RECAPTCHA_SITE_KEY = '6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV';
const TOOL_NAME = 'PINHOLE';

// User-Agent to match real browser
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

// ─── Image Model Keys ──────────────────────────────────────────────
const IMAGE_MODELS = {
    'nano_banana_pro': 'GEM_PIX_2',
    'nano_banana_2': 'NARWHAL',
    'imagen_4': 'IMAGEN_3_5',
    'imagen_4_ref': 'R2I',           // Imagen 4 with reference images
    'upsample_2k': 'GEM_PIX_2_UPSAMPLE_2K',
    'upsample_4k': 'GEM_PIX_2_UPSAMPLE_4K',
};

// ─── Image Aspect Ratio Mapping ────────────────────────────────────
const IMAGE_ASPECT_RATIOS = {
    '16:9': 'IMAGE_ASPECT_RATIO_LANDSCAPE',
    '9:16': 'IMAGE_ASPECT_RATIO_PORTRAIT',
    '1:1': 'IMAGE_ASPECT_RATIO_SQUARE',
    '4:3': 'IMAGE_ASPECT_RATIO_LANDSCAPE_4_3',
    '3:4': 'IMAGE_ASPECT_RATIO_PORTRAIT_3_4',
    'landscape': 'IMAGE_ASPECT_RATIO_LANDSCAPE',
    'portrait': 'IMAGE_ASPECT_RATIO_PORTRAIT',
    'square': 'IMAGE_ASPECT_RATIO_SQUARE',
};

// ─── Video Aspect Ratio Mapping ────────────────────────────────────
const VIDEO_ASPECT_RATIOS = {
    '16:9': 'VIDEO_ASPECT_RATIO_LANDSCAPE',
    '9:16': 'VIDEO_ASPECT_RATIO_PORTRAIT',
    'landscape': 'VIDEO_ASPECT_RATIO_LANDSCAPE',
    'portrait': 'VIDEO_ASPECT_RATIO_PORTRAIT',
};

// ─── Video Model Key Resolution ────────────────────────────────────
// Maps: (family, generationType, aspectRatio, tier) → API model key
const VIDEO_MODEL_KEYS = {
    // --- Veo 3.1 Lite ---
    'veo_3_1_lite': {
        't2v': { default: 'veo_3_1_t2v_lite' },
        'i2v': { default: 'veo_3_1_i2v_lite' },
        'f2v': { default: 'veo_3_1_i2v_s_lite_fl' },  // start+end frame (frames mode)
    },
    // --- Veo 3.1 Fast ---
    'veo_3_1_fast': {
        't2v': {
            landscape_advanced: 'veo_3_1_t2v_fast_ultra',
            portrait_advanced: 'veo_3_1_t2v_fast_portrait_ultra',
            landscape: 'veo_3_1_t2v_fast',
            portrait: 'veo_3_1_t2v_fast_portrait',
        },
        'i2v': {
            landscape_advanced: 'veo_3_1_i2v_s_fast_ultra',
            portrait_advanced: 'veo_3_1_i2v_s_fast_portrait_ultra',
            landscape: 'veo_3_1_i2v_s_fast',
            portrait: 'veo_3_1_i2v_s_fast_portrait',
        },
        'f2v': {
            landscape_advanced: 'veo_3_1_i2v_s_fast_ultra_fl',  // start+end frame — confirmed from capture
            portrait_advanced: 'veo_3_1_i2v_s_fast_portrait_ultra_fl',
            landscape: 'veo_3_1_i2v_s_fast_fl',
            portrait: 'veo_3_1_i2v_s_fast_portrait_fl',
        },
        'r2v': {
            landscape_advanced: 'veo_3_1_r2v_fast_landscape_ultra',
            portrait_advanced: 'veo_3_1_r2v_fast_portrait_ultra',
            landscape: 'veo_3_1_r2v_fast_landscape',
            portrait: 'veo_3_1_r2v_fast_portrait',
        },
    },
    // --- Veo 3.1 Quality ---
    'veo_3_1_quality': {
        't2v': {
            landscape: 'veo_3_1_t2v',
            portrait: 'veo_3_1_t2v_portrait',
        },
        'i2v': {
            landscape: 'veo_3_1_i2v_s',
            portrait: 'veo_3_1_i2v_s_portrait',
        },
    },
    // --- Lower Priority (free) ---
    'veo_3_1_lite_low_priority': {
        't2v': { default: 'veo_3_1_t2v_lite_low_priority' },
        'i2v': { default: 'veo_3_1_i2v_lite_low_priority' },
        'f2v': { default: 'veo_3_1_i2v_s_lite_low_priority_fl' },
    },
    'veo_3_1_fast_low_priority': {
        't2v': {
            landscape: 'veo_3_1_t2v_fast_ultra_relaxed',
            portrait: 'veo_3_1_t2v_fast_portrait_ultra_relaxed',
        },
        'i2v': {
            landscape: 'veo_3_1_i2v_s_fast_ultra_relaxed',
            portrait: 'veo_3_1_i2v_s_fast_portrait_ultra_relaxed',
        },
        'f2v': {
            landscape: 'veo_3_1_i2v_s_fast_ultra_relaxed_fl',
            portrait: 'veo_3_1_i2v_s_fast_portrait_ultra_relaxed_fl',
        },
        'r2v': {
            landscape: 'veo_3_1_r2v_fast_landscape_ultra_relaxed',
            portrait: 'veo_3_1_r2v_fast_portrait_ultra_relaxed',
        },
    },
};

// ─── Polling Config ────────────────────────────────────────────────
const POLL_INTERVAL_MS = 10000;    // 10 seconds between polls
const POLL_TIMEOUT_MS = 600000;    // 10 minutes max wait


class ApiClient extends EventEmitter {
    /**
     * @param {object} tokenManager - TokenManager instance with getToken() and browser page
     * @param {object} [options] - Configuration options
     * @param {string} [options.projectId] - Reuse a specific project ID instead of creating a new one
     * @param {boolean} [options.reuseProject] - If true, reuse the most recent existing project instead of creating fresh
     */
    constructor(tokenManager, options = {}) {
        super();
        this._tokenManager = tokenManager;
        this._options = options;
        this._sessionId = `;${Date.now()}`;
        this._userTier = options.serviceTier || 'SERVICE_TIER_ADVANCED';
        this._paygateTier = options.paygateTier || 'PAYGATE_TIER_TWO';

        // Cached data
        this._projectId = options.projectId || null;
        this._modelConfig = null;
        this._cachedCookies = null;
    }

    // ═══════════════════════════════════════════════════════════════
    //  INTERNAL: HTTP + Auth helpers
    // ═══════════════════════════════════════════════════════════════

    /**
     * Make an authenticated API request to aisandbox-pa.googleapis.com.
     * 
     * NOTE: Generate calls (batchGenerateImages, batchAsyncGenerateVideoStartImage)
     * require reCAPTCHA and MUST go through the browser UI automation
     * (generateImageViaUI / generateVideoViaUI). Direct HTTP and even
     * page.evaluate(fetch()) get blocked by reCAPTCHA Enterprise.
     * 
     * This method works for: credits, polling, workflow updates, etc.
     */
    async _apiRequest(method, path, body = null, extraHeaders = {}) {
        const token = await this._tokenManager.getToken();
        if (!token) throw new Error('No OAuth token available');

        const url = `${API_BASE}${path}`;
        const headers = {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'text/plain;charset=UTF-8',
            'Origin': LABS_BASE,
            'Referer': `${LABS_BASE}/`,
            'User-Agent': USER_AGENT,
            'sec-ch-ua': '"Not;A Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Windows"',
            ...extraHeaders,
        };

        return this._httpRequest(method, url, headers, body);
    }

    /**
     * Execute an API request through direct HTTP with got-scraping.
     * Handles UNUSUAL_ACTIVITY 403 errors with session rotation and reCAPTCHA token refresh.
     */
    async _browserFetch(method, url, token, body, recaptchaAction = null) {
        let currentBody = body;
        let attempts = 0;
        const maxAttempts = 3;

        // ── Keywords that indicate Google content-policy / safety violations ──
        // These are NEVER retriable — log as hard error and throw immediately.
        const POLICY_KEYWORDS = [
            'SAFETY_FILTER',
            'CONTENT_POLICY',
            'POLICY_VIOLATION',
            'PUBLIC_POLICY_VIOLATION',
            'BLOCKED_FOR_SAFETY',
            'SAFETY_BLOCKED',
            'PROHIBITED_CONTENT',
            'TERMS_OF_SERVICE',
            'HARMFUL_CONTENT',
            'ADULT_CONTENT',
            'UNSAFE_CONTENT',
        ];

        while (attempts < maxAttempts) {
            attempts++;
            const page = this._tokenManager._page;
            if (!page) throw new Error('No browser page for browserFetch');

            const headers = {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'text/plain;charset=UTF-8',
                'Origin': LABS_BASE,
                'Referer': `${LABS_BASE}/fx/vi/tools/flow`,
            };

            let result;
            try {
                result = await this._httpRequest(method, url, headers, currentBody);
            } catch (httpErr) {
                // _httpRequest throws for 4xx/5xx — extract status from error
                const errStatus = httpErr.status || 0;
                const errBody = httpErr.body ? (typeof httpErr.body === 'object' ? JSON.stringify(httpErr.body) : String(httpErr.body)) : httpErr.message;

                // ── Policy violation check on thrown errors ──────────────────
                const isPolicyViolation = POLICY_KEYWORDS.some(kw => errBody.includes(kw));
                if (isPolicyViolation) {
                    console.error(`[ApiClient] 🚫 GOOGLE POLICY VIOLATION detected (HTTP ${errStatus}):\n${errBody.substring(0, 600)}`);
                    throw new Error(`POLICY_VIOLATION: Google blocked this request due to content policy.\n${errBody.substring(0, 400)}`);
                }

                // ── 403 / 401: let the outer logic handle (session rotation etc.) ──
                if (errStatus === 403 || errStatus === 401) {
                    // Re-throw so we fall into the handling below
                    const bodyStrForCheck = errBody;
                    const isUnusualActivity = errStatus === 403 && bodyStrForCheck.includes('PUBLIC_ERROR_UNUSUAL_ACTIVITY');

                    if (isUnusualActivity && attempts < maxAttempts) {
                        console.warn(`[ApiClient] ⚠️ PUBLIC_ERROR_UNUSUAL_ACTIVITY (from thrown err) Rotating session... (Attempt ${attempts}/${maxAttempts})`);
                        if (typeof this._tokenManager._rotateRecaptchaSession === 'function') {
                            await this._tokenManager._rotateRecaptchaSession('reactive — UNUSUAL_ACTIVITY block');
                        }
                        if (recaptchaAction && currentBody?.clientContext?.recaptchaContext) {
                            const freshToken = await this._tokenManager.getRecaptchaToken(recaptchaAction);
                            if (freshToken) currentBody.clientContext.recaptchaContext.token = freshToken;
                        }
                        token = await this._tokenManager.getToken();
                        continue;
                    }
                    throw httpErr;
                }

                // ── 429: rate limited ────────────────────────────────────────
                if (errStatus === 429) {
                    if (attempts < maxAttempts) {
                        const waitMs = Math.min(60000, 120_000);
                        console.warn(`[ApiClient] ⚠️ 429 Rate Limited — waiting ${Math.round(waitMs / 1000)}s before retry (Attempt ${attempts}/${maxAttempts})`);
                        await new Promise(r => setTimeout(r, waitMs));
                        token = await this._tokenManager.getToken();
                        continue;
                    }
                    throw httpErr;
                }

                // ── All other errors (5xx, network, audio gen failure, etc.) ──
                // Retry with exponential backoff
                if (attempts < maxAttempts) {
                    const backoffMs = Math.min(5000 * attempts, 30000);
                    console.warn(`[ApiClient] ⚠️ Request failed (HTTP ${errStatus || 'network'}) — retrying in ${Math.round(backoffMs / 1000)}s (Attempt ${attempts}/${maxAttempts}): ${httpErr.message.substring(0, 200)}`);
                    await new Promise(r => setTimeout(r, backoffMs));
                    token = await this._tokenManager.getToken();
                    continue;
                }

                // All retries exhausted
                console.error(`[ApiClient] ❌ Request failed after ${maxAttempts} attempts: ${httpErr.message.substring(0, 300)}`);
                throw httpErr;
            }

            if (result.status >= 200 && result.status < 300) {
                return { status: result.status, headers: {}, body: result.body };
            }

            const bodyStrForCheck = typeof result.body === 'object' ? JSON.stringify(result.body) : String(result.body);

            // ── Policy violation check on successful (2xx) responses with error body ──
            const isPolicyViolation = POLICY_KEYWORDS.some(kw => bodyStrForCheck.includes(kw));
            if (isPolicyViolation) {
                console.error(`[ApiClient] 🚫 GOOGLE POLICY VIOLATION in response body (HTTP ${result.status}):\n${bodyStrForCheck.substring(0, 600)}`);
                throw new Error(`POLICY_VIOLATION: Google blocked this request due to content policy.\n${bodyStrForCheck.substring(0, 400)}`);
            }

            // ── 429 Rate-Limit handler ──────────────────────────────────────
            if (result.status === 429 && attempts < maxAttempts) {
                const retryAfterSec = parseInt(
                    (result.headers && (result.headers['retry-after'] || result.headers['Retry-After'])) || '60',
                    10
                );
                const waitMs = Math.min(retryAfterSec * 1000, 120_000); // cap at 2 min
                console.warn(`[ApiClient] ⚠️ 429 Rate Limited — waiting ${Math.round(waitMs / 1000)}s before retry (Attempt ${attempts}/${maxAttempts})`);
                await new Promise(r => setTimeout(r, waitMs));
                // Refresh OAuth token in case it expired during the wait
                token = await this._tokenManager.getToken();
                continue;
            }

            const isUnusualActivity = result.status === 403 &&
                bodyStrForCheck.includes('PUBLIC_ERROR_UNUSUAL_ACTIVITY');

            if (isUnusualActivity && attempts < maxAttempts) {
                console.warn(`[ApiClient] ⚠️ PUBLIC_ERROR_UNUSUAL_ACTIVITY detected! account/IP cooling down. Rotating session... (Attempt ${attempts}/${maxAttempts})`);

                // 1. Rotate Session (Reloads page to reset reCAPTCHA state)
                if (typeof this._tokenManager._rotateRecaptchaSession === 'function') {
                    await this._tokenManager._rotateRecaptchaSession('reactive — UNUSUAL_ACTIVITY block');
                }

                // 2. Clear old token and get fresh token
                if (recaptchaAction && currentBody?.clientContext?.recaptchaContext) {
                    const freshToken = await this._tokenManager.getRecaptchaToken(recaptchaAction);
                    if (freshToken) {
                        currentBody.clientContext.recaptchaContext.token = freshToken;
                    }
                }

                // 3. Update OAuth token in case it expired
                token = await this._tokenManager.getToken();
                continue;
            }

            if (result.status === 401 || result.status === 403) {
                const detail = typeof result.body === 'object'
                    ? JSON.stringify(result.body, null, 2).substring(0, 500)
                    : String(result.body).substring(0, 500);
                throw new Error(`AUTH_ERROR_${result.status}: ${method} ${url}\n${detail}`);
            }

            // ── All other non-2xx, non-403, non-429 (e.g. 400 bad request, 500, audio gen failed) ──
            // Retry with exponential backoff instead of throwing immediately
            if (attempts < maxAttempts) {
                const detail = bodyStrForCheck.substring(0, 300);
                const backoffMs = Math.min(5000 * attempts, 30000);
                console.warn(`[ApiClient] ⚠️ API Error ${result.status} — retrying in ${Math.round(backoffMs / 1000)}s (Attempt ${attempts}/${maxAttempts}): ${detail}`);
                await new Promise(r => setTimeout(r, backoffMs));
                token = await this._tokenManager.getToken();
                continue;
            }

            // All retries exhausted — throw as a hard error
            const finalDetail = typeof result.body === 'object'
                ? JSON.stringify(result.body, null, 2).substring(0, 500)
                : String(result.body).substring(0, 500);
            console.error(`[ApiClient] ❌ API Error ${result.status} after ${maxAttempts} attempts: ${method} ${url}\n${finalDetail}`);
            throw new Error(`API Error ${result.status} ${method} ${url}: ${finalDetail}`);
        }
    }

    /**
     * Make a request to labs.google (tRPC endpoints, session, etc.)
     * These endpoints require session cookies from the browser.
     */
    async _labsRequest(method, path, body = null) {
        const url = `${LABS_BASE}${path}`;
        const cookieStr = await this._getCookieString();
        const headers = {
            'Content-Type': 'application/json',
            'Referer': `${LABS_BASE}/fx/vi/tools/flow`,
            'User-Agent': USER_AGENT,
            'sec-ch-ua': '"Not;A Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Windows"',
        };
        if (cookieStr) headers['Cookie'] = cookieStr;

        return this._httpRequest(method, url, headers, body);
    }

    /**
     * Get cookies from TokenManager's browser for labs.google requests.
     * Caches cookies for 5 minutes to avoid repeated browser calls.
     */
    async _getCookieString() {
        // Return cached if fresh (< 5 min)
        if (this._cachedCookies && Date.now() - this._cachedCookies.ts < 300000) {
            return this._cachedCookies.str;
        }

        const page = this._tokenManager._page;
        if (!page) {
            console.warn('[ApiClient] No browser page — labs requests may fail without cookies');
            return null;
        }

        try {
            // Lấy cookies từ cả labs.google và google.com
            const [labsCookies, googleCookies] = await Promise.all([
                page.cookies('https://labs.google').catch(() => []),
                page.cookies('https://accounts.google.com').catch(() => []),
            ]);

            // Gộp và deduplicate theo name
            const seen = new Set();
            const allCookies = [...labsCookies, ...googleCookies].filter(c => {
                if (seen.has(c.name)) return false;
                seen.add(c.name);
                return true;
            });

            const str = allCookies.map(c => `${c.name}=${c.value}`).join('; ');
            this._cachedCookies = { str, ts: Date.now() };
            return str;
        } catch (err) {
            console.warn('[ApiClient] Failed to get cookies:', err.message);
            return null;
        }
    }

    /**
     * Low-level HTTP request with JSON parsing and TLS impersonation via got-scraping
     */
    _httpRequest(method, url, headers, body) {
        return new Promise(async (resolve, reject) => {
            try {
                const bodyStr = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined;
                let cType = headers['Content-Type'] || headers['content-type'];
                if (bodyStr && !cType) {
                    headers['Content-Type'] = 'application/json';
                }

                const options = {
                    url,
                    method: method.toUpperCase(),
                    headers,
                    responseType: 'text',
                    timeout: { request: 300000 },
                    throwHttpErrors: false, // We will manually handle HTTP errors below

                    // TLS Impersonation — mimicking Chrome entirely
                    headerGeneratorOptions: {
                        browsers: [{ name: 'chrome', minVersion: 125, maxVersion: 130 }],
                        devices: ['desktop'],
                        operatingSystems: ['windows']
                    }
                };

                if (bodyStr) {
                    options.body = bodyStr;
                }

                const { gotScraping } = await import('got-scraping');
                const res = await gotScraping(options);

                // Parse the body natively
                let parsed = res.body;
                try { if (res.body) parsed = JSON.parse(res.body); } catch (e) { }

                if (res.statusCode >= 200 && res.statusCode < 300) {
                    resolve({ status: res.statusCode, headers: res.headers, body: parsed });
                } else if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    // 3xx redirect: resolve with redirect URL
                    resolve({ status: res.statusCode, headers: res.headers, body: parsed, redirectUrl: res.headers.location });
                } else if (res.statusCode === 401 || res.statusCode === 403) {
                    const detail = typeof parsed === 'object' ? JSON.stringify(parsed, null, 2).substring(0, 500) : String(parsed).substring(0, 500);
                    const err = new Error(`AUTH_ERROR_${res.statusCode}: ${method} ${new URL(url).pathname}\n${detail}`);
                    err.status = res.statusCode;
                    err.body = parsed;
                    reject(err);
                } else {
                    const errMsg = typeof parsed === 'object'
                        ? JSON.stringify(parsed.error || parsed, null, 2)
                        : String(parsed).substring(0, 500);
                    const err = new Error(`API Error ${res.statusCode} ${method} ${new URL(url).pathname}: ${errMsg}`);
                    err.status = res.statusCode;
                    err.body = parsed;
                    reject(err);
                }

            } catch (err) {
                err.status = 500;
                reject(err);
            }
        });
    }

    /**
     * Download raw binary data from a URL (for media downloads)
     */
    downloadBuffer(url, extraHeaders = {}) {
        return new Promise((resolve, reject) => {
            const urlObj = new URL(url);
            const lib = urlObj.protocol === 'https:' ? https : http;

            const options = {
                hostname: urlObj.hostname,
                port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
                path: urlObj.pathname + urlObj.search,
                method: 'GET',
                headers: { 'User-Agent': USER_AGENT, ...extraHeaders },
                timeout: 120000,
            };

            const req = lib.request(options, (res) => {
                // Follow redirects (strip auth headers for non-labs.google redirects)
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    const targetUrl = res.headers.location;
                    const isLabsGoogle = targetUrl.includes('labs.google');
                    const forwardHeaders = isLabsGoogle ? extraHeaders : {};
                    return this.downloadBuffer(targetUrl, forwardHeaders).then(resolve).catch(reject);
                }

                const chunks = [];
                res.on('data', chunk => chunks.push(chunk));
                res.on('end', () => resolve(Buffer.concat(chunks)));
            });

            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('Download timeout')); });
            req.end();
        });
    }

    /**
     * Download a VIDEO by injecting a real <video> element and capturing the
     * response body via CDP Network.getResponseBody.
     *
     * WHY: fetch() sets Sec-Fetch-Dest: empty → server returns JPEG thumbnail.
     *      <video> element sets Sec-Fetch-Dest: video → server returns MP4.
     *      Sec-Fetch-Dest is a FORBIDDEN header — fetch() cannot override it.
     *      Only a real <video> element triggers the server's MP4 proxy mode.
     *
     * @param {string} mediaId - UUID of the media item
     * @returns {Promise<Buffer|null>}
     */
    async downloadVideoViaCDP(mediaId) {
        const tm = this._tokenManager;
        if (!tm?._page || !tm?._cdp) {
            console.warn('[ApiClient] No browser page or CDP — cannot download video');
            return null;
        }

        const page = tm._page;
        const cdp = tm._cdp;

        try {
            console.log(`[ApiClient] downloadVideoViaCDP: injecting <video> for ${mediaId.substring(0, 20)}...`);

            // Build the URL that the <video> element will request
            const videoSrcUrl = this.getVideoDirectUrl(mediaId);

            // Set up a one-shot CDP listener to capture the response
            return await new Promise(async (resolve) => {
                const captured = { requestId: null, resolved: false };
                const timeout = setTimeout(() => {
                    if (!captured.resolved) {
                        captured.resolved = true;
                        console.warn('[ApiClient] downloadVideoViaCDP: timeout (20s)');
                        resolve(null);
                    }
                }, 20000);

                // Listen for the response to our video request
                const onResponse = async (params) => {
                    if (captured.resolved) return;

                    const url = params.response?.url || '';
                    const ct = (params.response?.headers?.['content-type'] ||
                        params.response?.headers?.['Content-Type'] || '').toLowerCase();
                    const status = params.response?.status || 0;

                    // Match: must be our getMediaUrlRedirect request OR a GCS redirect from it
                    const isOurRequest = url.includes(mediaId) ||
                        (url.includes('storage.googleapis.com') && url.includes('ai-sandbox-videofx'));

                    if (!isOurRequest) return;

                    console.log(`[ApiClient] CDP response: status=${status} ct=${ct.substring(0, 30)} url=${url.substring(0, 80)}`);

                    // If content-type is video/* → this is the MP4 stream. Capture it!
                    if (ct.startsWith('video/') || ct.includes('mp4') || ct.includes('webm')) {
                        captured.requestId = params.requestId;
                        // Don't resolve yet — wait for loadingFinished to get full body
                    }

                    // If it's image/jpeg, the server gave us a thumbnail, not video
                    if (ct.includes('image/') && !captured.requestId) {
                        console.warn(`[ApiClient] CDP: server returned ${ct} (thumbnail, not video)`);
                    }
                };

                const onFinished = async (params) => {
                    if (captured.resolved) return;
                    if (params.requestId !== captured.requestId) return;

                    try {
                        const body = await cdp.send('Network.getResponseBody', {
                            requestId: params.requestId,
                        });

                        captured.resolved = true;
                        clearTimeout(timeout);
                        cdp.off('Network.responseReceived', onResponse);
                        cdp.off('Network.loadingFinished', onFinished);

                        if (body.base64Encoded) {
                            const buf = Buffer.from(body.body, 'base64');
                            const isMp4 = buf.slice(4, 8).toString('ascii') === 'ftyp';
                            const isWebM = buf[0] === 0x1A && buf[1] === 0x45;
                            if (isMp4 || isWebM) {
                                console.log(`[ApiClient] ✅ CDP captured ${isMp4 ? 'MP4' : 'WebM'} video (${Math.round(buf.length / 1024)}KB)`);
                                resolve(buf);
                            } else {
                                console.warn(`[ApiClient] CDP body is not video (${buf.length}B, first bytes: ${buf.slice(0, 4).toString('hex')})`);
                                resolve(null);
                            }
                        } else {
                            // Text body (probably error/HTML)
                            console.warn(`[ApiClient] CDP body is text, not binary video`);
                            resolve(null);
                        }
                    } catch (e) {
                        console.warn(`[ApiClient] CDP getResponseBody failed: ${e.message}`);
                        if (!captured.resolved) {
                            captured.resolved = true;
                            clearTimeout(timeout);
                            resolve(null);
                        }
                    }
                };

                // Also handle case where response completes without video content-type
                const onFailed = (params) => {
                    if (captured.resolved) return;
                    const url = params.request?.url || '';
                    if (url.includes(mediaId)) {
                        console.warn(`[ApiClient] CDP request failed: ${params.errorText || 'unknown'}`);
                        // Don't resolve yet — there may be a redirect that succeeds
                    }
                };

                cdp.on('Network.responseReceived', onResponse);
                cdp.on('Network.loadingFinished', onFinished);
                cdp.on('Network.requestFailed', onFailed);

                // Inject <video> element — browser will send Sec-Fetch-Dest: video natively
                await page.evaluate((src) => {
                    const old = document.getElementById('__veo3_video_dl__');
                    if (old) old.remove();

                    const v = document.createElement('video');
                    v.id = '__veo3_video_dl__';
                    v.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;';
                    v.muted = true;
                    v.preload = 'auto';        // ← 'auto' forces full download, not just metadata
                    v.src = src;
                    document.body.appendChild(v);

                    // Force load
                    v.load();

                    // Cleanup after 30s
                    setTimeout(() => { try { v.remove(); } catch (_) { } }, 30000);
                }, videoSrcUrl).catch(() => { });

                // If no video response after 15s, try to capture what we got
                setTimeout(async () => {
                    if (captured.resolved) return;

                    // Check if we captured a non-video response (like JPEG redirect)
                    // and there's no video requestId — clean up and resolve null
                    cdp.off('Network.responseReceived', onResponse);
                    cdp.off('Network.loadingFinished', onFinished);
                    cdp.off('Network.requestFailed', onFailed);

                    // Cleanup video element
                    await page.evaluate(() => {
                        const el = document.getElementById('__veo3_video_dl__');
                        if (el) el.remove();
                    }).catch(() => { });

                    if (!captured.resolved) {
                        captured.resolved = true;
                        clearTimeout(timeout);
                        console.warn('[ApiClient] downloadVideoViaCDP: no video response captured');
                        resolve(null);
                    }
                }, 15000);
            });
        } catch (e) {
            console.warn(`[ApiClient] downloadVideoViaCDP failed: ${e.message}`);
            return null;
        }
    }


    /**
     * Download a video URL using ffmpeg (fluent-ffmpeg + ffmpeg-static).
     * ffmpeg's libav HTTP client sends no Sec-Fetch-* headers, different UA —
     * may succeed where browser fetch() fails.
     *
     * @param {string} url - Video URL (getMediaUrlRedirect or direct GCS)
     * @param {object} [opts]
     * @param {string} [opts.cookies] - Cookie string for authenticated requests
     * @returns {Promise<Buffer|null>}
     */
    async downloadVideoViaFfmpeg(url, opts = {}) {
        const ffmpeg = require('fluent-ffmpeg');
        const ffmpegPath = require('ffmpeg-static');
        const os = require('os');
        const path = require('path');
        const fs = require('fs');

        ffmpeg.setFfmpegPath(ffmpegPath);

        let cookieStr = opts.cookies || '';
        if (!cookieStr) {
            try {
                // Use CDP Network.getCookies — returns ALL cookies including HttpOnly
                // page.cookies() may miss __Secure-next-auth.session-token (HttpOnly + Secure)
                const cdp = this._tokenManager?._cdp;
                if (cdp) {
                    const result = await cdp.send('Network.getCookies', { urls: ['https://labs.google', 'https://accounts.google.com'] });
                    if (result?.cookies?.length) {
                        cookieStr = result.cookies.map(c => `${c.name}=${c.value}`).join('; ');
                        const hasSession = result.cookies.some(c => c.name.includes('session-token'));
                        console.log(`[ApiClient] Got ${result.cookies.length} cookies via CDP (hasSession=${hasSession})`);
                    }
                }
                // Fallback to page.cookies()
                if (!cookieStr && this._tokenManager?._page) {
                    const cookies = await this._tokenManager._page.cookies('https://labs.google');
                    cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
                }
            } catch (_) { }
        }

        const tmpFile = path.join(os.tmpdir(), `veo3_ffmpeg_${Date.now()}.mp4`);

        try {
            console.log(`[ApiClient] ffmpeg download: ${url.substring(0, 80)}...`);

            await new Promise((resolve, reject) => {
                // IMPORTANT: Each option flag and value must be separate array items.
                // ffmpeg-static's arg parser cannot handle '-flag "value with spaces"' as one string.
                const inputOpts = [
                    '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
                    '-referer', 'https://labs.google/fx/vi/tools/flow/',
                    '-loglevel', 'warning',   // suppress verbose output
                ];
                if (cookieStr) {
                    // Cookie format for ffmpeg: "name=value; name2=value2"
                    const safe = cookieStr.split('\n').join('');
                    inputOpts.push('-cookies', safe);
                }

                ffmpeg()
                    .input(url)
                    .inputOptions(inputOpts)
                    .videoCodec('copy')
                    .audioCodec('copy')
                    .format('mp4')
                    .on('start', (cmd) => console.log(`[ApiClient] ffmpeg: ${cmd.substring(0, 200)}`))
                    .on('error', (err) => { console.warn(`[ApiClient] ffmpeg error: ${err.message}`); reject(err); })
                    .on('end', resolve)
                    .save(tmpFile);
            });

            if (!fs.existsSync(tmpFile)) return null;
            const buf = fs.readFileSync(tmpFile);
            try { fs.unlinkSync(tmpFile); } catch (_) { }

            if (buf.length < 10000) {
                console.warn(`[ApiClient] ffmpeg output too small (${buf.length}B) — not a video`);
                return null;
            }
            const isMp4 = buf.slice(4, 8).toString('ascii') === 'ftyp';
            const isWebM = buf[0] === 0x1A && buf[1] === 0x45;
            if (isMp4 || isWebM) {
                console.log(`[ApiClient] ✅ ffmpeg captured ${isMp4 ? 'MP4' : 'WebM'} (${Math.round(buf.length / 1024)}KB)`);
                return buf;
            }
            console.warn(`[ApiClient] ffmpeg not video (bytes: ${buf.slice(0, 8).toString('hex')})`);
            return null;
        } catch (e) {
            console.warn(`[ApiClient] downloadVideoViaFfmpeg failed: ${e.message}`);
            if (fs.existsSync(tmpFile)) { try { fs.unlinkSync(tmpFile); } catch (_) { } }
            return null;
        }
    }


    /**
     * Download video via browser FileReader — mirrors the classic Puppeteer approach:
     *   fetch(url, {credentials:'include'}) → blob → FileReader → base64 → Buffer
     *
     * @param {string} url - URL accessible from labs.google page context
     * @returns {Promise<Buffer|null>}
     */
    async downloadVideoViaBrowser(url) {
        const page = this._tokenManager?._page;
        if (!page) return null;

        try {
            console.log(`[ApiClient] Browser FileReader: ${url.substring(0, 80)}...`);

            const result = await page.evaluate(async (videoUrl) => {
                try {
                    const res = await fetch(videoUrl, { credentials: 'include' });
                    if (!res.ok) return { error: `HTTP ${res.status}` };
                    const blob = await res.blob();
                    return await new Promise((resolve, reject) => {
                        const reader = new FileReader();
                        reader.onloadend = () => resolve({ b64: reader.result.split(',')[1], ct: blob.type });
                        reader.onerror = () => reject(new Error('FileReader error'));
                        reader.readAsDataURL(blob);
                    });
                } catch (e) { return { error: e.message }; }
            }, url);

            if (result?.error) {
                console.warn(`[ApiClient] FileReader error: ${result.error}`);
                return null;
            }
            if (!result?.b64) return null;

            const buf = Buffer.from(result.b64, 'base64');
            const isMp4 = buf.slice(4, 8).toString('ascii') === 'ftyp';
            const isWebM = buf[0] === 0x1A && buf[1] === 0x45;
            if (isMp4 || isWebM) {
                console.log(`[ApiClient] ✅ FileReader: ${result.ct} (${Math.round(buf.length / 1024)}KB)`);
                return buf;
            }
            console.warn(`[ApiClient] FileReader: got ${result.ct} (not video, ${buf.length}B)`);
            return null;
        } catch (e) {
            console.warn(`[ApiClient] downloadVideoViaBrowser failed: ${e.message}`);
            return null;
        }
    }


    /**
     * Probe ALL getMediaUrlRedirect URL types from inside the authenticated browser.
     * This definitively finds which type returns actual video (not JPEG thumbnail).
     *
     * @param {string} mediaId
     * @returns {Promise<Array<{type, status, ct, finalUrl, size, isVideo, isImage}>>}
     */
    async probeVideoUrlTypes(mediaId) {
        const page = this._tokenManager?._page;
        if (!page) return [];

        const types = [
            'MEDIA_URL_TYPE_THUMBNAIL',
            'MEDIA_URL_TYPE_ORIGINAL',
            'MEDIA_URL_TYPE_DOWNLOAD',
            'MEDIA_URL_TYPE_STREAM',
            'MEDIA_URL_TYPE_HLS',
            'MEDIA_URL_TYPE_VIDEO',
            'MEDIA_URL_TYPE_PLAYBACK',
        ];

        try {
            const results = await page.evaluate(async (mId, urlTypes) => {
                const out = [];
                for (const t of urlTypes) {
                    const url = `https://labs.google/fx/api/trpc/media.getMediaUrlRedirect?name=${encodeURIComponent(mId)}&mediaUrlType=${t}`;
                    try {
                        const res = await fetch(url, { credentials: 'include' });
                        const arr = await res.arrayBuffer();
                        const u8 = new Uint8Array(arr.slice(0, 16));
                        const hex = Array.from(u8.slice(0, 8)).map(b => b.toString(16).padStart(2, '0')).join('');
                        const ct = res.headers.get('content-type') || '';
                        out.push({
                            type: t,
                            status: res.status,
                            ct,
                            finalUrl: res.url,
                            size: arr.byteLength,
                            isVideo: ct.startsWith('video/') || ct.includes('mp4') || ct.includes('webm'),
                            isImage: ct.startsWith('image/'),
                            hex,
                        });
                    } catch (e) {
                        out.push({ type: t, error: e.message });
                    }
                }
                return out;
            }, mediaId, types);

            // Log probe results to console
            console.log(`\n[ApiClient] === URL Type Probe for ${mediaId.substring(0, 16)}... ===`);
            for (const r of results) {
                if (r.error) {
                    console.log(`  [${r.type.replace('MEDIA_URL_TYPE_', '').padEnd(10)}] ERROR: ${r.error}`);
                } else {
                    const flag = r.isVideo ? '✅ VIDEO' : r.isImage ? '📷 JPEG ' : '      ? ';
                    const furl = (r.finalUrl || '').replace('https://storage.googleapis.com/ai-sandbox-videofx/', 'gcs/').substring(0, 70);
                    console.log(`  [${r.type.replace('MEDIA_URL_TYPE_', '').padEnd(10)}] ${flag} status=${r.status} size=${r.size}B ct=${(r.ct || '').substring(0, 20)} → ${furl}`);
                }
            }
            console.log('[ApiClient] ===================================\n');
            return results;
        } catch (e) {
            console.warn(`[ApiClient] probeVideoUrlTypes failed: ${e.message}`);
            return [];
        }
    }


    /**
     * Return the direct getMediaUrlRedirect URL for a given media ID.
     * This URL, when used as <video src> in an authenticated browser, streams MP4 content.
     */
    getVideoDirectUrl(mediaId) {
        return `${LABS_BASE}/fx/api/trpc/media.getMediaUrlRedirect` +
            `?name=${encodeURIComponent(mediaId)}&mediaUrlType=MEDIA_URL_TYPE_THUMBNAIL`;
    }


    /**
     * Capture the REAL video URL by navigating to the project page and
     * hovering the video card. The Labs UI naturally uses the correct URL type
     * which the browser fetches as a proper video stream (not JPEG thumbnail).
     *
     * Pipeline:
     *   1. Open project page in current (authenticated) tab
     *   2. Wait for the specific video card to appear
     *   3. Hover it → triggers browser to load video preview
     *   4. CDP Network intercepts the video/mp4 response & captures the URL
     *   5. Download that GCS URL directly (no auth needed on signed GCS URLs)
     *
     * @param {string} mediaId   - UUID of the media
     * @param {string} projectId - project UUID
     * @returns {Promise<string|null>} - The GCS video URL, or null
     */
    async captureVideoUrlFromProjectPage(mediaId, projectId) {
        const page = this._tokenManager?._page;
        const tm = this._tokenManager;
        if (!page || !tm) return null;

        const projectUrl = `${LABS_BASE}/fx/vi/tools/flow?project_id=${encodeURIComponent(projectId || '')}`;
        const cdp = tm._cdp;
        if (!cdp) return null;

        return new Promise(async (resolve) => {
            let resolved = false;
            const finish = (url) => {
                if (resolved) return;
                resolved = true;
                clearTimeout(timer);
                resolve(url);
            };

            const timer = setTimeout(() => finish(null), 30000);

            // Listen for video/mp4 responses from GCS
            const onResponse = (params) => {
                const ct = params.response.headers['content-type'] || params.response.headers['Content-Type'] || '';
                const url = params.response.url;
                if ((ct.startsWith('video/') || ct.includes('mp4')) && url.includes(mediaId)) {
                    console.log(`[ApiClient] ✅ Real video URL captured from project page: ${url.substring(0, 80)}`);
                    cdp.removeListener('Network.responseReceived', onResponse);
                    finish(url);
                }
            };
            cdp.on('Network.responseReceived', onResponse);

            try {
                // Navigate to project page
                console.log(`[ApiClient] Navigating to project page for ${mediaId.substring(0, 16)}...`);
                await page.goto(projectUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => { });
                await new Promise(r => setTimeout(r, 3000));

                // Find the video card for this specific mediaId
                // Labs renders data-media-id or data-generation-id attributes on cards
                const card = await page.$(`[data-media-id="${mediaId}"], [data-generation-id="${mediaId}"], [href*="${mediaId}"]`)
                    .catch(() => null);

                if (card) {
                    console.log(`[ApiClient] Found video card for ${mediaId.substring(0, 16)}, hovering...`);
                    await card.hover().catch(() => { });
                    await new Promise(r => setTimeout(r, 2000));
                    await card.click().catch(() => { });
                } else {
                    // Fallback: hover all video cards to trigger loading
                    console.log(`[ApiClient] No specific card found, hovering first video element...`);
                    const videos = await page.$$('video, [data-testid*="video"], [class*="video-card"]').catch(() => []);
                    for (const v of videos.slice(0, 3)) {
                        await v.hover().catch(() => { });
                        await new Promise(r => setTimeout(r, 1000));
                    }
                }
            } catch (e) {
                console.warn(`[ApiClient] captureVideoUrlFromProjectPage nav error: ${e.message}`);
            }
        });
    }


    /**
     * Pure-API video URL extraction via flow.projectInitialData tRPC endpoint.
     *
     * When the editor page (/project/{projectId}/edit/{workflowId}) loads,
     * the Flow app fires a tRPC GET to `flow.projectInitialData` with the
     * project + workflow IDs in the query string. The server returns the full
     * project state including a signed GCS video URL for every clip.
     *
     * We replicate that call here — no browser navigation required.
     *
     * @param {string} mediaId   - UUID of the media clip
     * @param {string} projectId - project UUID
     * @param {string} workflowId - workflow UUID (= the "edit" segment of the URL)
     * @returns {Promise<{url:string|null, tRPCCalls:string[]}>}
     */
    async downloadVideoViaWorkflowPage(mediaId, projectId, workflowId) {
        const tRPCCalls = ['flow.projectInitialData'];
        let videoUrl = null;

        // ── Strategy 1: Pure tRPC API call ───────────────────────────────
        // Replicates the XHR that Flow fires when you open the editor page.
        // Returns a signed GCS URL valid for ~15–30 min.
        try {
            console.log(`[ApiClient] 🔗 Calling flow.projectInitialData API for ${mediaId.substring(0, 8)}...`);
            videoUrl = await this._fetchVideoUrlViaProjectInitialData(projectId, workflowId, mediaId);
            if (videoUrl) {
                console.log(`[ApiClient] ✅ Pure API: got signed GCS URL from flow.projectInitialData`);
            }
        } catch (e) {
            console.warn(`[ApiClient] flow.projectInitialData failed: ${e.message}`);
        }

        // ── Strategy 2: Puppeteer navigation fallback ────────────────────
        // Only used if the API call above fails (e.g. tRPC schema change).
        // Opens a temporary background tab so the main UX is undisturbed.
        if (!videoUrl) {
            const page = this._tokenManager?._page;
            const browser = page?.browser ? page.browser() : null;
            if (browser) {
                console.log(`[ApiClient] 🌐 API failed — falling back to background tab navigation...`);

                let bgPage = null;
                let bgCdp = null;
                try {
                    bgPage = await browser.newPage();
                    bgCdp = await bgPage.createCDPSession();

                    const onResponse = (params) => {
                        const ct = params.response.headers['content-type'] || params.response.headers['Content-Type'] || '';
                        const u = params.response.url;
                        if ((ct.startsWith('video/') || ct.includes('mp4'))
                            && !videoUrl && !u.includes('gstatic.com')
                            && u.includes('storage.googleapis')
                            && (!mediaId || u.includes(mediaId))) {
                            console.log(`[ApiClient] ✅ VIDEO intercepted via CDP (Background): ${u.substring(0, 100)}`);
                            videoUrl = u;
                        }
                    };
                    bgCdp.on('Network.responseReceived', onResponse);

                    const editorUrl = projectId && workflowId
                        ? `${LABS_BASE}/fx/vi/tools/flow/project/${projectId}/edit/${workflowId}`
                        : null;

                    if (editorUrl) {
                        console.log(`[ApiClient] 🌐 Navigating invisible background tab to: ${editorUrl}`);
                        await bgPage.goto(editorUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => { });

                        let waited = 0;
                        while (!videoUrl && waited < 15) {
                            await new Promise(r => setTimeout(r, 1000));
                            waited++;
                            if (videoUrl) break;
                        }
                    }
                } catch (e) {
                    console.warn(`[ApiClient] Background tab nav error: ${e.message}`);
                } finally {
                    if (bgCdp) await bgCdp.detach().catch(() => { });
                    if (bgPage) await bgPage.close().catch(() => { });
                }
            }
        }

        return { url: videoUrl, tRPCCalls };
    }

    /**
     * Call the `flow.projectInitialData` tRPC endpoint — the same request
     * that the Labs Flow editor makes on page load to hydrate the project.
     * Walks the JSON tree to find the signed GCS video URL for the given
     * mediaId.
     *
     * @param {string} projectId
     * @param {string} workflowId
     * @returns {Promise<string|null>} signed GCS video URL, or null
     */
    async _fetchVideoUrlViaProjectInitialData(projectId, workflowId, mediaId) {
        const page = this._tokenManager?._page;
        const cdp = this._tokenManager?._cdp;
        if (!page || !cdp) throw new Error('No browser context available');

        const editorUrl = projectId && workflowId
            ? `${LABS_BASE}/fx/vi/tools/flow/project/${projectId}/edit/${workflowId}`
            : null;

        if (!editorUrl) return null;

        // ── Intercept the GCS video response that the iframe triggers ──
        let capturedVideoUrl = null;
        const onResponse = (params) => {
            const ct = params.response.headers['content-type'] || params.response.headers['Content-Type'] || '';
            const u = params.response.url;
            if ((ct.startsWith('video/') || ct.includes('mp4') || ct.includes('webm'))
                && !capturedVideoUrl && !u.includes('gstatic.com')
                && u.includes('storage.googleapis')
                && (!mediaId || u.includes(mediaId))) {
                console.log(`[ApiClient] 📡 CDP intercepted GCS video from iframe: ${u.substring(0, 100)}`);
                capturedVideoUrl = u;
            }
        };
        cdp.on('Network.responseReceived', onResponse);

        try {
            console.log(`[ApiClient] 🔗 Injecting invisible iframe to load Editor: ${editorUrl.substring(0, 80)}...`);

            // Inject invisible iframe to load the editor securely in the background
            // This forces the React frontend to naturally fire the correct tRPC queries
            // and natively resolve the signed GCS video stream without disrupting the UI.
            await page.evaluate((url) => {
                return new Promise((resolve) => {
                    const iframe = document.createElement('iframe');
                    iframe.id = 'veo3-hidden-extractor';
                    iframe.style.position = 'absolute';
                    iframe.style.width = '1px';
                    iframe.style.height = '1px';
                    iframe.style.top = '-9999px';
                    iframe.style.left = '-9999px';
                    iframe.style.opacity = '0';
                    iframe.style.pointerEvents = 'none';
                    iframe.src = url;
                    document.body.appendChild(iframe);
                    // Resolve immediately so Node can wait for CDP
                    setTimeout(resolve, 500);
                });
            }, editorUrl).catch(() => { });

            // Wait up to 15s for the CDP video intercept
            let waited = 0;
            while (!capturedVideoUrl && waited < 15) {
                await new Promise(r => setTimeout(r, 1000));
                waited++;
            }

            // Cleanup iframe
            await page.evaluate(() => {
                const frame = document.getElementById('veo3-hidden-extractor');
                if (frame) frame.remove();
            }).catch(() => { });

            if (capturedVideoUrl) {
                console.log(`[ApiClient] ✅ Extracted GCS URL cleanly via invisible iframe`);
                return capturedVideoUrl;
            }

            return null;
        } finally {
            cdp.off('Network.responseReceived', onResponse);
        }
    }

    /**
     * Recursively walk a JSON object to find a signed GCS video URL.
     * If mediaId is provided, prefers URLs whose path contains the mediaId.
     *
     * @param {*}       obj     - arbitrary JSON value to search
     * @param {string|null} mediaId - target clip ID (null = return first hit)
     * @param {string}  gcsBase - URL prefix to match
     * @param {number}  depth   - recursion guard
     * @returns {string|null}
     */
    _findGcsVideoUrl(obj, mediaId, gcsBase, depth = 0) {
        if (depth > 20 || obj === null || obj === undefined) return null;
        if (typeof obj === 'string') {
            if (obj.startsWith(gcsBase)) {
                if (!mediaId || obj.includes(mediaId)) return obj;
            }
            return null;
        }
        if (Array.isArray(obj)) {
            let fallback = null;
            for (const item of obj) {
                const found = this._findGcsVideoUrl(item, mediaId, gcsBase, depth + 1);
                if (found) {
                    if (!mediaId || found.includes(mediaId)) return found; // exact match
                    if (!fallback) fallback = found;                        // save as fallback
                }
            }
            return fallback;
        }
        if (typeof obj === 'object') {
            let fallback = null;
            for (const val of Object.values(obj)) {
                const found = this._findGcsVideoUrl(val, mediaId, gcsBase, depth + 1);
                if (found) {
                    if (!mediaId || found.includes(mediaId)) return found;
                    if (!fallback) fallback = found;
                }
            }
            return fallback;
        }
        return null;
    }

    /**
     * Download video by navigating to labs.google edit page and fetching
     * the video from the already-loaded <video> element's currentSrc or blob URL.
     * The browser naturally handles auth + correct streaming headers.
     *
     * @param {string} editLink - labs.google/fx/vi/tools/flow/edit/UUID URL
     * @param {string} mediaId  - UUID of the media
     * @returns {Promise<Buffer|null>}
     */
    async downloadVideoViaEditPage(editLink, mediaId) {
        const page = this._tokenManager?._page;
        if (!page || !editLink) return null;

        const os = require('os');
        const path = require('path');
        const fs = require('fs');

        try {
            console.log(`[ApiClient] Fetching video via edit page: ${editLink.substring(0, 70)}...`);

            // Find or open the edit page in a new tab (avoids disrupting main page)
            const browser = page.browser ? page.browser() : null;
            if (!browser) return null;

            const editPage = await browser.newPage();
            let buf = null;

            try {
                // Set download to temp dir just in case native download is triggered
                const tmpDir = path.join(os.tmpdir(), 'veo3_dl');
                if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

                const editCdp = await editPage.createCDPSession();
                await editCdp.send('Page.setDownloadBehavior', {
                    behavior: 'allow', downloadPath: tmpDir,
                }).catch(() => { });

                // Navigate to edit page
                await editPage.goto(editLink, { waitUntil: 'domcontentloaded', timeout: 20000 });

                // Wait for video to be loadable
                await new Promise(r => setTimeout(r, 4000));

                // Download via browser fetch from the edit page context (has full auth session)
                buf = await editPage.evaluate(async (mId) => {
                    // Find <video> elements and their src/currentSrc
                    const videos = document.querySelectorAll('video');
                    let videoSrc = null;

                    for (const v of videos) {
                        const src = v.currentSrc || v.src || '';
                        if (src && src.startsWith('http') && src.length > 30) {
                            videoSrc = src;
                            break;
                        }
                        // If blob URL, we can fetch it directly
                        if (src && src.startsWith('blob:')) {
                            videoSrc = src;
                            break;
                        }
                    }

                    // Fallback: try mediaUrlRedirect with Range (from browser context, correct Sec-Fetch headers)
                    if (!videoSrc) {
                        videoSrc = `https://labs.google/fx/api/trpc/media.getMediaUrlRedirect?name=${mId}&mediaUrlType=MEDIA_URL_TYPE_THUMBNAIL`;
                    }

                    try {
                        const res = await fetch(videoSrc, {
                            credentials: 'include',
                            headers: { 'Range': 'bytes=0-' },
                        });

                        if (!res.ok && res.status !== 206) return null;
                        const ct = res.headers.get('content-type') || '';
                        if (ct.includes('text/html') || ct.includes('application/json')) return null;

                        const ab = await res.arrayBuffer();
                        // Convert to base64 in chunks to avoid string size limits
                        const bytes = new Uint8Array(ab);
                        const CHUNK = 32768;
                        let binary = '';
                        for (let i = 0; i < bytes.length; i += CHUNK) {
                            binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
                        }
                        return { base64: btoa(binary), contentType: ct, size: bytes.length };
                    } catch (e) {
                        return { error: e.message };
                    }
                }, mediaId);

                if (buf && buf.base64) {
                    const data = Buffer.from(buf.base64, 'base64');
                    const isMp4 = data.slice(4, 8).toString('ascii') === 'ftyp';
                    const isWebM = data[0] === 0x1A && data[1] === 0x45;
                    if (isMp4 || isWebM) {
                        console.log(`[ApiClient] ✅ Edit page download: ${buf.contentType} (${Math.round(data.length / 1024)}KB)`);
                        buf = data;
                    } else {
                        const isJpeg = data[0] === 0xFF && data[1] === 0xD8;
                        console.warn(`[ApiClient] ⚠️ Edit page got ${isJpeg ? 'JPEG' : 'unknown'} (${data.length} bytes)`);
                        buf = null;
                    }
                } else {
                    if (buf?.error) console.warn(`[ApiClient] ⚠️ Edit page fetch error: ${buf.error}`);
                    buf = null;
                }

                await editCdp.detach().catch(() => { });
            } finally {
                await editPage.close().catch(() => { });
            }

            return buf;
        } catch (e) {
            console.warn(`[ApiClient] downloadVideoViaEditPage failed: ${e.message}`);
            return null;
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  RECAPTCHA
    // ═══════════════════════════════════════════════════════════════

    /**
     * Get a reCAPTCHA Enterprise token directly via Puppeteer CDP.
     * Calls grecaptcha.enterprise.execute() in the authenticated browser page.
     * Rate-limited: enforces a 10s minimum gap to avoid UNUSUAL_ACTIVITY flags.
     *
     * @param {string} [action='IMAGE_GENERATION'] - reCAPTCHA action name
     */
    async getRecaptchaToken(action = 'IMAGE_GENERATION') {
        if (typeof this._tokenManager?.getRecaptchaToken !== 'function') {
            console.warn('[ApiClient] No recaptcha source available');
            return null;
        }
        // Timing/rotation is fully managed inside TokenManager.getRecaptchaToken()
        return this._tokenManager.getRecaptchaToken(action);
    }


    /**
     * Build the clientContext object used in generate requests
     */
    async _buildClientContext(projectId, recaptchaAction = 'IMAGE_GENERATION') {
        const recaptchaToken = await this.getRecaptchaToken(recaptchaAction);

        return {
            recaptchaContext: recaptchaToken ? {
                token: recaptchaToken,
                applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB',
            } : undefined,
            projectId: projectId || this._projectId,
            tool: TOOL_NAME,
            sessionId: this._sessionId,
        };
    }

    // ═══════════════════════════════════════════════════════════════
    //  AUTH & SESSION
    // ═══════════════════════════════════════════════════════════════

    /**
     * Get auth session (alternative token source + user info)
     * GET /fx/api/auth/session
     */
    async getAuthSession() {
        const res = await this._labsRequest('GET', '/fx/api/auth/session');
        return res.body;
        // Returns: { user: { name, email, image }, expires, access_token }
    }

    // ═══════════════════════════════════════════════════════════════
    //  CREDITS
    // ═══════════════════════════════════════════════════════════════

    /**
     * Check remaining credits
     * GET /v1/credits?key=...
     */
    async getCredits() {
        const res = await this._apiRequest('GET', `/v1/credits?key=${API_KEY}`);
        return res.body;
    }

    // ═══════════════════════════════════════════════════════════════
    //  PROJECTS
    // ═══════════════════════════════════════════════════════════════

    /**
     * Search user projects
     */
    async searchProjects(pageSize = 20) {
        const input = JSON.stringify({
            json: { pageSize, toolName: TOOL_NAME, cursor: null },
            meta: { values: { cursor: ['undefined'] } },
        });
        const res = await this._labsRequest('GET',
            `/fx/api/trpc/project.searchUserProjects?input=${encodeURIComponent(input)}`
        );
        return res.body.result.data.json.result;
    }

    /**
     * Get project initial data (models, credits, settings, existing media)
     */
    async getProjectData(projectId) {
        const pid = projectId || this._projectId;
        const input = JSON.stringify({ json: { projectId: pid } });
        const res = await this._labsRequest('GET',
            `/fx/api/trpc/flow.projectInitialData?input=${encodeURIComponent(input)}`
        );
        const data = res.body.result.data.json;

        // Cache model config and user data
        this._modelConfig = data.modelConfig;
        if (data.userData) {
            this._userTier = data.userData.serviceTier || this._userTier;
            this._paygateTier = data.userData.paygateTier || this._paygateTier;
        }

        return data;
    }

    /**
     * Create a new project with a timestamped name.
     * Returns the new projectId.
     */
    async createProject(title) {
        const now = new Date();
        const projectTitle = title || now.toLocaleString('en-US', {
            month: 'short', day: '2-digit',
            hour: '2-digit', minute: '2-digit', hour12: true,
        }).replace(',', ''); // e.g. "Apr 16, 10:03 AM"

        const res = await this._labsRequest('POST', '/fx/api/trpc/project.createProject', {
            json: { projectTitle, toolName: TOOL_NAME },
        });
        const projectId = res.body.result.data.json.result.projectId;
        this._projectId = projectId;

        // Load model config for the new project
        await this.getProjectData(projectId);

        this.emit('project:ready', projectId);
        console.log(`[ApiClient] ✅ New project created: ${projectTitle} (${projectId})`);
        return projectId;
    }

    /**
     * Ensure we have a project to work with.
     * Always creates a fresh project on first call (unless options.reuseProject is set).
     */
    async ensureProject() {
        if (this._projectId) return this._projectId;

        if (this._options?.reuseProject) {
            // Legacy mode: reuse the most recent existing project
            const projects = await this.searchProjects(1);
            if (projects.projects && projects.projects.length > 0) {
                this._projectId = projects.projects[0].projectId;
                await this.getProjectData(this._projectId);
                this.emit('project:ready', this._projectId);
                return this._projectId;
            }
        }

        // Default: create a fresh project for this session
        return this.createProject();
    }

    // ═══════════════════════════════════════════════════════════════
    //  IMAGE UPLOAD
    // ═══════════════════════════════════════════════════════════════

    /**
     * Upload a local image file to the Flow project.
     * Returns a mediaId that can be used as:
     *   - imageInputs: [mediaId]       (image reference for generation)
     *   - startImageId: mediaId        (first frame for i2v)
     *   - referenceImages: [mediaId]   (style/scene reference for r2v)
     *
     * @param {string|Buffer} source - Absolute file path OR a Buffer of image bytes
     * @param {string} [mimeType='image/jpeg'] - MIME type hint (used for content-type metadata)
     * @returns {Promise<string>} mediaId of the uploaded image
     */
    async uploadImage(source, mimeType = 'image/jpeg') {
        const fs = require('fs');
        const path = require('path');
        const projectId = await this.ensureProject();

        let imageBuffer;
        if (typeof source === 'string') {
            // File path
            const resolved = path.resolve(source);
            if (!fs.existsSync(resolved)) throw new Error(`uploadImage: file not found: ${resolved}`);
            imageBuffer = fs.readFileSync(resolved);
            // Auto-detect mime from extension if not specified
            const ext = path.extname(resolved).toLowerCase();
            if (ext === '.png') mimeType = 'image/png';
            else if (ext === '.webp') mimeType = 'image/webp';
            else if (ext === '.gif') mimeType = 'image/gif';
        } else if (Buffer.isBuffer(source)) {
            imageBuffer = source;
        } else {
            throw new Error('uploadImage: source must be a file path string or Buffer');
        }

        const imageBytes = imageBuffer.toString('base64');
        console.log(`[ApiClient] Uploading image (${Math.round(imageBuffer.length / 1024)}KB, ${mimeType})...`);

        const res = await this._apiRequest('POST', '/v1/flow/uploadImage', {
            clientContext: { projectId, tool: TOOL_NAME },
            imageBytes,
        });

        const mediaId = res.body?.media?.name;
        if (!mediaId) throw new Error(`uploadImage: no mediaId in response: ${JSON.stringify(res.body).substring(0, 200)}`);

        console.log(`[ApiClient] ✅ Image uploaded: ${mediaId}`);
        return mediaId;
    }

    // ═══════════════════════════════════════════════════════════════
    //  IMAGE GENERATION (Synchronous)
    // ═══════════════════════════════════════════════════════════════

    /**
     * Generate an image via direct API call.
     *
     * Requires the captcha-solver service to be running (https://github.com/dlir2404/captcha-solver)
     * which provides a high-score reCAPTCHA token from a real Chrome browser.
     * If the solver is not available, falls back to the Puppeteer token (may be blocked).
     *
     * @param {string} prompt - Text prompt
     * @param {object} options
     * @param {string} [options.model='nano_banana_2'] - Model family key
     * @param {string} [options.aspectRatio='16:9'] - Aspect ratio
     * @param {number} [options.seed] - Random seed (auto-generated if omitted)
     * @param {string[]} [options.imageInputs] - Reference image media IDs
     * @returns {Promise<object>} - { media, workflows }
     */
    /**
     * Generate one or more images in a single batch API call.
     *
     * @param {string} prompt
     * @param {object} options
     * @param {string} [options.model='nano_banana_2']  - Image model key
     * @param {string} [options.aspectRatio='16:9']     - Aspect ratio
     * @param {number} [options.seed]                   - Base seed (each image gets seed+i)
     * @param {number} [options.count=1]                - How many images to generate (1-4)
     * @param {Array}  [options.imageInputs=[]]         - Reference image media IDs
     * @returns {Promise<object>} - { media: [...] }
     */
    async generateImage(prompt, options = {}) {
        const projectId = await this.ensureProject();
        const clientContext = await this._buildClientContext(projectId);

        const modelKey = IMAGE_MODELS[options.model || 'nano_banana_2'] || options.model || 'NARWHAL';
        const aspectRatio = IMAGE_ASPECT_RATIOS[options.aspectRatio || '16:9'] || options.aspectRatio || 'IMAGE_ASPECT_RATIO_LANDSCAPE';
        const baseSeed = options.seed || Math.floor(Math.random() * 200000);
        const batchId = crypto.randomUUID();
        const count = Math.max(1, Math.min(options.count || 1, 4)); // 1–4 images per batch

        const rawInputs = options.imageInputs || options.referenceImages || [];
        const imageInputs = rawInputs.map(id =>
            typeof id === 'string' ? { name: id } : id
        );

        // Build one request entry per image (different seed each time)
        const requests = Array.from({ length: count }, (_, i) => ({
            clientContext,
            imageModelName: modelKey,
            imageAspectRatio: aspectRatio,
            structuredPrompt: { parts: [{ text: prompt }] },
            seed: baseSeed + i,
            imageInputs,
        }));

        const body = {
            clientContext,
            mediaGenerationContext: { batchId },
            useNewMedia: true,
            requests,
        };

        this.emit('image:generating', { prompt, model: modelKey, aspectRatio, seed: baseSeed, count });

        // Generate calls yêu cầu reCAPTCHA và PHẢI đi qua browser context (labs.google origin)
        // Node.js HTTP request trực tiếp bị block bởi reCAPTCHA Enterprise ngay cả khi có token hợp lệ
        const token = await this._tokenManager.getToken();
        const url = `${API_BASE}/v1/projects/${projectId}/flowMedia:batchGenerateImages`;
        const res = await this._browserFetch('POST', url, token, body, 'IMAGE_GENERATION');

        const result = res.body;
        this.emit('image:complete', result);
        return result;
    }

    // ─── UI Automation Helpers ─────────────────────────────────────

    /**
     * Navigate into a project in the Flow UI
     */
    async _ensureInProject(page, projectId) {
        const currentUrl = page.url();

        // Already in a project if URL contains project ID or we're on the editor
        if (currentUrl.includes(projectId) || currentUrl.includes('/editor')) {
            return;
        }

        // Check if we're on the project list — click the first project tile
        const inProject = await page.evaluate(() => {
            // Check if there's a textarea (means we're already in the editor)
            if (document.querySelector('textarea')) return true;

            // Click the first project tile 
            const projectTile = document.querySelector('[class*="project"] a, [class*="Project"] a, a[href*="project"]');
            if (projectTile) { projectTile.click(); return 'clicked'; }

            // Click "Dự án mới" (New project) button
            const newBtn = Array.from(document.querySelectorAll('button')).find(b =>
                b.textContent?.includes('Dự án mới') || b.textContent?.includes('New project')
            );
            if (newBtn) { newBtn.click(); return 'new_project'; }

            return false;
        });

        if (inProject !== true) {
            // Wait for navigation to complete
            await page.waitForSelector('textarea', { timeout: 15000 });
            await new Promise(r => setTimeout(r, 2000));
        }
    }

    /**
     * Select Image or Video tab
     */
    async _selectTab(page, tabType) {
        await page.evaluate((type) => {
            const tabs = document.querySelectorAll('[role="tab"], button');
            for (const tab of tabs) {
                const text = tab.textContent?.toLowerCase();
                if (type === 'image' && (text?.includes('hình ảnh') || text?.includes('image'))) {
                    tab.click(); return;
                }
                if (type === 'video' && (text?.includes('video'))) {
                    tab.click(); return;
                }
            }
        }, tabType);
        await new Promise(r => setTimeout(r, 500));
    }

    /**
     * Type a prompt into the Flow UI textarea
     */
    async _typePrompt(page, prompt) {
        // Clear and type into the textarea
        await page.evaluate((text) => {
            const textarea = document.querySelector('textarea');
            if (!textarea) throw new Error('No textarea found');

            // Focus and clear
            textarea.focus();
            textarea.value = '';

            // Use native setter for React compatibility
            const nativeSetter = Object.getOwnPropertyDescriptor(
                window.HTMLTextAreaElement.prototype, 'value'
            ).set;
            nativeSetter.call(textarea, text);

            // Dispatch events React listens to
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            textarea.dispatchEvent(new Event('change', { bubbles: true }));
        }, prompt);
    }

    /**
     * Click the generate button in the Flow UI
     */
    async _clickGenerate(page) {
        const clicked = await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button'));

            // Look for the submit/generate button (usually has an arrow icon or "Tạo" text)
            // In Google Flow, the generate button is typically identified by its icon or position
            for (const btn of buttons) {
                const text = btn.textContent?.trim();
                const aria = btn.getAttribute('aria-label') || '';

                // Match various generate button identifiers
                if (text?.includes('arrow_forward') || text?.includes('→') ||
                    aria.includes('Tạo') || aria.includes('Generate') || aria.includes('Submit') ||
                    text?.includes('Tạo') || text?.includes('Generate')) {
                    btn.click();
                    return { clicked: true, text: text?.substring(0, 30) };
                }
            }

            // Fallback: find the button near the textarea
            const textarea = document.querySelector('textarea');
            if (textarea) {
                const container = textarea.closest('form') || textarea.closest('[class*="prompt"]') || textarea.parentElement?.parentElement?.parentElement;
                if (container) {
                    const btns = container.querySelectorAll('button');
                    const lastBtn = btns[btns.length - 1];
                    if (lastBtn) {
                        lastBtn.click();
                        return { clicked: true, text: lastBtn.textContent?.trim()?.substring(0, 30), fallback: true };
                    }
                }
            }

            return { clicked: false };
        });

        if (!clicked.clicked) {
            throw new Error('Could not find generate button in the Flow UI');
        }
    }

    /**
     * Generate multiple images (one request per image with different seeds)
     */
    async generateImages(prompt, count = 1, options = {}) {
        const results = [];
        const INTER_CALL_DELAY_MS = 3000; // 3s gap between sequential image calls to avoid burst 429
        for (let i = 0; i < count; i++) {
            if (i > 0) {
                await new Promise(r => setTimeout(r, INTER_CALL_DELAY_MS));
            }
            const seed = options.seed ? options.seed + i : Math.floor(Math.random() * 200000);
            const result = await this.generateImage(prompt, { ...options, seed });
            results.push(result);
        }
        return results;
    }

    // ═══════════════════════════════════════════════════════════════
    //  VIDEO GENERATION (Asynchronous — start + poll)
    // ═══════════════════════════════════════════════════════════════

    /**
     * Resolve the correct video model key based on family, type, aspect ratio, and tier.
     */
    _resolveVideoModelKey(family, genType, aspectRatio, tier) {
        const familyConfig = VIDEO_MODEL_KEYS[family];
        if (!familyConfig) throw new Error(`Unknown video model family: ${family}`);

        const typeConfig = familyConfig[genType];
        if (!typeConfig) throw new Error(`Video family ${family} doesn't support ${genType}`);

        // Try tier-specific key first
        const ratioKey = aspectRatio.includes('PORTRAIT') ? 'portrait' : 'landscape';
        const isAdvanced = tier === 'SERVICE_TIER_ADVANCED';

        const key = typeConfig[`${ratioKey}_advanced`] && isAdvanced
            ? typeConfig[`${ratioKey}_advanced`]
            : typeConfig[ratioKey] || typeConfig.default;

        if (!key) throw new Error(`No video model key for ${family}/${genType}/${ratioKey}`);
        return key;
    }

    /**
     * Start a video generation (async). Supports t2v, i2v, f2v, and r2v.
     *
     * @param {string} prompt
     * @param {object} options
     * @param {string} [options.model='veo_3_1_fast']    - Video model family
     * @param {string} [options.aspectRatio='16:9']      - Aspect ratio
     * @param {number} [options.count=1]                 - How many videos to generate (1-4)
     * @param {number} [options.seed]                    - Base seed (each video gets seed+i)
     * @param {string} [options.startImageId]            - Media ID of start frame (i2v/f2v)
     * @param {string} [options.endImageId]              - Media ID of end frame (f2v)
     * @param {object} [options.cropCoordinates]         - Crop for start image {top,left,bottom,right}
     * @param {Array}  [options.referenceImages]         - Reference images for r2v.
     *                                                    Each item: mediaId string OR {mediaId, imageUsageType}
     * @returns {Promise<object>} - { operations, remainingCredits, workflows, media }
     */
    async generateVideo(prompt, options = {}) {
        const projectId = await this.ensureProject();
        const clientContext = await this._buildClientContext(projectId, 'VIDEO_GENERATION');

        const videoAspectRatio = VIDEO_ASPECT_RATIOS[options.aspectRatio || '16:9'] || options.aspectRatio || 'VIDEO_ASPECT_RATIO_LANDSCAPE';
        const baseSeed = options.seed || Math.floor(Math.random() * 200000);
        const batchId = crypto.randomUUID();
        const count = Math.max(1, Math.min(options.count || 1, 4)); // 1–4 videos per batch

        // Determine generation type
        const hasStartImage = !!options.startImageId;
        const hasEndImage = !!options.endImageId;
        const hasRefImages = Array.isArray(options.referenceImages) && options.referenceImages.length > 0;

        // Determine generation type based on provided inputs
        const genType = (hasStartImage && hasEndImage) ? 'f2v' : hasStartImage ? 'i2v' : hasRefImages ? 'r2v' : 't2v';
        const modelFamily = options.model || 'veo_3_1_fast';

        const videoModelKey = options.videoModelKey
            || this._resolveVideoModelKey(modelFamily, genType, videoAspectRatio, this._userTier);

        clientContext.userPaygateTier = this._paygateTier;

        // Build one request entry per video (different seed each time)
        const requests = Array.from({ length: count }, (_, i) => {
            const seed = baseSeed + i;
            const req = {
                aspectRatio: videoAspectRatio,
                seed,
                // Inject a safe ambient noise prompt if a silent prompt is requested to prevent the backend audio model from organically crashing on static/silent scenes
                textInput: { structuredPrompt: { parts: [{ text: prompt.match(/\b(no audio|without audio|silent video|silent)\b/i) ? prompt.replace(/(\bno audio\b|\bwithout audio\b|\bsilent video\b|\bsilent\b)/gi, '').trim() + ', with subtle background wind noise' : prompt }] } },
                videoModelKey,
                metadata: {},
            };

            // i2v — start image (first frame)
            if (hasStartImage) {
                req.startImage = {
                    mediaId: options.startImageId,
                    cropCoordinates: options.cropCoordinates || { top: 0, left: 0, bottom: 1, right: 1 },
                };
            }

            // i2v — end image (last frame) keyframe interpolation
            if (options.endImageId) {
                req.endImage = {
                    mediaId: options.endImageId,
                    cropCoordinates: options.cropCoordinates || { top: 0, left: 0, bottom: 1, right: 1 },
                };
            }

            // r2v — reference images (style / character / scene guides)
            if (hasRefImages) {
                req.referenceImages = options.referenceImages.map((img, idx) =>
                    typeof img === 'string'
                        ? { mediaId: img, imageUsageType: 'IMAGE_USAGE_TYPE_ASSET' }
                        : { imageUsageType: 'IMAGE_USAGE_TYPE_ASSET', ...img }
                );
            }

            return req;
        });

        const body = {
            mediaGenerationContext: { batchId },
            clientContext,
            requests,
            useV2ModelConfig: true,
        };

        this.emit('video:generating', { prompt, model: videoModelKey, aspectRatio: videoAspectRatio, seed: baseSeed, count, genType });

        // Endpoint routing:
        //   t2v  →  batchAsyncGenerateVideoText
        //   i2v  →  batchAsyncGenerateVideoStartImage
        //   r2v  →  batchAsyncGenerateVideoReferenceImages
        //   f2v  →  batchAsyncGenerateVideoStartAndEndImage
        const ENDPOINTS = {
            t2v: '/v1/video:batchAsyncGenerateVideoText',
            i2v: '/v1/video:batchAsyncGenerateVideoStartImage',
            r2v: '/v1/video:batchAsyncGenerateVideoReferenceImages',
            f2v: '/v1/video:batchAsyncGenerateVideoStartAndEndImage',
        };
        const endpoint = ENDPOINTS[genType];

        // Generate calls yêu cầu reCAPTCHA và PHẢI đi qua browser context (labs.google origin)
        // Node.js HTTP request trực tiếp bị block bởi reCAPTCHA Enterprise ngay cả khi có token hợp lệ
        const token = await this._tokenManager.getToken();
        const url = `${API_BASE}${endpoint}`;
        const res = await this._browserFetch('POST', url, token, body, 'VIDEO_GENERATION');
        const result = res.body;

        this.emit('video:started', result);
        return result;
        // Returns: { operations: [...n per video], remainingCredits, workflows, media }
    }

    /** @deprecated Use generateVideo(prompt, { count }) instead */
    async generateVideos(prompt, count = 1, options = {}) {
        return this.generateVideo(prompt, { ...options, count });
    }

    /**
     * Check the status of pending video generations.
     *
     * @param {Array<{name: string, projectId: string}>} mediaItems - Media items to check
     * @returns {Promise<object>} - Status response with media array
     */
    async checkVideoStatus(mediaItems) {
        const body = {
            media: mediaItems.map(m => ({
                name: m.name || m,
                projectId: m.projectId || this._projectId,
            })),
        };

        const res = await this._apiRequest('POST',
            '/v1/video:batchCheckAsyncVideoGenerationStatus',
            body
        );

        return res.body;
    }

    /**
     * Poll for video completion. Resolves when ALL media items are done.
     *
     * @param {Array<{name: string, projectId: string}>} mediaItems - Media items to poll
     * @param {object} [options] - Polling options
     * @param {number} [options.intervalMs=10000] - Poll interval
     * @param {number} [options.timeoutMs=600000] - Max wait time
     * @param {function} [options.onProgress] - Callback for each poll result
     * @returns {Promise<object>} - Final status response
     */
    async waitForVideos(mediaItems, options = {}) {
        const interval = options.intervalMs || POLL_INTERVAL_MS;
        const timeout = options.timeoutMs || POLL_TIMEOUT_MS;
        const startTime = Date.now();

        while (Date.now() - startTime < timeout) {
            await new Promise(r => setTimeout(r, interval));

            const status = await this.checkVideoStatus(mediaItems);

            // Check if all are complete
            const allDone = status.media?.every(m => {
                const genStatus = m.mediaMetadata?.mediaStatus?.mediaGenerationStatus;
                return genStatus === 'MEDIA_GENERATION_STATUS_SUCCESSFUL'
                    || genStatus === 'MEDIA_GENERATION_STATUS_FAILED'
                    || genStatus === 'MEDIA_GENERATION_STATUS_FILTERED';
            });

            const elapsed = Math.round((Date.now() - startTime) / 1000);
            this.emit('video:polling', { elapsed, media: status.media });

            if (options.onProgress) {
                options.onProgress(status, elapsed);
            }

            if (allDone) {
                this.emit('video:complete', status);
                return status;
            }
        }

        throw new Error(`Video generation timed out after ${timeout / 1000}s`);
    }

    /**
     * Full video generation pipeline: start → poll → return results.
     */
    async generateVideoAndWait(prompt, options = {}) {
        // Start generation
        const startResult = await this.generateVideo(prompt, options);

        // Extract media items to poll
        const mediaItems = (startResult.media || []).map(m => ({
            name: m.name,
            projectId: m.projectId || this._projectId,
        }));

        if (mediaItems.length === 0) {
            throw new Error('No media items returned from video generation start');
        }

        // Poll until complete
        const finalResult = await this.waitForVideos(mediaItems, {
            onProgress: (status, elapsed) => {
                const pending = status.media?.filter(m =>
                    m.mediaMetadata?.mediaStatus?.mediaGenerationStatus === 'MEDIA_GENERATION_STATUS_PENDING'
                ).length || 0;
                this.emit('video:progress', { elapsed, pending, total: mediaItems.length });
            },
        });

        return finalResult;
    }

    // ═══════════════════════════════════════════════════════════════
    //  MEDIA MANAGEMENT
    // ═══════════════════════════════════════════════════════════════

    /**
     * Trigger browser để load video/image và capture URL qua CDP.
     * Navigate đến project page → browser fetch video → CDP bắt GCS URL.
     * @param {string} mediaId - UUID của media
     * @param {string} projectId - Project ID
     * @param {number} [waitMs=15000] - Thời gian chờ CDP capture (ms)
     * @returns {Promise<string|null>} URL hoặc null
     */
    async triggerMediaUrlCapture(mediaId, projectId, waitMs = 15000) {
        const tm = this._tokenManager;
        if (!tm || !tm._page) return null;

        const page = tm._page;

        // 1) Kiểm tra URL đã được capture chưa — ưu tiên video MP4
        if (tm._cdpVideoUrls?.has(mediaId)) return tm._cdpVideoUrls.get(mediaId);
        if (tm._cdpMediaUrls?.has(mediaId)) return tm._cdpMediaUrls.get(mediaId);

        try {
            // 2) Đảm bảo đang ở labs.google để cookies hợp lệ cho request
            const currentUrl = page.url();
            if (!currentUrl.includes('labs.google')) {
                await page.goto('https://labs.google/fx/vi/tools/flow/', {
                    waitUntil: 'domcontentloaded', timeout: 15000,
                }).catch(() => { });
                await new Promise(r => setTimeout(r, 3000));
            }

            // 3) Inject hidden <video> element với src = getMediaUrlRedirect URL.
            //    Browser sẽ gửi request với Sec-Fetch-Dest: video → server redirect
            //    sang GCS /video/UUID (MP4 thật) thay vì /image/UUID (JPEG thumbnail).
            //    CDP Network.requestWillBeSent sẽ capture GCS video URL.
            const videoSrcUrl = this.getVideoDirectUrl(mediaId);

            await page.evaluate((src, mId) => {
                // Xóa element cũ nếu có (từ capture trước)
                const old = document.getElementById('__veo3_cap__');
                if (old) old.remove();

                const v = document.createElement('video');
                v.id = '__veo3_cap__';
                v.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;opacity:0;';
                v.src = src;
                v.muted = true;
                v.preload = 'metadata';  // fetch only headers → triggers Sec-Fetch-Dest: video
                v.crossOrigin = 'anonymous';
                document.body.appendChild(v);
                v.load();
            }, videoSrcUrl, mediaId).catch(() => { });

            // 4) Chờ CDP capture URL — video URL (MP4) hoặc fallback thumbnail (JPEG)
            const url = await tm.waitForMediaUrl(mediaId, waitMs);

            // 5) Cleanup <video> element
            await page.evaluate(() => {
                const el = document.getElementById('__veo3_cap__');
                if (el) el.remove();
            }).catch(() => { });

            if (url) {
                const isVideo = tm._cdpVideoUrls?.has(mediaId);
                console.log(`[ApiClient] ${isVideo ? '🎬 Video MP4' : '🖼️ Thumbnail'} URL captured for ${mediaId.substring(0, 20)}`);
            }
            return url;
        } catch (err) {
            console.warn(`[ApiClient] triggerMediaUrlCapture failed: ${err.message}`);
            return null;
        }
    }


    /**
     * Get a media download URL (redirect)
     *
     * @param {string} mediaName - Media ID/name
     * @param {string} [mediaUrlType='MEDIA_URL_TYPE_ORIGINAL'] - URL type
     */
    async getMediaUrl(mediaName, mediaUrlType = 'MEDIA_URL_TYPE_THUMBNAIL') {
        // Debug confirm: THUMBNAIL type → 307 redirect với Location = URL video thật
        // ORIGINAL type → 400 "Internal Error"
        // _httpRequest bây giờ resolve 3xx với { redirectUrl: location }

        // 1) Thử _labsRequest: cookie từ browser, bắt Location từ 307
        try {
            const params = new URLSearchParams({ name: mediaName, mediaUrlType });
            const res = await this._labsRequest('GET',
                `/fx/api/trpc/media.getMediaUrlRedirect?${params.toString()}`
            );
            // 307 redirect → redirectUrl chứa URL thật
            if (res.redirectUrl && res.redirectUrl.startsWith('http')) {
                console.log(`[ApiClient] getMediaUrl → redirect: ${res.redirectUrl.substring(0, 80)}...`);
                return res.redirectUrl;
            }
            // 200 với body JSON
            const body = res.body;
            const url =
                (typeof body === 'string' && body.startsWith('http') ? body : null) ||
                body?.result?.data?.json?.url ||
                (typeof body?.result?.data?.json === 'string' && body?.result?.data?.json?.startsWith('http') ? body.result.data.json : null) ||
                body?.url;
            if (url) return url;
            console.warn(`[ApiClient] getMediaUrl: unexpected body: ${JSON.stringify(body).substring(0, 200)}`);
        } catch (labsErr) {
            console.warn(`[ApiClient] getMediaUrl _labsRequest failed: ${labsErr.message.substring(0, 100)}`);
        }

        // 2) Fallback: browser fetch với credentials:include — browser theo redirect tự động
        const page = this._tokenManager?._page;
        if (page) {
            try {
                const params = new URLSearchParams({ name: mediaName, mediaUrlType }).toString();
                const url = `${LABS_BASE}/fx/api/trpc/media.getMediaUrlRedirect?${params}`;

                const result = await page.evaluate(async (fetchUrl) => {
                    try {
                        const res = await fetch(fetchUrl, {
                            method: 'GET',
                            credentials: 'include',
                            redirect: 'follow',
                            headers: { 'Accept': 'application/json, */*' },
                        });
                        // res.url = URL sau redirect (nếu có redirect)
                        const text = await res.text();
                        let parsed;
                        try { parsed = JSON.parse(text); } catch { parsed = text; }
                        return { ok: res.ok, status: res.status, finalUrl: res.url, body: parsed };
                    } catch (e) {
                        return { ok: false, error: e.message };
                    }
                }, url);

                if (result.ok) {
                    // Nếu fetch đã follow redirect, res.url là URL thật
                    if (result.finalUrl && result.finalUrl !== url && result.finalUrl.startsWith('http')) {
                        return result.finalUrl;
                    }
                    const body = result.body;
                    const parsed =
                        (typeof body === 'string' && body.startsWith('http') ? body : null) ||
                        body?.result?.data?.json?.url ||
                        body?.url;
                    if (parsed) return parsed;
                }
                console.warn(`[ApiClient] getMediaUrl browser fallback: ${JSON.stringify(result).substring(0, 150)}`);
            } catch (e) {
                console.warn(`[ApiClient] getMediaUrl browser exception: ${e.message}`);
            }
        }

        return null;
    }

    /**
     * Download media (image or video) as a Buffer
     *
     * @param {string} url - Direct URL (fifeUrl from generation response, or signed GCS URL)
     */
    async downloadMedia(url) {
        return this.downloadBuffer(url);
    }

    /**
     * Get the direct download URL for a generated image from its fifeUrl
     */
    getImageDownloadUrl(generationResult) {
        const media = generationResult.media?.[0];
        if (!media) return null;
        return media.image?.generatedImage?.fifeUrl || null;
    }

    // ═══════════════════════════════════════════════════════════════
    //  WORKFLOW MANAGEMENT
    // ═══════════════════════════════════════════════════════════════

    /**
     * Update a workflow's display name
     */
    async updateWorkflow(workflowId, displayName) {
        const body = {
            workflow: {
                name: workflowId,
                projectId: this._projectId,
                metadata: { displayName },
            },
            updateMask: 'metadata.displayName',
        };

        const res = await this._apiRequest('PATCH',
            `/v1/flowWorkflows/${workflowId}`,
            body
        );

        return res.body;
    }

    // ═══════════════════════════════════════════════════════════════
    //  APP CONFIG
    // ═══════════════════════════════════════════════════════════════

    /**
     * Get Flow app config (available models, feature flags, banners)
     */
    async getAppConfig() {
        const input = JSON.stringify({ json: null, meta: { values: ['undefined'] } });
        const res = await this._labsRequest('GET',
            `/fx/api/trpc/videoFx.getFlowAppConfig?input=${encodeURIComponent(input)}`
        );
        return res.body.result.data.json.result;
    }

    /**
     * Get user settings
     */
    async getUserSettings() {
        const input = JSON.stringify({ json: null, meta: { values: ['undefined'] } });
        const res = await this._labsRequest('GET',
            `/fx/api/trpc/videoFx.getUserSettings?input=${encodeURIComponent(input)}`
        );
        return res.body.result.data.json;
    }

    /**
     * Check if Flow is available
     */
    async checkAvailability() {
        const res = await this._apiRequest('POST', '/v1:checkAppAvailability', {
            clientContext: { tool: TOOL_NAME },
        }, { 'X-goog-api-key': API_KEY });

        return res.body.availabilityState === 'AVAILABLE';
    }

    // ═══════════════════════════════════════════════════════════════
    //  CONVENIENCE / HIGH-LEVEL
    // ═══════════════════════════════════════════════════════════════

    /**
     * Initialize the client: ensure project, load model config, verify auth.
     */
    async initialize() {
        await this.ensureProject();
        const credits = await this.getCredits();
        this.emit('ready', {
            projectId: this._projectId,
            credits,
            tier: this._userTier,
        });
        return {
            projectId: this._projectId,
            credits,
            tier: this._userTier,
        };
    }

    /**
     * Get all available model families from cached config
     */
    getAvailableModels() {
        if (!this._modelConfig) {
            throw new Error('Call initialize() first to load model config');
        }
        return {
            image: this._modelConfig.imageModelFamilies.map(m => ({
                id: m.id,
                displayName: m.displayName,
                keys: m.usages.map(u => u.key),
            })),
            video: this._modelConfig.videoModelFamilies.map(m => ({
                id: m.id,
                displayName: m.displayName,
                keys: m.usages.map(u => u.key),
            })),
        };
    }
}

module.exports = ApiClient;