const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

// === SECURITY: Kiểm Tra Tính Toàn Vẹn của auth.js (Production Only) ===
// Chạy TRƯỚC khi require('./auth') — nếu ai thay stub bằng class giả → exit ngay
// Hash được inject bởi build-secure.js tại PRE-STEP, baked vào server.jsc bytecode
; (function _authIntegrityCheck() {
  // Chỉ kiểm tra trong production (bên trong ASAR package)
  if (!__dirname.includes('app.asar')) return;

  // Giá trị này sẽ được build-secure.js thay bằng SHA256 thực trước khi compile
  const EXPECTED_HASH = '__AUTH_STUB_HASH__';
  // Defensive: nếu placeholder chưa được inject thì bỏ qua (không nên xảy ra)
  if (EXPECTED_HASH === '__AUTH_STUB_HASH__') return;

  try {
    const authJs = fs.readFileSync(path.join(__dirname, 'auth.js'), 'utf-8');
    const actualHash = crypto.createHash('sha256').update(authJs).digest('hex');
    if (actualHash !== EXPECTED_HASH) {
      process.stderr.write('\n[SECURITY] \u26d4 auth.js b\u1ecb gi\u1ea3 m\u1ea1o! \u1ee8ng d\u1ee5ng s\u1ebd t\u1eaft ngay.\n\n');
      process.exit(1);
    }
  } catch (e) {
    // Nếu không đọc được auth.js trong ASAR → đây cũng là dấu hiệu bất thường
    process.stderr.write('[SECURITY] Kh\u00f4ng th\u1ec3 x\u00e1c minh auth.js: ' + e.message + '\n');
    process.exit(1);
  }
})();

const multer = require('multer');
const FlowAutomation = require('./automation');
const AuthManager = require('./auth');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Thư mục lưu mặc định — persist qua file settings.json
const userDataDir = path.join(os.homedir(), 'Veo3Data');
if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });

// Thư mục lưu mặc định — persist qua file settings.json
const settingsFile = path.join(userDataDir, 'settings.json');
const DEFAULT_DOWNLOAD_DIR = path.join(os.homedir(), 'Downloads', 'Veo3_Downloads');

// QUAN TRỌNG: Đẩy thư mục upload ảnh vào thư mục Temp của Windows/Mac
const uploadsDir = path.join(os.tmpdir(), 'veo3_uploads');

// Đọc settings đã lưu (nếu có)
let savedSettings = {};
try {
  if (fs.existsSync(settingsFile)) {
    savedSettings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
  }
} catch (e) { }

let downloadDir = savedSettings.downloadDir || DEFAULT_DOWNLOAD_DIR;

// ─── Captcha Mode ─────────────────────────────────────────────────────────
// 'auto'        = extension runs inside headless Brave (current default)
// 'real_chrome' = user's real Chrome handles captcha; Brave only for OAuth
let captchaMode = savedSettings.captchaMode || 'auto';
process.env.CAPTCHA_MODE = captchaMode; // token_manager.js reads this

// Đảm bảo thư mục tồn tại
try {
  if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir, { recursive: true });
} catch (e) {
  downloadDir = DEFAULT_DOWNLOAD_DIR;
  try { fs.mkdirSync(downloadDir, { recursive: true }); } catch (_) { }
}

function saveSettings() {
  try {
    fs.writeFileSync(settingsFile, JSON.stringify({ downloadDir, captchaMode }, null, 2), 'utf-8');
  } catch (e) { }
}


// Multer config cho upload ảnh reference
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const fs = require('fs');
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const name = `ref_${Date.now()}${ext}`;
    cb(null, name);
  }
});
const upload = multer({ storage, limits: { fileSize: 200 * 1024 * 1024 } }); // 200MB max cho video/image

// Middleware — tăng limit để chứa base64 image data
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ limit: '500mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// === Auth Manager ===
const auth = new AuthManager();

// === Auth Routes (không cần auth middleware) ===
app.post('/api/auth/register', async (req, res) => {
  const { email, password, name, phone } = req.body;
  if (!email || !password || !name) {
    return res.status(400).json({ success: false, error: 'Vui lòng nhập đầy đủ thông tin' });
  }
  const result = await auth.register(email, password, name, phone);
  res.json(result);
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ success: false, error: 'Vui lòng nhập email và mật khẩu' });
  }
  const result = await auth.login(email, password);
  res.json(result);
});

app.post('/api/auth/logout', (req, res) => {
  const result = auth.logout();
  res.json(result);
});

app.post('/api/auth/verify', async (req, res) => {
  const result = await auth.verify();
  res.json(result);
});

// Kiem tra session nhe (frontend login.html poll 30s de phat hien needVerify)
app.get('/api/auth/session-check', async (req, res) => {
  if (!auth.isLoggedIn()) {
    return res.json({ valid: false, reason: 'not_logged_in' });
  }
  const result = await auth.verify();
  if (result.needVerify) {
    return res.json({ valid: false, needVerify: true, email: result.email || '' });
  }
  res.json({ valid: result.valid !== false });
});


app.get('/api/auth/status', (req, res) => {
  const status = auth.getStatus();
  status.webhookConfigured = auth.isWebhookConfigured();
  status.hwid = auth.getHWID();
  res.json(status);
});

app.get('/api/auth/config', (req, res) => {
  res.json({
    webhookBaseUrl: auth.getWebhookUrl(),
    purchaseUrl: auth.config.purchaseUrl || null,
    appName: auth.config.appName || 'VEO3 Tool'
  });
});

// Lấy thông tin thanh toán (bank + plans + paymentCode) từ server webhook
// Dùng để hiển thị QR modal trong tool
app.get('/api/auth/payment-info', async (req, res) => {
  try {
    if (!auth.isLoggedIn()) {
      return res.status(401).json({ success: false, error: 'Chưa đăng nhập' });
    }

    const token = auth.license?.token || '';

    // Dùng URL.origin để lấy chính xác domain gốc (tránh lỗi regex với /api/veo3)
    const webhookUrl = auth.getWebhookUrl();           // vd: https://workflowgiare.com/api/veo3
    const parsedWH = new URL(webhookUrl);
    const serverOrigin = parsedWH.origin;               // → https://workflowgiare.com
    const endpoint = serverOrigin + '/api/veo3/payment-info';

    const https = require('https');
    const http = require('http');
    const parsedUrl = new URL(endpoint);
    const protocol = parsedUrl.protocol === 'https:' ? https : http;

    const data = await new Promise((resolve, reject) => {
      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname + (parsedUrl.search || ''),
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'User-Agent': 'VEO3-Tool/1.0'
        },
        timeout: 8000
      };
      const req2 = protocol.request(options, (proxyRes) => {
        let body = '';
        proxyRes.on('data', chunk => body += chunk);
        proxyRes.on('end', () => {
          try { resolve(JSON.parse(body)); }
          catch { reject(new Error('Invalid JSON from server')); }
        });
      });
      req2.on('error', reject);
      req2.on('timeout', () => { req2.destroy(); reject(new Error('Timeout kết nối server')); });
      req2.end();
    });

    if (data && data.success) {
      return res.json(data);
    }
    throw new Error(data?.error || 'Server trả về lỗi');

  } catch (e) {
    // Fallback: trả về config cứng nếu không kết nối được server
    console.warn('[payment-info] Server không khả dụng, dùng fallback config:', e.message);
    const status = auth.getStatus();
    res.json({
      success: true,
      offline: true,
      bank: {
        name: 'BIDV',
        code: 'BIDV',
        accountNumber: '96247VEO3',
        accountName: 'HO KINH DOANH PHAN DUC NHO'
      },
      paymentCode: status?.user?.payment_code || 'Liên hệ Admin',
      plans: {
        pro: { price: 399000, days: 30, label: 'Pro' },
        vip: { price: 1200000, days: 365, label: 'VIP' },
        lifetime: { price: 1900000, days: null, label: 'Lifetime' }
      },
      currentPlan: status?.user?.plan || 'trial'
    });
  }
});

