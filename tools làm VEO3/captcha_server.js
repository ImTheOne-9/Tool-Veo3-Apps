/**
 * captcha_server.js
 * 
 * Pure Node.js captcha solver server — equivalent to the TypeScript captcha-solver project.
 * Reference: https://github.com/dlir2404/captcha-solver
 * 
 * Architecture:
 *   - HTTP server: GET /captcha?action=IMAGE_GENERATION → { captcha: "0cAFcWeA..." }
 *   - Socket.IO server: Chrome extension (injected.js) connects, receives requests, returns tokens
 * 
 * Usage:
 *   node captcha_server.js
 *   CAPTCHA_PORT=3456 node captcha_server.js
 */

'use strict';

const http = require('http');
const { Server: SocketIOServer } = require('socket.io');
const crypto = require('crypto');

const PORT = parseInt(process.env.CAPTCHA_PORT || '3456', 10);
const REQUEST_TIMEOUT_MS = 30000;

// ─── Logging ───────────────────────────────────────────────────────────────
const C = { reset: '\x1b[0m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m', dim: '\x1b[2m' };
function log(msg, color = 'reset') {
    const ts = new Date().toTimeString().slice(0, 8);
    console.log(`${C.dim}[${ts}]${C.reset} ${C[color] || ''}${msg}${C.reset}`);
}

// ─── State ─────────────────────────────────────────────────────────────────
/**
 * Map<socketId, { socket, browserType: 'brave'|'chrome'|'unknown' }>
 * browserType is reported by the extension via client:ready { browserType }
 */
const connectedClients = new Map();

/** Map<requestId, {resolve, reject, timer}> — pending HTTP captcha requests */
const pendingRequests = new Map();

// ─── Client Selection ──────────────────────────────────────────────────────

/**
 * Pick the best available client based on the current captcha mode.
 * - real_chrome mode: only real Chrome clients (browserType === 'chrome')
 * - auto mode: any client (prefers 'chrome' > 'brave' > 'unknown')
 */
function _pickClient() {
    const mode = process.env.CAPTCHA_MODE || 'auto';
    const all = [...connectedClients.values()];

    if (mode === 'real_chrome') {
        return all.find(c => c.browserType === 'chrome') || null;
    }

    // auto: prefer real Chrome for better scores, fallback to any
    return all.find(c => c.browserType === 'chrome')
        || all.find(c => c.browserType === 'brave')
        || all[0]
        || null;
}

/**
 * Get all available clients for retry (excluding a specific socketId)
 */
function _alternateClients(excludeId) {
    return [...connectedClients.values()].filter(c => c.socket.id !== excludeId);
}

// ─── Core: request a captcha token from a specific client ─────────────────

function _requestFromClient(clientEntry, action, requestId) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            if (pendingRequests.has(requestId)) {
                pendingRequests.delete(requestId);
                reject(new Error(`Captcha request timeout (30s) — client ${clientEntry.socket.id.slice(0, 8)} [${clientEntry.browserType}]`));
            }
        }, REQUEST_TIMEOUT_MS);
        pendingRequests.set(requestId, { resolve, reject, timer });
        clientEntry.socket.emit('server:request-captcha', { requestId, action });
        log(`  → Sent to [${clientEntry.browserType}] ${clientEntry.socket.id.slice(0, 8)} (requestId: ${requestId})`, 'dim');
    });
}

