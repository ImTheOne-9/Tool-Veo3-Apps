// === VEO3 Auth Module ===
// Quản lý đăng ký, đăng nhập, xác thực license qua webhook

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const os = require('os');

const userDataDir = path.join(os.homedir(), 'Veo3Data');
if (!fs.existsSync(userDataDir)) {
  fs.mkdirSync(userDataDir, { recursive: true });
}

const LICENSE_PATH = path.join(userDataDir, 'license.json');

class AuthManager {
  constructor() {
    this.config = this._loadConfig();
    this._cachedHwid = this._loadHwidCache();
    this.license = this._loadLicense();
    this._verifyTimer = null;
    this._lastKnownExpiredReason = null; // Lưu lý do bị kick để thông báo client mới
    this._usageTimer = null;             // setInterval ping usage mỗi 1h
    this._usageSessionStart = null;      // thời điểm bắt đầu tiến trình đếm gần nhất
  }

  // ─── Config (hardcoded để bảo mật sau khi bytenode compile) ──────────────
  _loadConfig() {
    return {
      webhookBaseUrl: 'https://workflowgiare.com/api/veo3',
      appName: 'VEO3 Flow Automation',
      trialDays: 3,
      checkIntervalMs: 300000,
      offlineGracePeriodMs: 86400000
    };
  }

  // ─── License File ──────────────────────────────────
  _loadLicense() {
    try {
      if (fs.existsSync(LICENSE_PATH)) {
        const raw = fs.readFileSync(LICENSE_PATH, 'utf-8').trim();

        // Thử decrypt trước
        const decrypted = this.decryptData(raw);
        if (decrypted) {
          try {
            return JSON.parse(decrypted);
          } catch (e) {
            // JSON bên trong không hợp lệ — xóa file lỗi
            this._clearLicense();
            return null;
          }
        }

        // Fallback: thử parse JSON thuần (file cũ chưa mã hóa)
        try {
          const parsed = JSON.parse(raw);
          if (parsed && parsed.token) {
            // Tự động mã hóa và lưu lại để migrate sang format mới
            setTimeout(() => {
              try { this._saveLicense(parsed); } catch (e) {}
            }, 100);
            return parsed;
          }
        } catch (e) {
          // Không phải JSON thuần và decrypt cũng fail — file bị hỏng
          console.warn('[Auth] License file bị hỏng (không decrypt và không parse được JSON). Xóa...');
          this._clearLicense();
        }
      }
    } catch (e) {
      console.warn('[Auth] Lỗi đọc license file:', e.message);
    }
    return null;
  }

  _saveLicense(data) {
    this.license = data;
    const raw = JSON.stringify(data, null, 2);
    const encrypted = this.encryptData(raw);
    fs.writeFileSync(LICENSE_PATH, encrypted || raw, 'utf-8');
  }

  _clearLicense(reason) {
    if (reason) this._lastKnownExpiredReason = reason; // Lưu lý do bị kick
    this.license = null;
    try { fs.unlinkSync(LICENSE_PATH); } catch { }
  }

  // ─── HWID Cache (persist to disk) ─────────────────
  _loadHwidCache() {
    try {
      const hwidFile = path.join(userDataDir, '.hwid');
      if (fs.existsSync(hwidFile)) {
        const cached = fs.readFileSync(hwidFile, 'utf-8').trim();
        // Validate: phải là hex 32 ký tự
        if (cached && /^[a-f0-9]{32}$/i.test(cached)) {
          return cached;
        }
      }
    } catch (e) {}
    return null; // Chưa có cache, sẽ tạo mới trong getHWID()
  }

  _saveHwidCache(hwid) {
    try {
      const hwidFile = path.join(userDataDir, '.hwid');
      fs.writeFileSync(hwidFile, hwid, 'utf-8');
    } catch (e) {}
  }