// Ghi session pending khi tool mở QR thanh toán (proxy lên server thật)
app.post('/api/auth/payment-session/start', async (req, res) => {
  try {
    if (!auth.isLoggedIn()) {
      return res.json({ success: false, error: 'Chưa đăng nhập' });
    }

    const token = auth.license?.token || '';
    const webhookUrl = auth.getWebhookUrl();
    const parsedWH = new URL(webhookUrl);
    const serverOrigin = parsedWH.origin;
    const endpoint = serverOrigin + '/api/veo3/payment-session/start';

    const https = require('https');
    const http = require('http');
    const parsedUrl = new URL(endpoint);
    const protocol = parsedUrl.protocol === 'https:' ? https : http;
    const postData = JSON.stringify(req.body || {});

    const data = await new Promise((resolve, reject) => {
      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname,
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
          'User-Agent': 'VEO3-Tool/1.0'
        },
        timeout: 6000
      };
      const req2 = protocol.request(options, (proxyRes) => {
        let body = '';
        proxyRes.on('data', chunk => body += chunk);
        proxyRes.on('end', () => {
          try { resolve(JSON.parse(body)); }
          catch { resolve({ success: false }); }
        });
      });
      req2.on('error', reject);
      req2.on('timeout', () => { req2.destroy(); reject(new Error('Timeout')); });
      req2.write(postData);
      req2.end();
    });

    res.json(data);
  } catch (e) {
    console.warn('[payment-session/start] Lỗi:', e.message);
    res.json({ success: false }); // không block UI
  }
});


app.post('/api/auth/webhook-url', (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ success: false, error: 'URL required' });
  auth.updateWebhookUrl(url);
  res.json({ success: true });
});

// === Proxy: /api/web/resend-verify → workflowgiare.com/api/web/resend-verify ===
// login.html gọi endpoint này để gửi lại email xác thực (không cần đăng nhập)
app.post('/api/web/resend-verify', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.json({ success: false, error: 'Thiếu email' });

    const webhookUrl = auth.getWebhookUrl(); // vd: https://workflowgiare.com/api/veo3
    const parsedWH = new URL(webhookUrl);
    const serverOrigin = parsedWH.origin;     // → https://workflowgiare.com
    const endpoint = serverOrigin + '/api/web/resend-verify';

    const https = require('https');
    const http = require('http');
    const parsedUrl = new URL(endpoint);
    const protocol = parsedUrl.protocol === 'https:' ? https : http;

    const postData = JSON.stringify({ email });

    const data = await new Promise((resolve, reject) => {
      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
          'User-Agent': 'VEO3-Tool/1.0'
        },
        timeout: 10000
      };
      const req2 = protocol.request(options, (proxyRes) => {
        let body = '';
        proxyRes.on('data', chunk => body += chunk);
        proxyRes.on('end', () => {
          try { resolve(JSON.parse(body)); }
          catch { reject(new Error('Invalid JSON from server')); }
        });
      });
      req2.on('error', reject);
      req2.on('timeout', () => { req2.destroy(); reject(new Error('Timeout kết nối server')); });
      req2.write(postData);
      req2.end();
    });

    res.json(data);
  } catch (e) {
    console.error('[resend-verify proxy] Lỗi:', e.message);
    res.json({ success: false, error: 'Không kết nối được server: ' + e.message });
  }
});

// === Auth Middleware — chặn tất cả API nếu chưa đăng nhập ===
app.use('/api', (req, res, next) => {
  // Bỏ qua auth routes, open-browser và resend-verify (public, không cần login)
  if (req.path.startsWith('/auth/') || req.path === '/open-browser' || req.path === '/web/resend-verify') return next();

  // Kiểm tra đã đăng nhập chưa
  if (!auth.isLoggedIn()) {
    return res.status(401).json({
      success: false,
      error: 'Chưa đăng nhập. Vui lòng đăng nhập tại /login.html',
      requireAuth: true
    });
  }

  next();
});

// Serve thư mục downloads để preview file đã tải
app.use('/downloaded', express.static(downloadDir));

// API lấy danh sách file đã tải
app.get('/api/downloaded-files', (req, res) => {
  try {
    const files = fs.readdirSync(downloadDir)
      .filter(f => !f.endsWith('.crdownload') && !f.endsWith('.tmp'))
      .map(f => {
        const stat = fs.statSync(path.join(downloadDir, f));
        const ext = path.extname(f).toLowerCase();
        return {
          filename: f,
          url: `/downloaded/${encodeURIComponent(f)}`,
          type: ['.mp4', '.webm', '.mov'].includes(ext) ? 'video' : 'image',
          size: stat.size,
          time: stat.mtimeMs
        };
      })
      .sort((a, b) => b.time - a.time); // Mới nhất trước
    res.json({ files });
  } catch (e) {
    res.json({ files: [] });
  }
});

// Tạo instance automation
const automation = new FlowAutomation(io);

const { exec } = require('child_process');

app.post('/api/open-browser', (req, res) => {
  let url = req.body.url;

  // Auto-login to the web platform if auth is present
  if (url.includes('workflowgiare.com') && auth.isLoggedIn() && auth.license && auth.license.token) {
    if (url === 'https://workflowgiare.com/' || url === 'https://workflowgiare.com') {
      url = 'https://workflowgiare.com/dashboard';
    }
    const sep = url.includes('?') ? '&' : '?';
    url += `${sep}token=${auth.license.token}`;
  }

  // Windows command to open default browser
  if (process.platform === 'win32') {
    exec(`start "" "${url}"`);
  }
  // Mac command
  else if (process.platform === 'darwin') {
    exec(`open "${url}"`);
  }
  // Linux command
  else {
    exec(`xdg-open "${url}"`);
  }

  res.json({ success: true });
});