// ─── HTTP Server ───────────────────────────────────────────────────────────
const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // GET /captcha?action=IMAGE_GENERATION
    if (req.method === 'GET' && url.pathname === '/captcha') {
        const action = url.searchParams.get('action') || 'IMAGE_GENERATION';
        const mode = process.env.CAPTCHA_MODE || 'auto';

        const primaryClient = _pickClient();
        if (!primaryClient) {
            const msg = mode === 'real_chrome'
                ? 'No real Chrome client connected. Open Chrome with the extension at labs.google/fx/vi/tools/flow'
                : 'No browser clients connected. Open Chrome/Brave with the captcha extension at labs.google/fx/vi/tools/flow';
            log(`No suitable client (mode=${mode}) — 503`, 'red');
            res.writeHead(503);
            res.end(JSON.stringify({ error: msg }));
            return;
        }

        log(`Captcha requested (action=${action}, mode=${mode}) — ${connectedClients.size} client(s)`, 'cyan');

        const requestId = `req_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

        try {
            const token = await _requestFromClient(primaryClient, action, requestId);
            log(`  ← Token received (${token.length} chars) [${primaryClient.browserType}]`, 'green');
            res.writeHead(200);
            res.end(JSON.stringify({ captcha: token }));
        } catch (primaryErr) {
            log(`  ✗ Primary client failed: ${primaryErr.message}`, 'yellow');

            // ── Auto-retry with next available client ──────────────────
            const alternates = _alternateClients(primaryClient.socket.id);
            let retrySuccess = false;

            for (const alt of alternates) {
                const retryId = `req_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
                log(`  ↻ Retrying with [${alt.browserType}] ${alt.socket.id.slice(0, 8)}...`, 'yellow');
                try {
                    const token = await _requestFromClient(alt, action, retryId);
                    log(`  ← Retry token received (${token.length} chars) [${alt.browserType}]`, 'green');
                    res.writeHead(200);
                    res.end(JSON.stringify({ captcha: token }));
                    retrySuccess = true;
                    break;
                } catch (retryErr) {
                    log(`  ✗ Alternate client also failed: ${retryErr.message}`, 'red');
                }
            }

            if (!retrySuccess) {
                log(`  ✗ All clients failed — 408`, 'red');
                res.writeHead(408);
                res.end(JSON.stringify({ error: primaryErr.message }));
            }
        }

        return;
    }

    // GET /health
    if (req.method === 'GET' && url.pathname === '/health') {
        const clients = [...connectedClients.values()].map(c => ({
            id: c.socket.id.slice(0, 8),
            browserType: c.browserType,
        }));
        res.writeHead(200);
        res.end(JSON.stringify({
            status: 'ok',
            mode: process.env.CAPTCHA_MODE || 'auto',
            connectedClients: connectedClients.size,
            clients,
            pendingRequests: pendingRequests.size,
        }));
        return;
    }

    // POST /force-refresh
    if (req.method === 'POST' && url.pathname === '/force-refresh') {
        let n = 0;
        for (const { socket } of connectedClients.values()) {
            socket.emit('server:reload-page', { delay: 500 });
            n++;
        }
        log(`Force-refreshed ${n} client(s)`, 'yellow');
        res.writeHead(200);
        res.end(JSON.stringify({ refreshed: n }));
        return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
});

// ─── Socket.IO Server (for Chrome extension injected.js) ──────────────────
const io = new SocketIOServer(httpServer, { cors: { origin: '*' } });

io.on('connection', (socket) => {
    // Store with unknown type until client:ready reports browserType
    connectedClients.set(socket.id, { socket, browserType: 'unknown' });
    log(`✅ Extension connected: ${socket.id} (type pending...)`, 'green');

    socket.on('client:ready', (data) => {
        const browserType = data?.browserType || 'unknown';
        const entry = connectedClients.get(socket.id);
        if (entry) entry.browserType = browserType;
        log(`  Extension ready [${socket.id.slice(0, 8)}] — ${browserType}`, 'dim');
    });

    socket.on('client:captcha-solved', ({ requestId, token }) => {
        if (requestId && pendingRequests.has(requestId)) {
            const { resolve, timer } = pendingRequests.get(requestId);
            clearTimeout(timer);
            pendingRequests.delete(requestId);
            resolve(token);
            log(`  Captcha solved (${token?.length} chars)`, 'green');
        }
    });

    socket.on('client:captcha-error', ({ requestId, error }) => {
        log(`  Captcha error: ${error}`, 'red');
        if (requestId && pendingRequests.has(requestId)) {
            const { reject, timer } = pendingRequests.get(requestId);
            clearTimeout(timer);
            pendingRequests.delete(requestId);
            reject(new Error(error));
        }
    });

    socket.on('disconnect', () => {
        connectedClients.delete(socket.id);
        log(`❌ Extension disconnected (total: ${connectedClients.size})`, 'yellow');

        // Close Chrome if all clients gone and CAPTCHA_MODE is not real_chrome
        if (connectedClients.size === 0) {
            log('Tất cả clients đã ngắt kết nối. Đang đóng Chrome để tiết kiệm RAM...', 'yellow');
        }
    });
});

// ─── Start ──────────────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
    console.log('');
    console.log('╔══════════════════════════════════════════════════╗');
    console.log('║   🔓  Captcha Solver Server                      ║');
    console.log('║                                                  ║');
    console.log(`║   HTTP:  http://localhost:${PORT}                 ║`);
    console.log(`║   API:   GET /captcha?action=IMAGE_GENERATION    ║`);
    console.log(`║   Stats: GET /health                             ║`);
    console.log('║                                                  ║');
    console.log('║   📌 Open Chrome at labs.google/fx/vi/tools/flow ║');
    console.log('║                                                  ║');
    console.log('╚══════════════════════════════════════════════════╝');
    console.log('');
    log('Waiting for Chrome extension to connect...', 'yellow');
});

process.on('SIGINT', () => {
    log('Shutting down captcha server...', 'yellow');
    for (const [, { reject, timer }] of pendingRequests) {
        clearTimeout(timer);
        reject(new Error('Server shutting down'));
    }
    process.exit(0);
});