  // ─── Hardware ID ───────────────────────────────────
  getHWID() {
    if (this._cachedHwid) return this._cachedHwid;

    let raw = os.hostname() + '|' + os.platform() + '|' + os.arch();
    const cpus = os.cpus();
    if (cpus && cpus.length > 0) raw += '|' + cpus[0].model;

    let osUuid = '';
    try {
      const { execSync } = require('child_process');
      if (os.platform() === 'win32') {
        const output = execSync('REG QUERY HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography /v MachineGuid', { encoding: 'utf8', stdio: 'pipe' });
        const match = output.match(/[a-f0-9]{8}-([a-f0-9]{4}-){3}[a-f0-9]{12}/i);
        if (match) osUuid = match[0];
      } else if (os.platform() === 'darwin') {
        const output = execSync('ioreg -rd1 -c IOPlatformExpertDevice | grep IOPlatformUUID', { encoding: 'utf8', stdio: 'pipe' });
        const match = output.match(/"IOPlatformUUID" = "([^"]+)"/);
        if (match) osUuid = match[1];
      }
    } catch (e) {}

    if (osUuid) {
      raw += '|' + osUuid;
    } else {
      // Fallback ổn định bằng cách lấy tất cả MAC và sort
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

    this._cachedHwid = crypto.createHash('sha256').update(raw).digest('hex').substring(0, 32);
    // Lưu HWID vào disk để giữ ổn định giữa các lần khởi động
    this._saveHwidCache(this._cachedHwid);
    return this._cachedHwid;
  }

  // ─── Encryption / Decryption ──────────────────────
  encryptData(text) {
    try {
      const key = crypto.createHash('sha256').update(this.getHWID()).digest();
      const iv = crypto.randomBytes(16);
      const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
      let encrypted = cipher.update(text, 'utf8', 'hex');
      encrypted += cipher.final('hex');
      return iv.toString('hex') + ':' + encrypted;
    } catch (e) {
      return null;
    }
  }