// === API Routes ===
// Auto-update check
app.get('/api/check-update', async (req, res) => {
  try {
    const fs = require('fs');
    const path = require('path');
    let endpoint = 'http://localhost:4000/api/tool/check-update';
    const authPath = path.join(__dirname, 'auth-config.json');
    if (fs.existsSync(authPath)) {
      const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
      if (auth.apiEndpoint) endpoint = auth.apiEndpoint + '/api/tool/check-update';
    }
    const response = await fetch(endpoint).then(r => r.json());
    if (response.success) {
      const pkg = require('./package.json');
      response.current_version = pkg.version;
      response.has_update = response.latest_version !== pkg.version;
      return res.json(response);
    }
    res.json({ success: false });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Auto-update action
app.post('/api/auto-update', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });
  const path = require('path');
  const os = require('os');
  const https = require('https');
  const http = require('http');
  // Chuyển file cập nhật vào thư mục Temp để tránh lỗi quyền ghi
  const zipPath = path.join(os.tmpdir(), 'update_veo3.zip');
  const batPath = path.join(os.tmpdir(), 'update_wizard.bat');

  const file = fs.createWriteStream(zipPath);
  const protocol = url.startsWith('https') ? https : http;

  res.json({ success: true, message: 'Đang tải bản cập nhật...' });

  protocol.get(url, (response) => {
    response.pipe(file);
    file.on('finish', () => {
      file.close();
      const batScript = `
@echo off
timeout /t 2 /nobreak > NUL
echo ĐANG GIẢI NÉN BẢN CẬP NHẬT...
powershell -Command "Expand-Archive -Force -Path '%~dp0update_veo3.zip' -DestinationPath '%~dp0'"
del "%~dp0update_veo3.zip"
echo KHỞI ĐỘNG LẠI SERVER...
start cmd /k "npm install && node server.js"
goto 2>nul & del "%~f0"
exit
      `.trim();
      fs.writeFileSync(batPath, batScript);
      const { spawn } = require('child_process');
      const child = spawn('cmd.exe', ['/c', batPath], { detached: true, stdio: 'ignore' });
      child.unref();
      setTimeout(() => process.exit(0), 1000);
    });
  }).on('error', (e) => {
    fs.unlink(zipPath, () => { });
  });
});

// Proxy ảnh từ Google Storage (để tránh CORS)
app.get('/api/proxy-image', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('URL required');

  try {
    const https = require('https');
    const http = require('http');
    const protocol = url.startsWith('https') ? https : http;

    protocol.get(url, (proxyRes) => {
      res.set('Content-Type', proxyRes.headers['content-type'] || 'image/png');
      res.set('Cache-Control', 'public, max-age=3600');
      proxyRes.pipe(res);
    }).on('error', (e) => {
      res.status(500).send('Proxy error: ' + e.message);
    });
  } catch (e) {
    res.status(500).send('Error: ' + e.message);
  }
});

// Tải ảnh về thư mục downloads
app.post('/api/download', async (req, res) => {
  const { url, filename, quality, mediaType, editLink } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });

  try {
    const https = require('https');
    const httpModule = require('http');
    const fs = require('fs');
    const p = require('path');

    // Tạo thư mục downloads nếu chưa có
    if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir, { recursive: true });

    const fname = filename || `veo3_${Date.now()}.png`;
    const filePath = p.join(downloadDir, fname);
    const isVideo = mediaType === 'video' || fname.endsWith('.mp4');
    const needUpscale = quality && !['native', 'original', 'gốc'].includes(quality.toLowerCase());

    // === Lấy URL video chất lượng cao nếu có editLink và là video ===
    let downloadUrl = url;
    if (isVideo && editLink && automation && automation.page) {
      try {
        const hqUrl = await automation._getHighQualityVideoUrl(editLink);
        if (hqUrl) {
          downloadUrl = hqUrl;
          console.log(`[Download] Dùng URL HQ từ edit page: ${hqUrl.substring(0, 80)}...`);
        }
      } catch (e) {
        console.warn('[Download] Không lấy được HQ URL, dùng preview URL:', e.message);
      }
    }

    // Helper: apply upscale after file is saved
    async function applyUpscale(fp) {
      if (!needUpscale) return;
      if (!automation || !automation.upscaleWithFFmpeg) return;
      try {
        await automation.upscaleWithFFmpeg(fp, quality, isVideo ? 'video' : 'image');
      } catch (e) {
        console.warn('[Download] Upscale thất bại:', e.message);
      }
    }

    // FIX DATA URL (Base64)
    if (downloadUrl.startsWith('data:')) {
      const base64Data = downloadUrl.split(',')[1];
      if (!base64Data) return res.status(400).json({ error: 'Data URL không hợp lệ' });
      fs.writeFileSync(filePath, base64Data, 'base64');
      await applyUpscale(filePath);
      return res.json({ success: true, path: filePath, filename: fname });
    }

    // FIX TẢI BLOB VIDEO (Không thể fetch backend, phải fetch qua browser page)
    if (downloadUrl.startsWith('blob:')) {
      if (automation && automation.page) {
        try {
          const b64 = await automation.page.evaluate(async (blobUrl) => {
            const response = await fetch(blobUrl);
            const blob = await response.blob();
            return new Promise((resolve) => {
              const reader = new FileReader();
              reader.onloadend = () => resolve(reader.result.split(',')[1]);
              reader.readAsDataURL(blob);
            });
          }, downloadUrl);
          fs.writeFileSync(filePath, b64, 'base64');
          await applyUpscale(filePath);
          return res.json({ success: true, path: filePath, filename: fname });
        } catch (err) {
          return res.status(500).json({ error: 'Lỗi tải blob: ' + err.message });
        }
      } else {
        return res.status(500).json({ error: 'Không thể tải blob khi chrome chưa kết nối' });
      }
    }

    // Tải từ URL thường (https google preview) qua browser page (để gửi cookie)
    if (automation && automation.page && (downloadUrl.includes('google') || downloadUrl.includes('googleusercontent') || downloadUrl.includes('googleapis'))) {
      try {
        const b64 = await automation.page.evaluate(async (u) => {
          const res = await fetch(u);
          const blob = await res.blob();
          return new Promise(resolve => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result.split(',')[1]);
            reader.readAsDataURL(blob);
          });
        }, downloadUrl);
        fs.writeFileSync(filePath, b64, 'base64');
        await applyUpscale(filePath);
        return res.json({ success: true, path: filePath, filename: fname });
      } catch (e) {
        console.warn('[Download] Browser fetch thất bại, thử HTTP trực tiếp:', e.message);
      }
    }

    // Tải HTTP trực tiếp
    const file = fs.createWriteStream(filePath);
    const protocol = downloadUrl.startsWith('https') ? https : httpModule;
    protocol.get(downloadUrl, (response) => {
      // Follow redirects
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        const redirectUrl = response.headers.location;
        const redirectProtocol = redirectUrl.startsWith('https') ? https : httpModule;
        redirectProtocol.get(redirectUrl, (redirectRes) => {
          redirectRes.pipe(file);
          file.on('finish', async () => {
            file.close();
            await applyUpscale(filePath);
            res.json({ success: true, path: filePath, filename: fname });
          });
        }).on('error', (e) => {
          fs.unlink(filePath, () => { });
          res.status(500).json({ error: e.message });
        });
        return;
      }
      response.pipe(file);
      file.on('finish', async () => {
        file.close();
        await applyUpscale(filePath);
        res.json({ success: true, path: filePath, filename: fname });
      });
    }).on('error', (e) => {
      fs.unlink(filePath, () => { });
      res.status(500).json({ error: e.message });
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// Lấy thư mục lưu hiện tại
app.get('/api/download-dir', (req, res) => {
  res.json({ dir: downloadDir });
});

// Cập nhật thư mục lưu
app.post('/api/download-dir', (req, res) => {
  const { dir } = req.body;
  if (!dir) return res.status(400).json({ error: 'Directory required' });

  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    downloadDir = dir;
    saveSettings(); // Lưu vào file để giữ sau khi rs server
    res.json({ success: true, dir: downloadDir });
  } catch (e) {
    res.status(500).json({ error: `Không tạo được thư mục: ${e.message}` });
  }
});

// ─── Captcha Mode API ────────────────────────────────────────────────────────

// GET /api/captcha-status — trả về trạng thái kết nối real Chrome
app.get('/api/captcha-status', async (req, res) => {
  try {
    const http = require('http');
    const data = await new Promise((resolve) => {
      const req2 = http.get('http://127.0.0.1:3456/health', { timeout: 2000 }, (r) => {
        let body = '';
        r.on('data', c => body += c);
        r.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
      });
      req2.on('error', () => resolve(null));
      req2.on('timeout', () => { req2.destroy(); resolve(null); });
    });
    const serverRunning = !!data;
    const clients = data ? (data.connectedClients || 0) : 0;
    res.json({
      mode: captchaMode,
      serverRunning,
      clients,
      realChromeConnected: captchaMode === 'real_chrome' && clients > 0,
      status: !serverRunning ? 'server_offline'
        : captchaMode === 'real_chrome'
          ? (clients > 0 ? 'chrome_connected' : 'waiting_for_chrome')
          : (clients > 0 ? 'brave_connected' : 'no_extension'),
    });
  } catch (e) {
    res.json({ mode: captchaMode, serverRunning: false, clients: 0, realChromeConnected: false, status: 'error' });
  }
});

// POST /api/captcha-mode — đổi chế độ captcha
app.post('/api/captcha-mode', (req, res) => {
  const { mode } = req.body;
  if (!['auto', 'real_chrome'].includes(mode)) {
    return res.status(400).json({ success: false, error: 'Invalid mode. Use: auto | real_chrome' });
  }
  captchaMode = mode;
  process.env.CAPTCHA_MODE = mode; // token_manager reads this at launch time
  saveSettings();
  console.log(`[Server] Captcha mode changed → ${mode}`);
  res.json({ success: true, mode });
});

// Chọn thư mục qua hộp thoại
app.get('/api/select-folder', async (req, res) => {
  try {
    // Ưu tiên dùng API native của Electron (nếu đang chạy trong Electron app)
    try {
      const { dialog } = require('electron');
      if (dialog) {
        const result = await dialog.showOpenDialog({
          properties: ['openDirectory']
        });
        if (!result.canceled && result.filePaths.length > 0) {
          return res.json({ success: true, path: result.filePaths[0] });
        }
        return res.json({ success: false });
      }
    } catch (e) {
      // Bỏ qua lỗi nếu không chạy trong Electron (vd: người dùng chạy `node server.js` chay)
    }

    // Fallback: Sử dụng PowerShell script nếu chạy ngoài Electron
    const { exec } = require('child_process');
    const path = require('path');
    let pickFolderScript = path.join(__dirname, 'pickfolder.ps1');

    // Mở file unpack nếu file nằm trong ASAR
    if (pickFolderScript.includes('app.asar')) {
      pickFolderScript = pickFolderScript.replace('app.asar', 'app.asar.unpacked');
    }

    exec(`powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${pickFolderScript}"`, (error, stdout) => {
      const result = stdout.trim();
      if (!error && result) {
        res.json({ success: true, path: result });
      } else {
        res.json({ success: false });
      }
    });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Phục vụ ảnh/video đã tải về thông qua query path
app.get('/api/media', (req, res) => {
  const filePath = req.query.path;
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).send('Not found');

  // Xác định MIME type chính xác từ extension
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.avi': 'video/x-msvideo',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
  };
  const mimeType = mimeTypes[ext] || 'application/octet-stream';
  res.setHeader('Content-Type', mimeType);

  // Hỗ trợ Range requests để video có thể seek được
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range && mimeType.startsWith('video/')) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunkSize = end - start + 1;
    const fileStream = fs.createReadStream(filePath, { start, end });
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': mimeType,
    });
    fileStream.pipe(res);
  } else {
    res.setHeader('Content-Length', fileSize);
    res.setHeader('Accept-Ranges', 'bytes');
    fs.createReadStream(filePath).pipe(res);
  }
});