  decryptData(encryptedText) {
    try {
      if (!encryptedText || !encryptedText.includes(':')) return null;
      const parts = encryptedText.split(':');
      if (parts.length < 2) return null;
      const iv = Buffer.from(parts[0], 'hex');
      // Ghép lại phần còn lại (tránh bị cắt nếu encrypted hex vô tình chứa ':')
      const encrypted = parts.slice(1).join(':');
      const key = crypto.createHash('sha256').update(this.getHWID()).digest();
      const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
      let decrypted = decipher.update(encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
    } catch (e) {
      return null;
    }
  }

  // ─── Hash Password ────────────────────────────────
  _hashPassword(password) {
    return crypto.createHash('sha256').update(password + '_veo3_salt').digest('hex');
  }

  // ─── HTTP Request Helper ──────────────────────────
  _request(method, endpoint, body) {
    return new Promise((resolve, reject) => {
      const url = new URL(endpoint, this.config.webhookBaseUrl);
      // Đảm bảo URL kết thúc đúng
      const fullUrl = this.config.webhookBaseUrl.replace(/\/$/, '') + '/' + endpoint.replace(/^\//, '');

      let parsedUrl;
      try {
        parsedUrl = new URL(fullUrl);
      } catch (e) {
        return reject(new Error('URL webhook không hợp lệ: ' + fullUrl));
      }

      const postData = JSON.stringify(body);
      const protocol = parsedUrl.protocol === 'https:' ? https : http;

      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: method,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
          'User-Agent': 'VEO3-Tool/1.0',
          'X-Tool-Version': '1.0.0'
        },
        timeout: 15000
      };

      // Thêm auth token nếu có
      if (this.license && this.license.token) {
        options.headers['Authorization'] = 'Bearer ' + this.license.token;
      }

      const req = protocol.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, data: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode, data: { error: 'Invalid JSON response', raw: data } });
          }
        });
      });

      req.on('error', (e) => reject(e));
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
      req.write(postData);
      req.end();
    });
  }

  // ─── Register ─────────────────────────────────────
  async register(email, password, name, phone) {
    try {
      const res = await this._request('POST', 'register', {
        email: email.trim().toLowerCase(),
        password: this._hashPassword(password),
        name: name.trim(),
        phone: phone ? phone.trim() : undefined,
        hwid: this.getHWID(),
        tool_version: '1.0.0',
        machine_name: os.hostname(),
        platform: os.platform(),
        registered_at: new Date().toISOString()
      });

      if (res.status >= 200 && res.status < 300 && res.data.success) {
        this._saveLicense({
          token: res.data.token,
          user: res.data.user,
          lastVerified: Date.now(),
          hwid: this.getHWID()
        });
        return { success: true, user: res.data.user, message: res.data.message || 'Đăng ký thành công!' };
      } else {
        return { success: false, error: res.data.error || res.data.message || `Server trả về lỗi (${res.status})` };
      }
    } catch (e) {
      return { success: false, error: 'Không kết nối được server: ' + e.message };
    }
  }

  // ─── Login ────────────────────────────────────────
  async login(email, password) {
    try {
      const res = await this._request('POST', 'login', {
        email: email.trim().toLowerCase(),
        password: this._hashPassword(password),
        hwid: this.getHWID(),
        tool_version: '1.0.0',
        machine_name: os.hostname()
      });

      if (res.status >= 200 && res.status < 300 && res.data.success) {
        this._saveLicense({
          token: res.data.token,
          user: res.data.user,
          lastVerified: Date.now(),
          hwid: this.getHWID()
        });
        return { success: true, user: res.data.user, message: res.data.message || 'Đăng nhập thành công!' };
      } else {
        return { success: false, error: res.data.error || res.data.message || `Sai email hoặc mật khẩu (${res.status})` };
      }
    } catch (e) {
      return { success: false, error: 'Không kết nối được server: ' + e.message };
    }
  }

  async verify() {
    if (!this.license || !this.license.token) {
      return { valid: false, error: 'Chưa đăng nhập' };
    }

    try {
      const res = await this._request('POST', 'verify', {
        token: this.license.token,
        hwid: this.getHWID(),
        tool_version: '1.0.0'
      });

      if (res.status >= 200 && res.status < 300 && res.data.valid) {
        // Cập nhật thông tin user (có thể server đã upgrade plan)
        this.license.user = res.data.user || this.license.user;
        this.license.lastVerified = Date.now();
        this._saveLicense(this.license);
        return {
          valid: true,
          user: this.license.user,
          message: res.data.message || ''
        };
      }

      // Chỉ kick khi server TRỶC TIẼP xác nhận không hợp lệ qua HTTP status:
      // - HTTP 403: bị ban hoặc hết hạn (server trả 403 tường minh)
      // - HTTP 401: token không hợp lệ / đã xóa
      // KHÔNG kick khi HTTP 200 + valid:false (có thể là HWID mismatch, lỗi nhỏ,
      // hoặc response thiếu field valid) — tránh logout nhầm tài khoản hợp lệ
      if (res.status === 401 || res.status === 403) {
        // Xử lý riêng trường hợp email chưa xác thực
        if (res.data.needVerify) {
          return {
            valid: false,
            explicit: true,
            needVerify: true,
            email: res.data.email || '',
            error: res.data.error || 'Email chưa được xác thực.'
          };
        }
        return {
          valid: false,
          explicit: true,
          error: res.data.error || res.data.message || 'Tài khoản không hợp lệ hoặc đã hết hạn',
          expired: res.data.expired || false,
          banned: res.data.banned || false
        };
      }

      // Mọi status khác (5xx, 429, ...) → coi như server lỗi tạm, không force logout
      console.warn('[Auth] Server trả status', res.status, '- coi như offline tạm thời.');
      throw new Error('Server error ' + res.status);

    } catch (e) {
      // Offline / lỗi mạng / server 5xx — kiểm tra grace period
      if (this.license.lastVerified) {
        const elapsed = Date.now() - this.license.lastVerified;
        if (elapsed < this.config.offlineGracePeriodMs) {
          return {
            valid: true,
            user: this.license.user,
            message: '⚠️ Offline mode — dùng tạm, cần kết nối internet để verify',
            offline: true
          };
        }
      }
      return { valid: false, error: 'Không kết nối được server và hết thời gian offline' };
    }
  }

  // ─── Logout ──────────────────────────────────────────
  logout() {
    this.stopUsageTimer(true); // flush phút còn lại trước khi logout
    this._clearLicense();
    this._lastKnownExpiredReason = null;
    this.stopPeriodicVerify();
    return { success: true };
  }

  // ─── Get Auth Status ──────────────────────────────
  getStatus() {
    if (!this.license || !this.license.token) {
      return { loggedIn: false };
    }
    return {
      loggedIn: true,
      user: this.license.user || {},
      hwid: this.license.hwid,
      lastVerified: this.license.lastVerified
    };
  }

  // ─── Is Logged In (quick check, no network) ──────
  isLoggedIn() {
    return !!(this.license && this.license.token);
  }

  // ─── Stop Polling ─────────────────────────────────
  stopPeriodicVerify() {
    if (this._verifyTimer) {
      clearInterval(this._verifyTimer);
      this._verifyTimer = null;
      console.log('[Auth] Session-check polling đã dừng.');
    }
  }

  // ─── Verify At Startup + Poll định kỳ ───────────────────────
  startPeriodicVerify(io) {
    this.stopPeriodicVerify();
    if (!this.isLoggedIn()) {
      console.log('[Auth] startPeriodicVerify: chưa đăng nhập, bỏ qua.');
      return;
    }
    console.log('[Auth] startPeriodicVerify: bắt đầu polling...');

    // Verify ngay khi startup
    setImmediate(async () => {
      if (!this.isLoggedIn()) return;
      console.log('[Auth] Startup verify đang chạy...');
      const result = await this.verify();
      console.log('[Auth] Startup verify kết quả:', JSON.stringify(result));
      if (result.needVerify) {
        // Email chưa xác thực — không xóa license, chỉ hiện cảnh báo
        console.log('[Auth] → Startup verify: email chưa xác thực, emit auth:needVerify');
        if (io) io.emit('auth:needVerify', { email: result.email, error: result.error });
        // Không xóa license — giữ session, chỉ chặn UI
      } else if (!result.valid && !result.offline) {
        console.log('[Auth] → Startup verify THẤT BẠI, emit auth:expired');
        if (io) io.emit('auth:expired', { error: result.error });
        this._clearLicense(result.error);
      } else if (result.valid) {
        console.log('[Auth] → Startup verify THÀNH CÔNG.');
      } else {
        console.log('[Auth] → Offline mode (grace period còn lại).');
      }
    });

    // Poll mỗi 30 giây (test) / đổi lại 3 * 60 * 1000 khi production
    const POLL_INTERVAL = 30 * 1000; // 30 giây để test nhanh
    this._verifyTimer = setInterval(async () => {
      if (!this.isLoggedIn()) {
        this.stopPeriodicVerify();
        return;
      }
      console.log('[Auth] Session-check polling...');
      try {
        const result = await this._sessionCheck();
        console.log('[Auth] Session-check kết quả:', JSON.stringify(result));
        if (result.valid === false) { // strict false check — tránh kick khi result.valid = undefined
          console.log('[Auth] → Session-check THẤT BẠI — bị ban hoặc token hết hạn:', result.reason);
          this._clearLicense(result.error || 'Tài khoản bị khóa hoặc hết hạn.'); // Lưu lý do
          if (io) {
            io.emit('auth:expired', {
              error: result.error || 'Tài khoản bị khóa hoặc hết hạn. Vui lòng đăng nhập lại.',
              banned: result.reason === 'banned'
            });
          }
          this.stopPeriodicVerify();
        } else {
          // ─── Detect plan upgrade/downgrade (thanh toán web hoặc admin cấp) ───────
          const prevPlan   = this.license?.user?.plan    || 'trial';
          const newPlan    = result.plan                 || prevPlan;
          const newExpires = result.expires_at !== undefined ? result.expires_at : (this.license?.user?.expires_at);

          if (newPlan !== prevPlan) {
            console.log(`[Auth] → Plan change: ${prevPlan.toUpperCase()} → ${newPlan.toUpperCase()}!`);
            // Chỉ cập nhật in-memory, KHOONG gọi _saveLicense() vì hàm đó ghi đè this.license = data
            // nếu gọi không argument sẽ làm this.license = undefined -> isLoggedIn() = false -> poll dừng
            if (this.license && this.license.user) {
              this.license.user.plan       = newPlan;
              this.license.user.expires_at = newPlan === 'lifetime' ? null : newExpires;
            }
            try {
              if (io) io.emit('auth:planUpgraded', {
                plan:       newPlan,
                prevPlan,
                expires_at: this.license?.user?.expires_at
              });
            } catch (emitErr) {
              console.warn('[Auth] io.emit planUpgraded error:', emitErr.message);
            }
          }
          console.log('[Auth] → Session-check OK — tài khoản hợp lệ.');

        }
      } catch (e) {
        console.warn('[Auth] Session-check lỗi mạng, bỏ qua:', e.message);
      }
    }, POLL_INTERVAL);

    console.log(`[Auth] Đã bật session-check polling mỗi ${POLL_INTERVAL / 1000}s.`);
  }

  // ─── Session Check (GET lightweight) ─────────────────────────
  _sessionCheck() {
    return new Promise((resolve, reject) => {
      if (!this.license || !this.license.token) {
        return resolve({ valid: false, reason: 'no_token' });
      }

      const baseUrl = this.config.webhookBaseUrl.replace(/\/$/, '');
      const fullUrl = baseUrl + '/session-check';

      let parsedUrl;
      try {
        parsedUrl = new URL(fullUrl);
      } catch (e) {
        return reject(new Error('URL không hợp lệ: ' + fullUrl));
      }

      const protocol = parsedUrl.protocol === 'https:' ? require('https') : require('http');

      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname,
        method: 'GET',
        headers: {
          'Authorization': 'Bearer ' + this.license.token,
          'User-Agent': 'VEO3-Tool/1.0'
        },
        timeout: 10000
      };

      const req = protocol.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            // HTTP 403 = server xác nhận rõ bị ban/expire → luôn kick dù parse được hay không
            if (res.statusCode === 403 || res.statusCode === 401) {
              return resolve({ valid: false, reason: parsed.reason || 'unauthorized', error: parsed.error, action: 'logout' });
            }
            resolve(parsed);
          } catch {
            // Không parse được JSON (ví dụ lỗi HTML) → chỉ coi như lỗi nếu status không phải 4xx
            if (res.statusCode === 403 || res.statusCode === 401) {
              return resolve({ valid: false, reason: 'unauthorized', action: 'logout' });
            }
            resolve({ valid: true }); // Không parse được và không phải lỗi auth → bỏ qua
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
      req.end();
    });
  }



  // ─── Usage Timer (ping mỗi 1 giờ) ─────────────────────────────────────────
  startUsageTimer() {
    this.stopUsageTimer();
    if (!this.isLoggedIn()) return;
    const PING_INTERVAL_MS = 60 * 60 * 1000; // 1 giờ
    this._usageSessionStart = Date.now();
    this._usageTimer = setInterval(async () => {
      if (!this.isLoggedIn()) { this.stopUsageTimer(); return; }
      await this._pingUsage(60);
      this._usageSessionStart = Date.now();
    }, PING_INTERVAL_MS);
    console.log('[Auth] Usage timer bắt đầu (ping mỗi 1h).');
  }

  // flush=true: gửi nốt phút lẻ trước khi dừng
  stopUsageTimer(flush = false) {
    if (this._usageTimer) {
      clearInterval(this._usageTimer);
      this._usageTimer = null;
    }
    if (flush && this._usageSessionStart && this.isLoggedIn()) {
      const minutes = Math.floor((Date.now() - this._usageSessionStart) / 60000);
      if (minutes > 0) this._pingUsage(minutes).catch(() => {});
    }
    this._usageSessionStart = null;
  }

  // Gửi số phút lên server (silent fail, không block)
  _pingUsage(minutes) {
    return new Promise((resolve) => {
      if (!this.license?.token || minutes <= 0) return resolve();
      const fullUrl = this.config.webhookBaseUrl.replace(/\/$/, '') + '/ping-usage';
      let parsedUrl;
      try { parsedUrl = new URL(fullUrl); } catch { return resolve(); }
      const postData = JSON.stringify({ minutes });
      const protocol = parsedUrl.protocol === 'https:' ? https : http;
      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
          'Authorization': 'Bearer ' + this.license.token,
          'User-Agent': 'VEO3-Tool/1.0'
        },
        timeout: 10000
      };
      const req = protocol.request(options, (res) => {
        res.on('data', () => {});
        res.on('end', () => {
          console.log(`[Auth] Ping usage +${minutes}ph → HTTP ${res.statusCode}`);
          resolve();
        });
      });
      req.on('error', () => resolve());
      req.on('timeout', () => { req.destroy(); resolve(); });
      req.write(postData);
      req.end();
    });
  }

  // ─── Webhook URL Check ────────────────────────────

  isWebhookConfigured() {
    return this.config.webhookBaseUrl &&
      !this.config.webhookBaseUrl.includes('your-website.com');
  }

  getWebhookUrl() {
    return this.config.webhookBaseUrl;
  }

  updateWebhookUrl(url) {
    // Chỉ cập nhật in-memory, không ghi file (config đã được hardcode để bảo mật)
    this.config.webhookBaseUrl = url;
  }
}

module.exports = AuthManager;