// Phục vụ thư mục uploads cho ảnh reference
app.use('/uploads', express.static(uploadsDir));

// === Quản lý Lịch Sử ===
const historyFile = path.join(userDataDir, 'history.json');
app.get('/api/history', (req, res) => {
  try {
    if (fs.existsSync(historyFile)) {
      const data = fs.readFileSync(historyFile, 'utf-8');
      res.json({ success: true, history: JSON.parse(data || '[]') });
    } else {
      res.json({ success: true, history: [] });
    }
  } catch (e) {
    res.json({ success: false, history: [], error: e.message });
  }
});

app.post('/api/history', (req, res) => {
  try {
    const { mediaList } = req.body;
    if (!mediaList || !Array.isArray(mediaList)) return res.json({ success: false });

    let currentHistory = [];
    if (fs.existsSync(historyFile)) {
      try {
        currentHistory = JSON.parse(fs.readFileSync(historyFile, 'utf-8'));
      } catch { }
    }
    // Chèn kết quả mới nhất lên đầu tiên
    currentHistory = [...mediaList, ...currentHistory];
    fs.writeFileSync(historyFile, JSON.stringify(currentHistory, null, 2), 'utf-8');
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.delete('/api/history', (req, res) => {
  try {
    if (fs.existsSync(historyFile)) {
      fs.writeFileSync(historyFile, '[]', 'utf-8');
    }
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Upload ảnh reference
app.post('/api/upload-reference', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({
    success: true,
    filename: req.file.filename,
    path: req.file.path,
    url: `/uploads/${req.file.filename}`,
    size: req.file.size
  });
});

// === Cookie Management ===
const cookieFile = path.join(userDataDir, 'cookies.json');

// Inject cookies vào Chrome (tự mở Chrome + inject + mở Flow)
app.post('/api/cookies', async (req, res) => {
  const { cookies, projectUrl } = req.body;
  if (!cookies) return res.status(400).json({ error: 'Cookies required' });

  // Lưu cookies ra file để tái sử dụng (mã hóa)
  try {
    const rawData = typeof cookies === 'string' ? cookies : JSON.stringify(cookies, null, 2);
    const encryptedData = auth.encryptData(rawData);
    fs.writeFileSync(cookieFile, encryptedData || rawData, 'utf-8');
  } catch (e) {
    console.error('Lỗi lưu cookie file:', e.message);
  }

  // Trả lời ngay lập tức — Chrome launch chạy nền, kết quả gửi qua WebSocket
  res.json({ success: true, launching: true, count: 0 });

  // Chạy nền
  setImmediate(async () => {
    try {
      const result = await automation.launchWithCookies(cookies, projectUrl);
      if (result.success) {
        automation._lastCookieCount = result.count;
        io.emit('connected', true);
        io.emit('cookiesSet', { count: result.count });
      } else if (result.error !== 'already_launching') {
        io.emit('launchError', { error: result.error });
      }
    } catch (e) {
      io.emit('launchError', { error: e.message });
    }
  });
});

// Lấy cookies đã lưu
app.get('/api/cookies', (req, res) => {
  try {
    if (fs.existsSync(cookieFile)) {
      const data = fs.readFileSync(cookieFile, 'utf-8');
      const decryptedData = auth.decryptData(data);
      res.json({ success: true, cookies: decryptedData || data });
    } else {
      res.json({ success: true, cookies: '' });
    }
  } catch (e) {
    res.json({ success: false, cookies: '', error: e.message });
  }
});

// Xóa cookies đã lưu
app.delete('/api/cookies', (req, res) => {
  try {
    if (fs.existsSync(cookieFile)) fs.unlinkSync(cookieFile);
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
// Option A: Cookie Pool endpoints (DYNAMIC — unlimited slots)
// ═══════════════════════════════════════════════════════════════════

const COOKIE_EXPIRY_MS = 18 * 60 * 60 * 1000; // 18 hours
const poolMetaFile = path.join(userDataDir, 'cookie_pool_meta.json');

function cookieSlotPath(slot) {
  return path.join(userDataDir, `cookies_slot${slot}.json`);
}

function _loadPoolMeta() {
  try {
    if (fs.existsSync(poolMetaFile)) {
      return JSON.parse(fs.readFileSync(poolMetaFile, 'utf-8'));
    }
  } catch { /* ignore */ }
  return { slots: {} };
}

function _savePoolMeta(meta) {
  try {
    fs.writeFileSync(poolMetaFile, JSON.stringify(meta, null, 2), 'utf-8');
  } catch (e) { console.error('poolMeta write error:', e.message); }
}

function _buildSlotList(meta, poolStatus) {
  // Discover all cookies_slot*.json files on disk (allows unlimited slots)
  const files = fs.readdirSync(userDataDir)
    .filter(f => /^cookies_slot(\d+)\.json$/.test(f))
    .map(f => parseInt(f.match(/\d+/)[0], 10))
    .sort((a, b) => a - b);

  // Include any extra slots recorded in meta even if file was deleted
  const metaSlots = Object.keys(meta.slots || {}).map(Number);
  const allSlots = [...new Set([...files, ...metaSlots])].sort((a, b) => a - b);

  const now = Date.now();
  return allSlots.map(i => {
    const filePath = cookieSlotPath(i);
    const exists = fs.existsSync(filePath);
    const slotMeta = (meta.slots || {})[String(i)] || {};
    const savedAt = slotMeta.savedAt || null;
    const expiresAt = slotMeta.expiresAt || (savedAt ? savedAt + COOKIE_EXPIRY_MS : null);
    const remainingMs = expiresAt ? Math.max(0, expiresAt - now) : null;
    const isExpired = expiresAt ? now >= expiresAt : false;

    let cookieCount = 0;
    if (exists) {
      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const dec = auth.decryptData(raw);
        const parsed = JSON.parse(dec || raw);
        cookieCount = Array.isArray(parsed) ? parsed.length : 0;
      } catch { cookieCount = 1; }
    }

    return {
      slot: i,
      label: slotMeta.label || `Account ${i + 1}`,
      exists,
      cookieCount,
      isActive: poolStatus ? poolStatus.activeIndex === i : i === 0,
      savedAt,
      expiresAt,
      remainingMs,
      isExpired,
    };
  });
}

// GET /api/cookie-pool — list all slots with expiry status
app.get('/api/cookie-pool', (req, res) => {
  try {
    const meta = _loadPoolMeta();
    const poolStatus = (automation && automation._tokenManager && typeof automation._tokenManager.getPoolStatus === 'function')
      ? automation._tokenManager.getPoolStatus()
      : null;
    const slots = _buildSlotList(meta, poolStatus);
    const activeIndex = poolStatus ? poolStatus.activeIndex : 0;
    const switchCount = poolStatus ? poolStatus.switchCount : 0;
    const recaptchaTotalCount = poolStatus ? poolStatus.recaptchaTotalCount : 0;
    res.json({ success: true, slots, activeIndex, switchCount, recaptchaTotalCount, cookieExpiryMs: COOKIE_EXPIRY_MS });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/cookie-pool — save/update a specific slot (any non-negative index)
app.post('/api/cookie-pool', async (req, res) => {
  try {
    const { slot, cookies, label } = req.body;
    if (slot == null || slot < 0 || !Number.isInteger(slot)) {
      return res.status(400).json({ success: false, error: 'Slot phải là số nguyên không âm' });
    }
    if (!cookies) return res.status(400).json({ success: false, error: 'Cookies required' });

    const rawData = typeof cookies === 'string' ? cookies : JSON.stringify(cookies, null, 2);
    
    // Parse cookies to string format and check session
    let cookieStr = '';
    let parsedArray = null;
    try {
      parsedArray = JSON.parse(rawData);
      cookieStr = Array.isArray(parsedArray) ? parsedArray.map(c => `${c.name}=${c.value}`).join('; ') : rawData;
    } catch { cookieStr = rawData; }

    try {
      const { gotScraping } = await import('got-scraping');
      const testRes = await gotScraping({
        url: 'https://labs.google/fx/vi/tools/flow/',
        headers: {
          'Cookie': cookieStr,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36'
        },
        responseType: 'text',
        throwHttpErrors: false
      });
      // If we are redirected to the Google login page, then the cookie doesn't have an active session
      if (testRes.statusCode >= 400 || testRes.url.includes('accounts.google.com')) {
        return res.status(400).json({ success: false, error: 'Cookie phiên bản lỗi hoặc đã hết hạn thực tế! Vui lòng làm mới lại.' });
      }
    } catch (err) {
       console.warn('[Server] Error while checking session API:', err.message);
    }

    // Determine actual expiration date from __Secure-next-auth.session-token
    let customExpiresAt = Date.now() + COOKIE_EXPIRY_MS;
    if (Array.isArray(parsedArray)) {
      const tokens = parsedArray.filter(c => c.name && c.name.includes('session-token') && c.expirationDate);
      const target = tokens.length > 0 ? tokens[0] : parsedArray.find(c => c.expirationDate);
      if (target && target.expirationDate) {
        // expirationDate is often in seconds
        customExpiresAt = Math.floor(target.expirationDate * 1000);
      }
    }
    // Google cookies report 30-day life, but practical session logic limits it closer to ~18-24 hrs. 
    // We cap it to COOKIE_EXPIRY_MS to prevent displaying "719h".
    customExpiresAt = Math.min(customExpiresAt, Date.now() + COOKIE_EXPIRY_MS);

    const encryptedData = auth.encryptData(rawData);
    const filePath = cookieSlotPath(slot);
    fs.writeFileSync(filePath, encryptedData || rawData, 'utf-8');

    // Update metadata with savedAt timestamp
    const meta = _loadPoolMeta();
    if (!meta.slots) meta.slots = {};
    meta.slots[String(slot)] = {
      savedAt: Date.now(),
      expiresAt: customExpiresAt,
      label: label || meta.slots[String(slot)]?.label || `Account ${slot + 1}`,
    };
    _savePoolMeta(meta);

    // Also update token_manager's dynamic pool if running
    if (automation && automation._tokenManager) {
      automation._tokenManager._rebuildCookiePool();
    }

    let cookieCount = 0;
    try {
      const parsed = JSON.parse(rawData);
      cookieCount = Array.isArray(parsed) ? parsed.length : 1;
    } catch { cookieCount = rawData.split(';').filter(Boolean).length || 1; }

    res.json({ success: true, slot, cookieCount, savedAt: meta.slots[String(slot)].savedAt, expiresAt: customExpiresAt });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// DELETE /api/cookie-pool/:slot — remove a slot
app.delete('/api/cookie-pool/:slot', (req, res) => {
  try {
    const slot = parseInt(req.params.slot, 10);
    if (isNaN(slot) || slot < 0) {
      return res.status(400).json({ success: false, error: 'Slot không hợp lệ' });
    }
    const filePath = cookieSlotPath(slot);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

    // Remove from metadata
    const meta = _loadPoolMeta();
    if (meta.slots) delete meta.slots[String(slot)];
    _savePoolMeta(meta);

    if (automation && automation._tokenManager) {
      automation._tokenManager._rebuildCookiePool();
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// PATCH /api/cookie-pool/:slot — rename a slot label
app.patch('/api/cookie-pool/:slot', (req, res) => {
  try {
    const slot = parseInt(req.params.slot, 10);
    const { label } = req.body;
    if (isNaN(slot) || slot < 0) return res.status(400).json({ success: false, error: 'Slot không hợp lệ' });
    const meta = _loadPoolMeta();
    if (!meta.slots) meta.slots = {};
    if (!meta.slots[String(slot)]) meta.slots[String(slot)] = {};
    meta.slots[String(slot)].label = label || `Account ${slot + 1}`;
    _savePoolMeta(meta);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/cookie-pool/switch — manually switch active account
app.post('/api/cookie-pool/switch', async (req, res) => {
  try {
    if (!automation || !automation._tokenManager) {
      return res.status(503).json({ success: false, error: 'TokenManager chưa khởi động' });
    }
    const { slot } = req.body;
    const tm = automation._tokenManager;

    if (slot != null) {
      // Switch to specific slot
      const slotFile = cookieSlotPath(slot);
      if (!fs.existsSync(slotFile)) {
        return res.status(400).json({ success: false, error: `Slot #${slot} không tồn tại hoặc chưa có cookie` });
      }
      tm._activeAccountIndex = slot;
      tm.config.cookieFile = slotFile;
      tm._recaptchaCallCount = 0;
      tm._recaptchaTotalCount = 0;
      tm._lastRecaptchaAt = 0;
      tm.clearWarmup();
      if (tm._cdp && tm._page) {
        await tm._injectCookies();
        await tm._rotateRecaptchaSession(`manual switch to slot #${slot}`);
      }
      tm.emit('account:switched', { from: null, to: slot, reason: 'manual', switchCount: tm._accountSwitchCount });
      io.emit('account:switched', { from: null, to: slot, reason: 'manual' });
      res.json({ success: true, activeIndex: slot });
    } else {
      // Rotate to next
      const switched = await tm.switchToNextAccount('manual');
      if (switched) {
        io.emit('account:switched', { to: tm._activeAccountIndex, reason: 'manual' });
        res.json({ success: true, activeIndex: tm._activeAccountIndex });
      } else {
        res.status(400).json({ success: false, error: 'Không có tài khoản dự phòng để chuyển' });
      }
    }
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});



// Auto-launch: reads the active slot cookie from disk and launches Chrome
// Used on startup where textareas haven't been populated yet
app.post('/api/auto-launch', async (req, res) => {
  const { projectUrl } = req.body || {};
  const meta = _loadPoolMeta();

  // Find the first valid, non-expired slot
  const files = fs.readdirSync(userDataDir)
    .filter(f => /^cookies_slot(\d+)\.json$/.test(f))
    .map(f => parseInt(f.match(/\d+/)[0], 10))
    .sort((a, b) => a - b);

  if (files.length === 0) {
    // Fall back to legacy cookies.json
    if (!fs.existsSync(cookieFile)) {
      return res.json({ success: false, error: 'no_cookies', message: 'Chưa có cookie nào được lưu' });
    }
    try {
      const raw = fs.readFileSync(cookieFile, 'utf-8');
      const cookies = auth.decryptData(raw) || raw;
      res.json({ success: true, launching: true });
      setImmediate(async () => {
        try {
          const result = await automation.launchWithCookies(cookies, projectUrl);
          if (result.success) {
            automation._lastCookieCount = result.count;
            io.emit('connected', true);
            io.emit('cookiesSet', { count: result.count });
          } else if (result.error !== 'already_launching') {
            io.emit('launchError', { error: result.error });
          }
        } catch (e) { io.emit('launchError', { error: e.message }); }
      });
      return;
    } catch (e) {
      return res.json({ success: false, error: e.message });
    }
  }

  // Try each slot in order until we find a valid one
  const now = Date.now();
  let chosenSlot = null;
  for (const slotIdx of files) {
    const slotMeta = (meta.slots || {})[String(slotIdx)] || {};
    const savedAt = slotMeta.savedAt || null;
    const expiresAt = savedAt ? savedAt + COOKIE_EXPIRY_MS : null;
    if (!expiresAt || now < expiresAt) {
      chosenSlot = slotIdx;
      break;
    }
  }
  // If all expired, use the first one anyway
  if (chosenSlot == null) chosenSlot = files[0];

  try {
    const slotPath = cookieSlotPath(chosenSlot);
    const raw = fs.readFileSync(slotPath, 'utf-8');
    const cookies = auth.decryptData(raw) || raw;
    const slotMeta = (meta.slots || {})[String(chosenSlot)] || {};
    const label = slotMeta.label || `Account ${chosenSlot + 1}`;

    res.json({ success: true, launching: true, slot: chosenSlot, label });
    setImmediate(async () => {
      try {
        const result = await automation.launchWithCookies(cookies, projectUrl);
        if (result.success) {
          automation._lastCookieCount = result.count;
          io.emit('connected', true);
          io.emit('cookiesSet', { count: result.count, slot: chosenSlot, label });
        } else if (result.error !== 'already_launching') {
          io.emit('launchError', { error: result.error });
        }
      } catch (e) { io.emit('launchError', { error: e.message }); }
    });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Kết nối Chrome
app.post('/api/connect', async (req, res) => {
  const { port = 9222 } = req.body;
  const result = await automation.connect(port);
  res.json(result);
});

// Bắt đầu tạo video (prompt mode)
app.post('/api/start', async (req, res) => {
  const { prompts, settings } = req.body;

  if (!prompts || !Array.isArray(prompts) || prompts.length === 0) {
    return res.status(400).json({ error: 'Danh sách prompt không hợp lệ' });
  }

  const isQueued = automation.isRunning;
  automation.start(prompts, settings);

  res.json({
    success: true,
    message: isQueued
      ? `⏳ Đã thêm ${prompts.length} prompt vào hàng đợi.`
      : `▶ Bắt đầu tạo ${prompts.length} video`
  });
});

// Bắt đầu workflow (fashion mode)
app.post('/api/start-workflow', async (req, res) => {
  const { config } = req.body;

  // Hỗ trợ cả tên biến cũ (outfits) và mới (tasks)
  const taskList = config.tasks || config.outfits;

  if (!config || !taskList || taskList.length === 0) {
    return res.status(400).json({ error: 'Cần ít nhất 1 tác vụ/outfit' });
  }

  const isQueued = automation.isRunning;

  automation.runWorkflow(config);

  res.json({
    success: true,
    message: isQueued
      ? `⏳ Đã thêm Workflow (${taskList.length} tác vụ) vào hàng đợi.`
      : `▶ Bắt đầu workflow với ${taskList.length} tác vụ`
  });
});

// Tạm dừng
app.post('/api/pause', (req, res) => {
  automation.pause();
  res.json({ success: true });
});

// Tiếp tục
app.post('/api/resume', (req, res) => {
  automation.resume();
  res.json({ success: true });
});

// Dừng
// app.post('/api/stop', (req, res) => {
//   automation.stop();
//   res.json({ success: true });
// });

app.post('/api/stop', (req, res) => {
  if (automation) automation.stop();
  res.json({ success: true });
});


// Dọn sạch hàng đợi (Queue)
app.post('/api/clear-queue', (req, res) => {
  if (automation) {
    automation.queue = [];
    automation.emitQueueUpdate();
  }
  res.json({ success: true });
});

// Xóa 1 tác vụ cụ thể trong hàng đợi
app.post('/api/remove-queue-item', (req, res) => {
  const { index } = req.body;
  if (automation && automation.queue[index]) {
    automation.queue.splice(index, 1); // Xóa khỏi mảng
    automation.emitQueueUpdate();      // Vẽ lại giao diện
  }
  res.json({ success: true });
});

// Bỏ qua (Skip) tác vụ đang chạy hiện tại
app.post('/api/skip-current', (req, res) => {
  if (automation) {
    automation.skipCurrent();
  }
  res.json({ success: true });
});

// Trạng thái
app.get('/api/status', (req, res) => {
  res.json(automation.getStatus());
});

// === Workflow Builder API ===
const workflowsDir = path.join(userDataDir, 'workflows');
if (!fs.existsSync(workflowsDir)) fs.mkdirSync(workflowsDir, { recursive: true });

// List all workflows
app.get('/api/workflows', (req, res) => {
  try {
    const files = fs.readdirSync(workflowsDir).filter(f => f.endsWith('.json'));
    const workflows = files.map(f => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(workflowsDir, f), 'utf-8'));
        return { id: data.id, name: data.name, nodes: data.nodes, createdAt: data.createdAt };
      } catch { return null; }
    }).filter(Boolean);
    res.json({ success: true, workflows });
  } catch (e) {
    res.json({ success: true, workflows: [] });
  }
});

// Get single workflow
app.get('/api/workflows/:id', (req, res) => {
  try {
    const filePath = path.join(workflowsDir, `${req.params.id}.json`);
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      res.json({ success: true, workflow: data });
    } else {
      res.status(404).json({ success: false, error: 'Not found' });
    }
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Save workflow
app.post('/api/workflows', (req, res) => {
  try {
    const wf = req.body;
    if (!wf.id) wf.id = 'wf_' + Date.now();
    const filePath = path.join(workflowsDir, `${wf.id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(wf, null, 2), 'utf-8');
    res.json({ success: true, id: wf.id });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Update workflow
app.put('/api/workflows/:id', (req, res) => {
  try {
    const wf = req.body;
    wf.id = req.params.id;
    const filePath = path.join(workflowsDir, `${req.params.id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(wf, null, 2), 'utf-8');
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Delete workflow
app.delete('/api/workflows/:id', (req, res) => {
  try {
    const filePath = path.join(workflowsDir, `${req.params.id}.json`);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Run workflow builder
app.post('/api/run-workflow-builder', async (req, res) => {
  const { workflow } = req.body;
  if (!workflow || !workflow.nodes || workflow.nodes.length === 0) {
    return res.status(400).json({ success: false, error: 'Workflow trống' });
  }

  const isQueued = automation.isRunning;

  // Truyền thẳng vào class, class sẽ tự quyết định chạy luôn hay ném vào queue
  automation.runBuilderWorkflow(workflow);

  res.json({
    success: true,
    message: isQueued
      ? `⏳ Đã thêm Workflow "${workflow.name}" vào hàng đợi (Vị trí: ${automation.queue.length})`
      : `▶ Bắt đầu Workflow "${workflow.name}" (${workflow.nodes.length} nodes)`
  });
});

// Pause / Resume / Stop riêng cho Builder Workflow
app.post('/api/workflow-builder-pause', (req, res) => {
  if (automation) {
    automation.pause();
  }
  // Giữ lại lệnh emit này để nút của Builder cũng chuyển sang màu cam
  io.emit('wf-builder-status', { state: 'paused', message: 'Hàng đợi đang tạm dừng' });
  res.json({ success: true });
});

app.post('/api/workflow-builder-resume', (req, res) => {
  if (automation) {
    automation.resume();
  }
  res.json({ success: true });
});

// app.post('/api/workflow-builder-stop', (req, res) => {
//   automation.isRunning = false;
//   automation.isPaused = false;
//   io.emit('wf-builder-status', { state: 'idle', message: '⏹️ Đã dừng workflow' });
//   res.json({ success: true });
// });

app.post('/api/workflow-builder-stop', (req, res) => {
  if (automation) {
    automation.stop();
  }
  // Bỏ dòng io.emit('wf-builder-status', { state: 'idle' }) ở đây!
  res.json({ success: true });
});


// Dọn sạch hàng đợi (Queue)
app.post('/api/clear-queue', (req, res) => {
  if (automation) {
    automation.queue = []; // Xóa sạch mảng hàng đợi trong backend
    automation.emitQueueUpdate(); // Báo cho Frontend vẽ lại UI (hiện trạng thái trống)
  }
  res.json({ success: true });
});



// Run single node
app.post('/api/run-single-node', async (req, res) => {
  const { workflow, nodeId } = req.body;
  if (!workflow || !nodeId) {
    return res.status(400).json({ success: false, error: 'Cần workflow và nodeId' });
  }

  const isQueued = automation.isRunning;

  automation.runSingleNode(workflow, nodeId);

  res.json({
    success: true,
    message: isQueued
      ? `⏳ Đã thêm Node ${nodeId} vào hàng đợi.`
      : `▶ Chạy riêng node ${nodeId}`
  });
});



// =================================================================
// 🛒 STORE API — Proxy sang workflowgiare.com (Tool Server thật)
// =================================================================

/** Helper: proxy GET/POST request lên Tool Server production */
async function _proxyToServer(req, res, method = 'GET', bodyData = null) {
  try {
    if (!auth.isLoggedIn()) {
      return res.status(401).json({ success: false, error: 'Chưa đăng nhập' });
    }

    const token = auth.license?.token || '';
    const webhookUrl = auth.getWebhookUrl(); // vd: https://workflowgiare.com/api/veo3
    const parsedWH = new URL(webhookUrl);
    const serverOrigin = parsedWH.origin;    // → https://workflowgiare.com

    // Tái tổ hợp URL với query string
    const urlPath = req.path + (req.search || (Object.keys(req.query).length ? '?' + new URLSearchParams(req.query).toString() : ''));
    const endpoint = serverOrigin + urlPath;

    const https = require('https');
    const http = require('http');
    const parsedUrl = new URL(endpoint);
    const protocol = parsedUrl.protocol === 'https:' ? https : http;
    const postData = bodyData ? JSON.stringify(bodyData) : null;

    const data = await new Promise((resolve, reject) => {
      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname + (parsedUrl.search || ''),
        method,
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'VEO3-Tool/1.0',
          ...(postData ? { 'Content-Length': Buffer.byteLength(postData) } : {})
        },
        timeout: 12000
      };
      const req2 = protocol.request(options, (proxyRes) => {
        let body = '';
        proxyRes.on('data', chunk => body += chunk);
        proxyRes.on('end', () => {
          try { resolve(JSON.parse(body)); }
          catch { reject(new Error('Server trả về dữ liệu không hợp lệ')); }
        });
      });
      req2.on('error', reject);
      req2.on('timeout', () => { req2.destroy(); reject(new Error('Timeout kết nối server')); });
      if (postData) req2.write(postData);
      req2.end();
    });

    res.json(data);
  } catch (e) {
    console.error(`[Store Proxy] ${req.path}:`, e.message);
    res.json({ success: false, error: e.message });
  }
}

// GET /api/veo3/store/products — Lấy danh sách sản phẩm
app.get('/api/veo3/store/products', (req, res) => _proxyToServer(req, res, 'GET'));

// POST /api/veo3/store/purchase — Mua sản phẩm
app.post('/api/veo3/store/purchase', (req, res) => _proxyToServer(req, res, 'POST', req.body));

// GET /api/veo3/store/orders — Lịch sử đơn hàng
app.get('/api/veo3/store/orders', (req, res) => _proxyToServer(req, res, 'GET'));

// GET /api/veo3/store/orders/:id — Chi tiết đơn hàng
app.get('/api/veo3/store/orders/:id', (req, res) => _proxyToServer(req, res, 'GET'));

// POST /api/veo3/store/confirm-payment — Xác nhận thanh toán
app.post('/api/veo3/store/confirm-payment', (req, res) => _proxyToServer(req, res, 'POST', req.body));


// =================================================================
// 🛡️ API SAFETY NET: Force JSON errors instead of HTML crashes
// =================================================================

// 1. Handle 404s for API routes so they don't return HTML
app.use('/api/*', (req, res) => {
  res.status(404).json({ success: false, error: 'API endpoint not found' });
});

// 2. Global Error Handler for Express (Catches PayloadTooLarge, etc.)
app.use((err, req, res, next) => {
  if (err) {
    console.error('❌ Express Error:', err.message);

    // Check if it's a payload size error
    const isTooLarge = err.type === 'entity.too.large';
    const message = isTooLarge
      ? 'Dữ liệu gửi lên quá lớn (Vượt quá giới hạn bộ nhớ). Hãy xóa bớt file hoặc refresh lại UI.'
      : err.message;

    return res.status(err.status || 500).json({
      success: false,
      error: message
    });
  }
  next();
});


// === WebSocket + Auto-Shutdown khi đóng Chrome ===
let connectedClients = 0;
let shutdownTimer = null;
const SHUTDOWN_DELAY_MS = 3000; // Chờ 3 giây sau khi tất cả clients ngắt kết nối

function scheduleShutdown() {
  if (shutdownTimer) return; // Đã có timer rồi
  console.log(`\n⚠️  Tất cả clients đã đóng. Server sẽ tắt sau ${SHUTDOWN_DELAY_MS / 1000} giây...`);
  shutdownTimer = setTimeout(async () => {
    console.log('🔴 Đang tắt server để giải phóng cổng...');
    try {
      if (automation && typeof automation.closeBrowser === 'function') {
        await automation.closeBrowser();
      }
    } catch (_) { }
    server.close(() => {
      console.log('✅ Server đã tắt hoàn toàn.');
      process.exit(0);
    });
    // Force exit nếu server.close() không kịp
    setTimeout(() => process.exit(0), 3000);
  }, SHUTDOWN_DELAY_MS);
}

function cancelShutdown() {
  if (shutdownTimer) {
    clearTimeout(shutdownTimer);
    shutdownTimer = null;
    console.log('✅ Client kết nối lại — hủy lệnh tắt server.');
  }
}



io.on('connection', async (socket) => {
  connectedClients++;
  cancelShutdown();
  console.log(`Client kết nối WebSocket (tổng: ${connectedClients})`);
  socket.emit('status', automation.getStatus());

  try {
    const isAlive = !!(automation.browser && automation.page);
    socket.emit('connected', isAlive);
    if (isAlive) {
      const cookieCount = automation._lastCookieCount || 0;
      if (cookieCount > 0) socket.emit('cookiesSet', { count: cookieCount });
    }
  } catch (_) { }

  // Kiểm tra ngay khi client kết nối: nếu license đã bị clear (bị ban/expire
  // trong khi offline hoặc poll đã chạy trước khi browser kết nối), kick ngay
  if (!auth.isLoggedIn()) {
    // Tài khoản đã bị clear (bị kick bởi poll trước) — báo ngay cho client này
    const wasLoggedIn = !!auth._lastKnownExpiredReason;
    if (wasLoggedIn) {
      console.log('[Auth] Client kết nối nhưng session đã bị clear. Emit auth:expired.');
      socket.emit('auth:expired', {
        error: auth._lastKnownExpiredReason || 'Tài khoản bị khóa hoặc hết hạn. Vui lòng đăng nhập lại.'
      });
    }
  } else {
    // Đã đăng nhập — nếu là client đầu tiên VÀ polling chưa chạy thì khởi động
    if (connectedClients === 1 && !auth._verifyTimer) {
      console.log('[Auth] Client đầu tiên kết nối — bật session-check polling.');
      auth.startPeriodicVerify(io);
      auth.startUsageTimer(); // bắt đầu đếm thời gian sử dụng
    }
  }

  socket.on('disconnect', async () => {
    connectedClients = Math.max(0, connectedClients - 1);
    console.log(`Client ngắt kết nối (còn lại: ${connectedClients})`);

    if (connectedClients === 0) {
      console.log('Tất cả clients đã ngắt kết nối. Đang đóng Chrome để tiết kiệm RAM...');
      if (typeof automation !== 'undefined' && automation) {
        await automation.closeBrowser();
      }
    }
  });
});

// === Start Server ===
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   🎬  Workflow AI Giá Rẻ - Control Panel        ║');
  console.log('║                                              ║');
  console.log(`║   Server: http://localhost:${PORT}              ║`);
  console.log('║                                              ║');
  console.log('║   Hướng dẫn:                                 ║');
  console.log('║   1. Mở Chrome: --remote-debugging-port=9222 ║');
  console.log('║   2. Đăng nhập Google Flow trong Chrome      ║');
  console.log('║   3. Mở http://localhost:3000 để điều khiển  ║');
  console.log('╚══════════════════════════════════════════════╝');

  if (auth.isLoggedIn()) {
    const user = auth.getStatus().user;
    console.log(`  👤 Đã đăng nhập: ${user.email || user.name} (${(user.plan || 'trial').toUpperCase()})`);
    // Bắt đầu polling ngay khi server start — không cần chờ browser/WebSocket kết nối
    // io.emit sẽ tự broadcast đến tất cả socket khi có client nào connect
    auth.startPeriodicVerify(io);
    auth.startUsageTimer(); // bắt đầu đếm thời gian sử dụng
    console.log('  🔄 Session-check polling đã bật.');
  } else {
    console.log('  🔐 Chưa đăng nhập — truy cập http://localhost:3000/login.html');
  }
  console.log('');
});


// === Flush Usage Timer khi App tat ===
process.on('SIGINT', () => { auth.stopUsageTimer(true); setTimeout(() => process.exit(0), 1200); });
process.on('SIGTERM', () => { auth.stopUsageTimer(true); setTimeout(() => process.exit(0), 1200); });
