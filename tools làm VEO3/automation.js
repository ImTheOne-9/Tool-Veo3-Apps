// === API-BASED AUTOMATION (Thay thế Puppeteer DOM) ===
// TokenManager: quản lý phiên Brave, OAuth token tự động làm mới
// ApiClient: gọi trực tiếp Google Flow API không qua giao diện
const TokenManager = require('./token_manager');
const ApiClient = require('./api_client');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ─── Bảng ánh xạ model key UI → API key ─────────────────────────────────────
const VIDEO_MODEL_MAP = {
  'veo31_lite': 'veo_3_1_lite',
  'veo31_lite_lower': 'veo_3_1_lite',
  'veo31_fast': 'veo_3_1_fast',
  'veo31_fast_lower': 'veo_3_1_fast',
  'veo31_quality': 'veo_3_1_quality',
  // Truyền thẳng nếu đã là API key
  'veo_3_1_lite': 'veo_3_1_lite',
  'veo_3_1_fast': 'veo_3_1_fast',
  'veo_3_1_quality': 'veo_3_1_quality',
};

// Tỷ lệ khung hình UI key → ApiClient aspect ratio string
const ASPECT_RATIO_MAP = {
  'landscape': '16:9',
  '4_3': '4:3',
  'square': '1:1',
  '3_4': '3:4',
  'portrait': '9:16',
};

class FlowAutomation {
  constructor(io) {
    this.io = io;
    this.browser = null;
    this.page = null;
    this.isRunning = false;
    this.isPaused = false;
    this.currentIndex = 0;
    this.prompts = [];
    this.queue = [] //QUEUE 
    this.userRetryDecision = null;
    this.wfbStats = { done: 0, wait: 0, err: 0 };
    this.currentTask = null;
    this.results = [];
    this.claimedHrefs = new Set(); // Track claimed media hrefs to avoid duplication between nodes
    this.uiMutex = Promise.resolve(); // Mutex for UI operations
    this.settings = {
      type: 'video',
      ratio: 'landscape',
      quantity: 2,
      delayBetween: 5000,
      waitForGeneration: 9000000,
      projectUrl: '',
      videoModel: 'veo31_fast_lower'
    };
  }

  emit(event, data) {
    if (this.io) {
      this.io.emit(event, data);
    }
  }

  /**
   * Upscale image or video bằng FFmpeg theo target quality.
   * @param {string} inputPath - đường dẫn file gốc
   * @param {string} quality   - 'original' | '2K' | '4K' (image) | '720p' | '1080p' | '2K' | '4K' (video)
   * @param {'image'|'video'} mediaType
   * @returns {Promise<string>} đường dẫn file output (có thể = inputPath nếu 'original')
   */
  async upscaleWithFFmpeg(inputPath, quality, mediaType) {
    if (!quality || ['original', 'native', 'gốc'].includes(quality.toLowerCase())) {
      return inputPath; // Không xử lý, trả về file gốc
    }

    try {
      const ffmpeg = require('fluent-ffmpeg');
      let ffmpegPath = require('ffmpeg-static');
      if (ffmpegPath) ffmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked');
      ffmpeg.setFfmpegPath(ffmpegPath);

      const ext = path.extname(inputPath);
      const base = inputPath.slice(0, -ext.length);
      const outputPath = `${base}_${quality}${ext}`;

      // Ánh xạ quality → scale target
      let scaleFilter;
      if (mediaType === 'image') {
        const scaleMap = {
          '2k': 'scale=2560:1440:flags=lanczos:force_original_aspect_ratio=decrease',
          '4k': 'scale=3840:2160:flags=lanczos:force_original_aspect_ratio=decrease',
          '2K': 'scale=2560:1440:flags=lanczos:force_original_aspect_ratio=decrease',
          '4K': 'scale=3840:2160:flags=lanczos:force_original_aspect_ratio=decrease',
          '1080p': 'scale=1920:1080:flags=lanczos:force_original_aspect_ratio=decrease',
          '720p': 'scale=1280:720:flags=lanczos:force_original_aspect_ratio=decrease',
        };
        scaleFilter = scaleMap[quality] || scaleMap['2K'];
      } else {
        // video
        const scaleMap = {
          '720p': 'scale=-2:720:flags=lanczos',
          '1080p': 'scale=-2:1080:flags=lanczos',
          '2K': 'scale=-2:1440:flags=lanczos',
          '4K': 'scale=-2:2160:flags=lanczos',
          '2k': 'scale=-2:1440:flags=lanczos',
          '4k': 'scale=-2:2160:flags=lanczos',
        };
        scaleFilter = scaleMap[quality] || scaleMap['1080p'];
      }

      this.log(`  🔬 Upscaling → ${quality}: ${path.basename(inputPath)}`, 'info');

      await new Promise((resolve, reject) => {
        let cmd = ffmpeg(inputPath).videoFilter(scaleFilter);
        if (mediaType === 'image') {
          cmd = cmd.outputOptions(['-q:v', '2']); // JPEG quality hoặc PNG lossless
        } else {
          cmd = cmd.videoCodec('libx264').outputOptions(['-crf', '18', '-preset', 'fast', '-c:a', 'copy']);
        }
        cmd
          .output(outputPath)
          .on('end', resolve)
          .on('error', reject)
          .run();
      });

      // Xóa file gốc, thay bằng file upscaled
      try { fs.unlinkSync(inputPath); } catch (_) { }
      // Đổi tên file upscaled về tên file gốc
      fs.renameSync(outputPath, inputPath);
      this.log(`  ✅ Upscale ${quality} thành công: ${path.basename(inputPath)}`, 'success');
      return inputPath;
    } catch (e) {
      this.log(`  ⚠️ Upscale thất bại (${quality}): ${e.message} — Giữ bản gốc.`, 'warning');
      return inputPath; // fallback: giữ file gốc
    }
  }

  /**
   * Lấy URL video chất lượng cao — API trả về URL trực tiếp nên không cần mở tab.
   * Giữ nguyên signature để tương thích với server.js.
   * @param {string} editLink - URL edit (không cần thiết với API)
   * @returns {Promise<string|null>} null (server.js fallback về preview URL)
   */
  async _getHighQualityVideoUrl(editLink) {
    // Với hệ thống API mới, URL download HQ đã được trả về ngay từ lần tạo.
    // Server.js gọi method này để lấy URL HQ cho blob download — bỏ qua, dùng preview URL.
    return null;
  }

  log(message, type = 'info') {
    const entry = { time: new Date().toLocaleTimeString('vi-VN'), message, type };
    this.emit('log', entry);
    console.log(`[${entry.time}] [${type.toUpperCase()}] ${message}`);
  }

  async connect(debugPort = 9222) {
    // Hệ thống API mới: không cần kết nối Chrome debug port.
    // TokenManager (Brave) đã được khởi động qua launchWithCookies().
    // Nếu đã khởi động → trả về success ngay lập tức.
    if (this._tokenManager && this._apiClient) {
      this.log('Đã kết nối hệ thống API!', 'success');
      this.emit('connected', true);
      return { success: true };
    }

    // MUTEX 1: nếu launchWithCookies() đang chạy, chờ nó xong (tối đa 15s)
    if (this._isLaunching) {
      this.log('Đang chờ launchWithCookies hoàn thành...', 'info');
      for (let i = 0; i < 30; i++) {
        await this.delay(500);
        if (this._tokenManager && this._apiClient) {
          this.log('Đã kết nối (sau khi chờ launchWithCookies)!', 'success');
          this.emit('connected', true);
          return { success: true };
        }
        if (!this._isLaunching) break;
      }
      // Nếu vẫn không có sau 15s thì tiếp tục bình thường
    }

    // MUTEX 2: nếu connect() đang chạy từ luồng khác, chờ kết quả đó
    if (this._connectingPromise) {
      this.log('Đang chờ kết nối hiện tại hoàn thành...', 'info');
      return this._connectingPromise;
    }

    // Kiểm tra cookie trước khi thử khởi động
    const cookieFile = path.join(os.homedir(), 'Veo3Data', 'cookies.json');
    let hasCookie = false;
    try {
      if (fs.existsSync(cookieFile)) {
        const cookieData = fs.readFileSync(cookieFile, 'utf-8');
        if (cookieData && cookieData.trim().length > 10) hasCookie = true;
      }
    } catch (e) { }

    if (!hasCookie) {
      this.log('Bạn chưa nhập Cookie!', 'error');
      this.log('Vui lòng vào tab Cài Đặt (hoặc Giao diện) nhập Cookie Flow vào để sử dụng chức năng này!', 'error');
      this.emit('connected', false);
      return { success: false, error: 'Chưa có cookie' };
    }

    // Đặt mutex trước khi bắt đầu
    let resolveMutex;
    this._connectingPromise = new Promise(r => { resolveMutex = r; });

    // Thử khởi động TokenManager từ cookie đã lưu
    try {
      this.log('Đang khởi động hệ thống API với Brave Browser...', 'info');
      const bravePath = this.findBravePath();
      this._tokenManager = new TokenManager(bravePath ? { bravePath } : {});
      await this._tokenManager.initialize();

      // Expose browser/page để server.js có thể dùng (blob download)
      this.browser = this._tokenManager._browser;
      this.page = this._tokenManager._page;

      this._apiClient = new ApiClient(this._tokenManager);
      await this._apiClient.ensureProject();

      this.log('Đã kết nối hệ thống API thành công!', 'success');
      this.emit('connected', true);
      const result = { success: true };
      resolveMutex(result);
      this._connectingPromise = null;
      return result;
    } catch (error) {
      this.log(`Lỗi kết nối hệ thống API: ${error.message}`, 'error');
      this.emit('connected', false);
      const result = { success: false, error: error.message };
      resolveMutex(result);
      this._connectingPromise = null;
      return result;
    }
  }

  // Tìm đường dẫn Brave bundled (ưu tiên) hoặc cài đặt sẵn trên Windows
  findBravePath() {
    const paths = [
      // Brave bundled trong thư mục tool (ưu tiên số 1)
      // In packaged Electron app, asarUnpack files live under app.asar.unpacked
      path.join(__dirname, 'brave', 'brave.exe').replace('app.asar', 'app.asar.unpacked'),
      // Biến môi trường
      process.env.BRAVE_PATH,
      // Brave cài đặt hệ thống
      'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      'C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    ].filter(Boolean);

    for (const p of paths) {
      try { if (fs.existsSync(p)) return p; } catch { }
    }
    return null;
  }

  // Giữ lại để tương thích (các nơi cũ có thể gọi findChromePath)
  findChromePath() {
    return this.findBravePath();
  }

  // Tự động mở Brave Browser, inject cookie, khởi động hệ thống API
  async launchWithCookies(cookies, projectUrl, onDisconnect) {
    // Tránh mở 2 lần cùng lúc
    if (this._isLaunching) {
      this.log('Brave Browser đang được mở, bỏ qua yêu cầu trùng lặp...', 'warning');
      return { success: false, error: 'already_launching' };
    }
    this._isLaunching = true;
    try {
      const bravePath = this.findBravePath();

      // Dừng TokenManager cũ nếu có
      if (this._tokenManager) {
        try { await this._tokenManager.shutdown(); } catch { }
        this._tokenManager = null;
        this._apiClient = null;
        this.browser = null;
        this.page = null;
      }

      // Lưu cookie vào file để TokenManager đọc và inject vào Brave
      if (!cookies) {
        this.log('Không có cookie! Hãy dán cookie vào.', 'error');
        return { success: false, error: 'Không có cookie' };
      }

      let parsedCookies = this._parseCookies(cookies);
      if (parsedCookies.length === 0) {
        this.log('Không tìm thấy cookie hợp lệ! Hãy dán cookie chuẩn.', 'error');
        return { success: false, error: 'Cookie không hợp lệ' };
      }

      // Ghi cookie vào file mà TokenManager cấu hình để đọc
      const cookieFile = path.join(os.homedir(), 'Veo3Data', 'cookies.json');
      const cookieDir = path.dirname(cookieFile);
      if (!fs.existsSync(cookieDir)) fs.mkdirSync(cookieDir, { recursive: true });
      const cookieStr = typeof cookies === 'string' ? cookies : JSON.stringify(parsedCookies, null, 2);
      fs.writeFileSync(cookieFile, cookieStr, 'utf-8');

      this.log(`⚠️ Đang khởi động Brave Browser và inject ${parsedCookies.length} cookie...`, 'warning');

      // Khởi động TokenManager với Brave bundled
      this._tokenManager = new TokenManager({
        bravePath: bravePath || undefined,
      });
      this._tokenManager.on('token:expired', () => {
        this.log('Cookie đã hết hạn! Vui lòng cập nhật lại Cookie mới!', 'error');
        this.emit('cookieExpired', { message: 'Cookie đã hết hạn, vui lòng cập nhật lại Cookie mới!' });
        this.emit('connected', false);
      });

      await this._tokenManager.initialize();

      // Expose browser/page để server.js có thể dùng (blob download)
      this.browser = this._tokenManager._browser;
      this.page = this._tokenManager._page;

      // Kiểm tra cookie có hợp lệ không bằng cách kiểm tra token
      const token = await this._tokenManager.getToken();
      if (!token) {
        this.log('❌ Cookie của bạn ĐÃ HẾỰ HẠN hoặc bị sai! Không lấy được token!', 'error');
        this.emit('cookieExpired', { message: 'Cookie đã hết hạn, vui lòng cập nhật lại Cookie mới!' });
        this.emit('connected', false);
        return { success: false, error: 'Cookie_Expired' };
      }

      // Khởi động ApiClient
      this._apiClient = new ApiClient(this._tokenManager);
      await this._apiClient.ensureProject();

      const injected = parsedCookies.length;
      this._lastCookieCount = injected;

      this.log('Đã mở Brave Browser và kết nối Google Flow thành công!', 'success');
      this.emit('connected', true);
      this.emit('cookiesSet', { count: injected });
      return { success: true, count: injected };
    } catch (error) {
      this.log(`Lỗi mở Brave Browser: ${error.message}`, 'error');
      this.emit('connected', false);
      return { success: false, error: error.message };
    } finally {
      this._isLaunching = false;
    }
  }




  // Parse cookie string/array
  _parseCookies(cookies) {
    let parsedCookies = [];
    if (typeof cookies === 'string') {
      cookies = cookies.trim();
      if (cookies.startsWith('[')) {
        try {
          const jsonCookies = JSON.parse(cookies);
          parsedCookies = jsonCookies.map(c => ({
            name: c.name, value: c.value,
            domain: c.domain || '.google.com',
            path: c.path || '/',
            httpOnly: c.httpOnly || false,
            secure: c.secure !== false,
            sameSite: c.sameSite || 'Lax'
          }));
        } catch (e) { return []; }
      } else {
        parsedCookies = cookies.split(/[;\n]/)
          .map(s => s.trim()).filter(s => s && s.includes('='))
          .map(s => {
            const eq = s.indexOf('=');
            return {
              name: s.substring(0, eq).trim(),
              value: s.substring(eq + 1).trim(),
              domain: '.google.com', path: '/',
              httpOnly: false, secure: true, sameSite: 'Lax'
            };
          }).filter(c => c.name && c.value);
      }
    } else if (Array.isArray(cookies)) {
      parsedCookies = cookies;
    }
    return parsedCookies;
  }


  // Helper: Xử lý hàng đợi (Queue)
  async checkQueue() {
    // 1. KẸT LẠI Ở ĐÂY NẾU HỆ THỐNG ĐANG BỊ TẠM DỪNG (Sau khi nhấn Stop)
    while (this.isPaused) {
      // Dùng Promise để có thể đánh thức ngay từ lệnh resume()
      await new Promise(resolve => {
        this._resumeResolver = resolve;
        setTimeout(resolve, 100);
      });
    }

    // 2. NẾU CÒN HÀNG ĐỢI VÀ ĐÃ ĐƯỢC RESUME -> CHẠY TIẾP
    if (this.queue.length > 0) {
      const nextTask = this.queue.shift();
      this.currentTask = nextTask;
      this.emitQueueUpdate();

      this.log(`⏳ Bắt đầu xử lý tác vụ từ hàng đợi: [${nextTask.type.toUpperCase()}] (Còn lại: ${this.queue.length})`, 'info');
      try {
        if (nextTask.type === 'start') {
          await this.start(nextTask.args[0], nextTask.args[1], true);
        } else if (nextTask.type === 'fashion_workflow') {
          await this.runWorkflow(nextTask.args[0], true);
        } else if (nextTask.type === 'builder_workflow') {
          await this.runBuilderWorkflow(nextTask.args[0], true);
        } else if (nextTask.type === 'single_node') {
          await this.runSingleNode(nextTask.args[0], nextTask.args[1], true);
        }
      } catch (e) {
        this.log(`Lỗi khi chạy tác vụ từ hàng đợi: ${e.message}`, 'error');
        this.isRunning = false;
        setTimeout(() => this.checkQueue(), 1000);
      }
    } else {
      // NẾU HÀNG ĐỢI TRỐNG SAU KHI ĐƯỢC RESUME -> CHUYỂN VỀ TRẠNG THÁI NGHỈ
      this.isRunning = false;
      this.currentTask = null;
      this.emitQueueUpdate();
      this.emit('stopped', true);
      this.emit('wf-builder-status', { state: 'idle', message: '✅ Hoàn tất toàn bộ' });
    }
  }




  async findFlowPage(projectUrl) {
    // Hệ thống API mới không cần tìm tab trình duyệt — API gọi trực tiếp.
    // Kiểm tra ApiClient đã sẵn sàng chưa.
    if (!this._apiClient) {
      this.log('Hệ thống API chưa được khởi động. Vui lòng Inject Cookie trước.', 'error');
      return false;
    }
    return true;
  }

  /**
   * Kiểm tra xem Google Flow có đang ở trong 1 project không.
   * Với hệ thống API mới: gọi ensureProject() để tạo/chọn project tự động.
   */
  async ensureInProject() {
    try {
      // Kiểm tra token có hợp lệ không
      if (this._tokenManager) {
        const token = await this._tokenManager.getToken();
        if (!token) {
          this.log('❌ Cookie đã hết hạn! Vui lòng lấy cookie mới!', 'error');
          this.emit('cookieExpired', { message: 'Cookie đã hết hạn. Vui lòng lấy cookie mới!' });
          throw new Error('Cookie_Expired');
        }
      }

      // Đảm bảo đã có project được tạo/chọn
      if (this._apiClient) {
        await this._apiClient.ensureProject();
        this.log('Đã sẵn sàng trong project Google Flow!', 'success');
      }
      return true;
    } catch (e) {
      if (e.message === 'Cookie_Expired') throw e;
      this.log(`Lỗi kiểm tra project: ${e.message}`, 'warning');
      return true; // không chặn workflow
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // STUB METHODS — Các method DOM cũ (Puppeteer) đã được thay thế
  // bằng hệ thống API. Giữ lại để tương thích với bất kỳ code nào
  // còn tham chiếu, nhưng các method này không còn thực thi gì.
  // ═══════════════════════════════════════════════════════════════

  // Không còn cần thiết — API không dùng ô nhập prompt UI
  async clearPromptBox() { return null; }
  async typePrompt(text) { return true; }
  async clickRealMouse(textQueries) { return false; }

  // Không còn cần thiết — API call tự chọn mode/ratio/model qua params
  async selectFlowMode(mode) { return true; }
  async openSettings() { return true; }
  async closeSettingsMenu() { return true; }
  async selectType(type) { return true; }
  async selectRatio(ratio) { return true; }
  async selectVideoModel(modelKey) { return true; }
  async selectImageModel(modelKey) { return true; }
  async selectQuantity(qty) { return true; }

  // Không còn cần thiết — API generate trực tiếp
  async _waitForFramesReady(timeout) { return true; }
  async clickGenerate() { return true; }

  // Không còn cần thiết — API không cần upload qua UI
  async clearAllReferences() { return true; }
  async clickPlusButton() { return false; }


  // ═══════════════════════════════════════════════════════════
  // UPLOAD ẢNH QUA API — Thay thế uploadImageToFlow (Puppeteer)
  // ═══════════════════════════════════════════════════════════

  /**
   * Upload ảnh (base64 dataURL hoặc file path) lên Google Flow qua API.
   * Trả về mediaId để dùng trong generateVideo/Image.
   * @param {string} dataUrlOrPath - base64 dataURL hoặc đường dẫn file local
   * @param {string} slot - 'ref'|'start'|'end' (chỉ dùng để log)
   * @returns {Promise<string|null>} mediaId hoặc null nếu thất bại
   */
  async uploadImageToFlow(dataUrlOrPath, slot = 'ref') {
    if (!this._apiClient) {
      this.log(`[Upload] Hệ thống API chưa sẵn sàng!`, 'error');
      return null;
    }
    try {
      this.log(`[Upload] Đang tải ảnh ${slot} lên Google Flow...`, 'info');
      const fs = require('fs');
      const path = require('path');
      const os = require('os');
      let filePath = null;

      if (dataUrlOrPath && dataUrlOrPath.startsWith('data:')) {
        // Chuyển base64 → file tạm
        const tmpDir = path.join(os.tmpdir(), 'veo3_upload');
        if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
        filePath = path.join(tmpDir, `upload_${Date.now()}.png`);
        const base64 = dataUrlOrPath.split(',')[1];
        fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
      } else if (dataUrlOrPath && fs.existsSync(dataUrlOrPath)) {
        filePath = dataUrlOrPath;
      } else {
        this.log(`[Upload] Đường dẫn ảnh không hợp lệ!`, 'error');
        return null;
      }

      const result = await this._apiClient.uploadImage(filePath);
      const mediaId = typeof result === 'string' ? result : (result?.mediaId || result?.name || null);
      if (mediaId) {
        this.log(`[Upload] Thành công! MediaId: ${mediaId.substring(0, 40)}...`, 'success');
      } else {
        this.log(`[Upload] Không lấy được mediaId từ API!`, 'error');
      }
      return mediaId;
    } catch (e) {
      this.log(`[Upload] Lỗi upload ảnh: ${e.message}`, 'error');
      return null;
    }
  }

  // Giữ tương thích — không còn cần thiết với API
  async _componentPanelUpload(filePath) { return false; }
  async selectReferenceByName(filename, autoOpenPanel, closeOnFail) { return false; }
  async _wfAttachFromFlowHistory(editLink, previewUrl, sourcePrompt) { return false; }

  // ═══════════════════════════════════════════════════════════
  // DOWNLOAD BUFFER QUA API — Thay thế page.evaluate(fetch())
  // ═══════════════════════════════════════════════════════════

  /**
   * Tải nội dung media về dạng Buffer qua ApiClient (HTTP thuần túy).
   */
  async _fetchUrlToBuffer(url) {
    if (!url) return null;
    try {
      if (this._apiClient) {
        return await this._apiClient.downloadBuffer(url);
      }
      // Fallback: Node.js https.get nếu không có apiClient
      return await new Promise((resolve, reject) => {
        const mod = url.startsWith('https') ? require('https') : require('http');
        const chunks = [];
        mod.get(url, (res) => {
          res.on('data', c => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks)));
        }).on('error', reject);
      });
    } catch (e) {
      this.log(`Lỗi fetch URL: ${e.message}`, 'warning');
      return null;
    }
  }

  /**
   * Download temp file — dùng trong workflow node để truyền giữa các bước.
   */
  async _wfFetchUrlToTemp(url, mediaType = 'image') {
    const path = require('path');
    const os = require('os');
    const fs = require('fs');
    const tmpDir = path.join(os.tmpdir(), 'veo3_wf');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const ext = mediaType === 'video' ? '.mp4' : '.png';
    const outPath = path.join(tmpDir, `fetch_${Date.now()}${ext}`);
    try {
      const buf = await this._fetchUrlToBuffer(url);
      if (!buf) return null;
      fs.writeFileSync(outPath, buf);
      return outPath;
    } catch (e) {
      this.log(`Lỗi _wfFetchUrlToTemp: ${e.message}`, 'warning');
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // WAIT FOR GENERATION — Thay thế DOM polling bằng API polling
  // ═══════════════════════════════════════════════════════════

  /**
   * Chờ các media items hoàn thành qua API polling.
   * @param {number} timeout - Timeout ms
   * @param {Array} mediaItems - Danh sách {name, projectId} để poll
   * @param {string} expectedType - 'video'|'image'
   * @param {function} [onProgress] - callback tiến độ
   * @returns {Promise<{status, media}>}
   */
  async waitForGeneration(timeout, mediaItems = null, expectedType = 'video', onProgress = null) {
    if (!this._apiClient || !mediaItems || mediaItems.length === 0) {
      return { status: 'error', media: [] };
    }
    try {
      const intervalMs = 10000; // 10s
      const startTime = Date.now();
      let lastCount = 0;

      while (Date.now() - startTime < timeout) {
        if (!this.isRunning) return { status: 'stopped', media: [] };
        while (this.isPaused) {
          await this.delay(1000);
          if (!this.isRunning) return { status: 'stopped', media: [] };
        }

        await this.delay(intervalMs);

        const status = await this._apiClient.checkVideoStatus(mediaItems);
        const mediaList = status.media || [];

        // Đếm số item đã xong
        const done = mediaList.filter(m => {
          const s = m.mediaMetadata?.mediaStatus?.mediaGenerationStatus;
          return s === 'MEDIA_GENERATION_STATUS_SUCCESSFUL'
            || s === 'MEDIA_GENERATION_STATUS_FAILED'
            || s === 'MEDIA_GENERATION_STATUS_FILTERED';
        });

        const elapsed = Math.round((Date.now() - startTime) / 1000);

        if (done.length !== lastCount) {
          this.log(`⏳ Đang tạo... ${done.length}/${mediaList.length} xong (${elapsed}s)`, 'info');
          lastCount = done.length;
        }

        if (onProgress) onProgress(status, elapsed);

        if (done.length >= mediaList.length && mediaList.length > 0) {
          const successfulItems = mediaList.filter(
            m => m.mediaMetadata?.mediaStatus?.mediaGenerationStatus === 'MEDIA_GENERATION_STATUS_SUCCESSFUL'
          );

          let serverFailureReasons = [];
          let hasServerError = false;
          let hasPolicyViolation = false;

          // Log failure reasons
          mediaList.forEach((m, idx) => {
            const genStatus = m.mediaMetadata?.mediaStatus?.mediaGenerationStatus;
            const explicitReason = m.mediaMetadata?.mediaStatus?.mediaGenerationFailureReason
              || m.mediaMetadata?.failureReason
              || m.failureReason;
            // Extract human-readable string from Google's various error payload shapes
            let fallbackReason = 'Lỗi không xác định từ Google';
            if (m.error) {
              if (typeof m.error === 'string') fallbackReason = m.error;
              else if (m.error.message) fallbackReason = m.error.message;
              else if (m.error.details?.[0]?.reason) fallbackReason = m.error.details[0].reason;
              else fallbackReason = JSON.stringify(m.error);
            } else if (m.status?.message) {
              fallbackReason = m.status.message;
            }

            const failureReason = explicitReason || fallbackReason;

            if (genStatus === 'MEDIA_GENERATION_STATUS_FILTERED' || (failureReason && failureReason.includes('POLICY_VIOLATION'))) {
              hasPolicyViolation = true;
              // Filtered = content policy violation from Google's side
              this.log(`🚫 [Google Policy] Media ${idx + 1} bị Google chặn do vi phạm chính sách nội dung (Safety Filter)! Lý do: ${explicitReason || 'Nội dung vi phạm chính sách Google'}`, 'error');
              console.error(`[FlowAutomation] 🚫 GOOGLE POLICY VIOLATION — Media ${idx + 1} FILTERED. Reason: ${explicitReason || 'n/a'}`);
            } else if (genStatus === 'MEDIA_GENERATION_STATUS_FAILED' || failureReason) {
              hasServerError = true;
              serverFailureReasons.push(`Media ${idx + 1}: ${failureReason || 'Lỗi Google Server ngầm'}`);
              // We do not eagerly log server errors here anymore; we collect them to only log once the retry fully fails loop in caller
            }
          });

          if (hasPolicyViolation) {
            return { status: 'policy_violation', media: [] };
          }

          // If all items failed and there is a server error (not a policy violation), signal a retry
          if (successfulItems.length === 0 && hasServerError) {
            return { status: 'server_error', media: [], error: serverFailureReasons.join(' | ') };
          }

          const media = [];
          const projectId = successfulItems[0]?.projectId || this._apiClient._projectId;

          for (const [idx, m] of successfulItems.entries()) {
            const mediaId = m.name;



            let downloadUrl = null;

            // ── Phương án 0: downloadUrl trực tiếp từ API response ────────────
            // checkVideoStatus may return direct video download URL
            const directUrl =
              m.mediaMetadata?.mediaStatus?.downloadUrl ||
              m.mediaMetadata?.video?.downloadUrl ||
              m.mediaMetadata?.video?.uri ||
              m.video?.downloadUrl ||
              m.video?.uri ||
              m.downloadUrl;
            if (directUrl && directUrl.startsWith('http')) {
              downloadUrl = directUrl;
              this.log(`🔗 [API] Direct video URL: ${mediaId.substring(0, 20)}...`, 'info');
              console.log(`[DEBUG] Direct URL found: ${directUrl}`);
            }

            // ── Phương án 1: Remote extract via Workflow Page (Only for Video) ──
            if (!downloadUrl && expectedType === 'video' && m.workflowId && projectId) {
              try {
                this.log(`  🌐 Đang lấy link MP4 gốc từ Flow API...`, 'info');
                const { url: videoGcsUrl } = await this._apiClient.downloadVideoViaWorkflowPage(mediaId, projectId, m.workflowId);
                if (videoGcsUrl) {
                  downloadUrl = videoGcsUrl;
                  this.log(`🔗 [Flow API] URL captured: ${mediaId.substring(0, 20)}...`, 'info');
                }
              } catch (e) {
                this.log(`⚠️ Lỗi lấy link MP4: ${e.message}`, 'warning');
              }
            }

            // ── Phương án 2: Trình lấy Thumbnail (For Images or Fallback) ──
            if (!downloadUrl) {
              try {
                downloadUrl = await this._apiClient.triggerMediaUrlCapture(mediaId, projectId, 10000);
                if (downloadUrl) {
                  this.log(`🔗 [CDP] URL captured (Fallback/Image): ${mediaId.substring(0, 20)}...`, 'info');
                }
              } catch (e) {
                this.log(`⚠️ CDP capture lỗi: ${e.message}`, 'warning');
              }
            }

            if (downloadUrl) {
              media.push({
                type: expectedType,
                url: downloadUrl,
                id: (mediaId || `media_${idx}`).replace(/\//g, '_'),
                editLink: null,
                workflowId: m.workflowId || null,
                projectId: m.projectId || projectId || null,
              });
            } else {
              this.log(`⚠️ Không tìm được URL cho media[${idx}] ${mediaId?.substring(0, 20)}`, 'warning');
            }
          }

          if (media.length === 0) {
            return { status: 'server_error', media: [], error: 'Cơ chế bắt link tải thất bại hoặc Google lỗi ngầm (0 URL).' };
          }

          this.log(`✅ Tạo xong! ${media.length}/${done.length} media có URL.`, 'success');
          return { status: 'success', media };

        }


      }
      this.log('⚠️ Hết thời gian chờ tạo media!', 'warning');
      return { status: 'timeout', media: [] };
    } catch (e) {
      this.log(`Lỗi waitForGeneration: ${e.message}`, 'error');
      return { status: 'error', media: [] };
    }
  }


  async processPrompt(prompt, index, total) {
    this.log(`━━━ Prompt ${index + 1}/${total} ━━━`, 'info');
    this.emit('promptStart', { index, total, prompt });

    try {
      const mode = this.settings.mode || 'video';
      const imagePaths = this.imagePaths || {};



      // 2. Xác định thông số API từ settings
      const aspectRatio = ASPECT_RATIO_MAP[this.settings.ratio] || '16:9';
      const count = this.settings.quantity || 2;
      let videoModel = VIDEO_MODEL_MAP[this.settings.videoModel] || 'veo_3_1_fast';
      const expectedType = mode.includes('video') ? 'video' : 'image';

      // 3. Upload ảnh tham chiếu nếu có (trả về mediaId)
      let startImageId = null;
      let endImageId = null;
      let referenceImages = [];

      if (mode === 'image_from_image') {
        const refList = Array.isArray(imagePaths.refs) && imagePaths.refs.length > 0
          ? imagePaths.refs : (imagePaths.ref ? [imagePaths.ref] : []);
        for (const refDataUrl of refList) {
          const mediaId = await this.uploadImageToFlow(refDataUrl, 'ref');
          if (mediaId) referenceImages.push(mediaId);
        }
        if (referenceImages.length === 0) {
          this.log('❌ Upload ảnh tham chiếu thất bại! Bỏ qua prompt này.', 'error');
          return { prompt, status: 'error', error: 'Upload ảnh tham chiếu thất bại', media: [] };
        }
      } else if (mode === 'video_from_image') {
        const refList = Array.isArray(imagePaths.refs) && imagePaths.refs.length > 0
          ? imagePaths.refs : (imagePaths.ref ? [imagePaths.ref] : []);
        for (const refDataUrl of refList) {
          const mediaId = await this.uploadImageToFlow(refDataUrl, 'ref');
          if (mediaId) referenceImages.push(mediaId);
        }
        if (referenceImages.length === 0) {
          this.log('❌ Upload ảnh Thành phần (Video+Ảnh) thất bại! Bỏ qua prompt này.', 'error');
          return { prompt, status: 'error', error: 'Upload ảnh ref thất bại', media: [] };
        }
      } else if (mode === 'video_from_frames') {
        if (imagePaths.start) {
          startImageId = await this.uploadImageToFlow(imagePaths.start, 'start');
          if (!startImageId) {
            this.log('❌ Upload ảnh khung bắt đầu thất bại! Bỏ qua prompt này.', 'error');
            return { prompt, status: 'error', error: 'Upload ảnh start thất bại', media: [] };
          }
        }
        if (imagePaths.end) {
          endImageId = await this.uploadImageToFlow(imagePaths.end, 'end');
          if (!endImageId) {
            this.log('❌ Upload ảnh khung kết thúc thất bại! Bỏ qua prompt này.', 'error');
            return { prompt, status: 'error', error: 'Upload ảnh end thất bại', media: [] };
          }
        }
      }

      // 4. Gọi API tạo media
      this.log(`🚀 Đang gọi API tạo ${expectedType === 'video' ? 'video' : 'ảnh'}...`, 'info');
      let genResult;

      let generationAttempts = 0;
      const MAX_GEN_ATTEMPTS = 5;

      while (generationAttempts < MAX_GEN_ATTEMPTS) {
        generationAttempts++;

        if (expectedType === 'video') {
          // Auto-upgrade Lite to Fast for r2v (Reference to Video)
          const hasR2V = (referenceImages && referenceImages.length > 0);
          if (videoModel === 'veo_3_1_lite' && hasR2V) {
            videoModel = 'veo_3_1_fast';
            this.log(`⚠️ Video Lite không hỗ trợ ảnh tham chiếu. Tự chuyển sang model Fast!`, 'warning');
          }

          const startResult = await this._apiClient.generateVideo(prompt, {
            model: videoModel,
            aspectRatio,
            count,
            startImageId: startImageId || undefined,
            endImageId: endImageId || undefined,
            referenceImages: referenceImages.length > 0 ? referenceImages : undefined,
          });

          const mediaItems = (startResult.media || []).map(m => ({
            name: m.name,
            projectId: m.projectId || this._apiClient._projectId,
          }));

          if (mediaItems.length === 0) {
            this.log('⚠️ API không trả về media items để poll!', 'error');
            return { prompt, status: 'error', error: 'Không có media items', media: [] };
          }

          genResult = await this.waitForGeneration(
            this.settings.waitForGeneration,
            mediaItems,
            'video'
          );

          if (genResult.status === 'server_error') {
            if (generationAttempts < MAX_GEN_ATTEMPTS) {
              await this.delay(3000);
              continue; // Silently retry video generation
            } else {
              this.log(`❌ Máy chủ Google liên tục báo lỗi sau ${MAX_GEN_ATTEMPTS} lần thử! Chi tiết: ${genResult.error}`, 'error');
            }
          }

          break; // Break loop if not a server_error (either success, timeout, or final failure)
        } else {
          // IMAGE: đồng bộ — kết quả có ngay trong response
          const imgResult = await this._apiClient.generateImage(prompt, {
            aspectRatio,
            count,
            imageInputs: referenceImages.length > 0 ? referenceImages : undefined,
          });

          // Extract URL từ image response (không cần poll)
          const images = (imgResult.media || []).map((m, idx) => ({
            type: 'image',
            url: m.image?.generatedImage?.fifeUrl
              || m.mediaMetadata?.mediaStatus?.downloadUrl
              || '',
            id: m.name || `img_${idx}`,
            editLink: null,
          })).filter(m => m.url);

          if (images.length === 0) {
            this.log('⚠️ API không trả về ảnh nào!', 'error');
            return { prompt, status: 'error', error: 'Không tạo được ảnh', media: [] };
          }

          this.log(`✅ Tạo xong ${images.length} ảnh!`, 'success');
          genResult = { status: 'success', media: images };
          break; // Break the retry loop for images as well, as they are synchronous
        }
      }


      // 5. Gửi media về frontend + download
      if (genResult.media && genResult.media.length > 0) {
        this.emit('newMedia', { index, prompt, media: genResult.media });
        await this.downloadMediaBuffer(genResult.media, prompt);
      }

      // 6. Chờ trước prompt tiếp
      if (index < total - 1) {
        this.log(`Chờ ${this.settings.delayBetween / 1000}s trước prompt tiếp theo...`, 'info');
        await this.delay(this.settings.delayBetween);
      }

      return { prompt, status: genResult.status, media: genResult.media || [] };
    } catch (error) {
      // Policy violation errors should be clearly surfaced as errors, not generic warnings
      if (error.message && error.message.startsWith('POLICY_VIOLATION')) {
        this.log(`🚫 [Google Policy] Prompt bị chặn do vi phạm chính sách của Google: ${error.message.replace('POLICY_VIOLATION: ', '')}`, 'error');
        console.error(`[FlowAutomation] 🚫 POLICY VIOLATION on prompt "${String(prompt).substring(0, 80)}...": ${error.message}`);
        return { prompt, status: 'policy_violation', error: error.message, media: [] };
      }
      this.log(`Lỗi xử lý prompt: ${error.message}`, 'error');
      return { prompt, status: 'error', error: error.message, media: [] };
    }
  }

  async downloadMediaBuffer(mediaList, prompt) {
    const count = mediaList.length;

    let finalDir = this.settings.downloadDir || path.join(__dirname, 'downloads');
    if (this.settings.subfolderName) {
      finalDir = path.join(finalDir, this.settings.subfolderName);
    }
    if (!fs.existsSync(finalDir)) fs.mkdirSync(finalDir, { recursive: true });

    const quality = this.settings.downloadQuality || 'original';
    this.log(`Bắt đầu tải ${count} file... [Chất lượng: ${quality}]`, 'info');
    const downloadedFiles = [];

    for (let i = 0; i < count; i++) {
      const media = mediaList[i];
      const ext = media.type === 'video' ? '.mp4' : '.png';
      const safeId = (media.id || `media_${i}`).replace(/[\/\\:*?"<>|]/g, '_');
      const filename = `veo3_${safeId}${ext}`;
      const filePath = path.join(finalDir, filename);

      try {
        // Dùng ApiClient.downloadBuffer thay vì page.evaluate(fetch())
        const buf = await this._fetchUrlToBuffer(media.url);
        if (!buf) throw new Error('Không tải được nội dung');
        fs.writeFileSync(filePath, buf);

        // === UPSCALE nếu downloadQuality không phải 'original'/'native' ===
        if (quality && !['original', 'native', 'gốc'].includes(quality.toLowerCase())) {
          await this.upscaleWithFFmpeg(filePath, quality, media.type === 'video' ? 'video' : 'image');
        }

        downloadedFiles.push({ path: filePath, filename });
        this.log(`Đã tải: ${filename}${quality && !['original', 'native', 'gốc'].includes(quality.toLowerCase()) ? ` [${quality}]` : ''}`, 'success');
      } catch (e) {
        this.log(`Lỗi tải ${filename}: ${e.message}`, 'error');
      }
    }

    this.emit('mediaDownloaded', { files: downloadedFiles, prompt });
  }

  async start(prompts, settings, isFromQueue = false) {
    if (this.isRunning && !isFromQueue) {
      this.queue.push({ type: 'start', args: [prompts, settings] });
      this.emitQueueUpdate();
      this.log(`Tiến trình đang chạy! Đã thêm tác vụ (Basic Flow) vào hàng đợi. Vị trí: ${this.queue.length}`, 'warning');
      return;
    }

    this.isRunning = true;
    this.isPaused = false;

    // --- TRACK CURRENT TASK ---
    this.currentTask = { type: 'start', args: [prompts, settings] };
    const mode = settings ? (settings.mode || 'video') : 'video';
    this.currentTask.progress = { total: prompts.length, completed: 0, runningType: mode.includes('video') ? 'video' : 'image' };
    this.emitQueueUpdate();

    this.prompts = prompts;
    const { imagePaths, ...cleanSettings } = settings || {};
    this.imagePaths = imagePaths || {};
    this.settings = { ...this.settings, ...cleanSettings };
    this.results = [];
    this.currentIndex = 0;

    this.log('═══════════════════════════════════', 'info');
    this.log(`Bắt đầu tạo ${prompts.length} video trên Google Flow`, 'success');
    this.log('═══════════════════════════════════', 'info');

    try {
      // Đảm bảo hệ thống API đã sẵn sàng
      if (!this._apiClient) {
        const conn = await this.connect();
        if (!conn.success) {
          this.isRunning = false;
          this.currentTask = null; this.emitQueueUpdate();
          return;
        }
      }

      await this.ensureInProject();

      for (let i = 0; i < prompts.length; i++) {
        if (!this.isRunning) break;

        while (this.isPaused) {
          await this.delay(1000);
          if (!this.isRunning) break;
        }

        this.currentIndex = i;
        const result = await this.processPrompt(prompts[i], i, prompts.length);
        this.results.push(result);

        if (this.currentTask && this.currentTask.progress) {
          this.currentTask.progress.completed = i + 1;
          this.emitQueueUpdate();
        }

        this.emit('promptComplete', { index: i, result, total: prompts.length });
      }

      if (this.isRunning) {
        this.log('═══════════════════════════════════', 'info');
        this.log('Hoàn thành tất cả prompt!', 'success');
        this.log('═══════════════════════════════════', 'info');
        this.emit('allComplete', this.results);
      }

    } catch (error) {
      this.log(`Lỗi nghiêm trọng: ${error.message}`, 'error');
    } finally {
      this.currentTask = null;
      this.emitQueueUpdate();

      if (this.queue.length > 0) {
        this.isRunning = true;
        setTimeout(() => this.checkQueue(), 100);
      } else {
        this.isRunning = false;
        this.isPaused = false; // Đảm bảo gỡ pause

        // LUÔN BÁO CHO BUILDER QUAY VỀ NÚT "CHẠY WORKFLOW" KHI HẾT HÀNG ĐỢI
        this.emit('wf-builder-status', { state: 'idle', message: '✅ Hoàn tất' });
        this.emit('stopped', true);
      }
    }
  }

  updateWfbStats(action = null) {
    if (action === 'done') this.wfbStats.done++;
    if (action === 'error') this.wfbStats.err++;
    if (action === 'reset') {
    }

    // Đồng bộ số "CHỜ" chính xác với độ dài của Hàng đợi (Queue)
    this.wfbStats.wait = this.queue.length;

    // Gửi data xuống file app.js
    this.emit('workflowStats', this.wfbStats);
  }

  handleRetryDecision(action) {
    // action nhận vào sẽ là 'continue' hoặc 'stop'
    if (this.userRetryDecision === 'waiting') {
      this.userRetryDecision = action;
    }
  }

  pause() {
    // BẢN VÁ: Chặn không cho Pause nếu hệ thống đang trống không
    if (!this.isRunning && !this.currentTask && this.queue.length === 0) return;

    this.isPaused = true;
    this.log('Đã tạm dừng', 'warning');
    this.emit('paused', true);
    this.emitQueueUpdate();
  }

  resume() {
    this.isPaused = false;
    this.log('Tiếp tục...', 'success');
    this.emit('paused', false);
    this.emit('wf-builder-status', { state: 'running' }); // Báo cho Builder biết đã chạy lại
    this.emitQueueUpdate();
    if (this._resumeResolver) {
      this._resumeResolver();
      this._resumeResolver = null;
    }
  }


  async stop() {
    this.log('🛑 Đang dừng toàn bộ hệ thống và xóa hàng đợi...', 'warning');

    // 1. Ngắt tất cả cờ trạng thái để thoát khỏi các vòng lặp đang chạy
    this.isRunning = false;
    this.isPaused = false;

    // 2. Xóa sạch hoàn toàn hàng đợi và tác vụ hiện tại
    this.queue = [];
    this.currentTask = null;

    // 3. Gửi tín hiệu để làm trống giao diện hàng đợi
    this.emitQueueUpdate();

    // 4. Cập nhật lại bộ đếm
    this.updateWfbStats('reset');

    // 5. Gửi tín hiệu 'idle'
    this.emit('stopped', true);
    this.emit('paused', false);
    this.emit('wf-builder-status', { state: 'idle', message: '⏹️ Hệ thống đã dừng hoàn toàn' });

    // 6. DỌN DẸP WORKSPACE BẰNG MUTEX AN TOÀN
    if (this.page) {
      this.log('🧹 Đang chờ các tác vụ nhả giao diện để dọn dẹp...', 'info');

      let releaseCleanupMutex;
      const cleanupMutex = new Promise(r => releaseCleanupMutex = r);
      const currentMutex = this.uiMutex || Promise.resolve();
      this.uiMutex = currentMutex.then(() => cleanupMutex);

      await currentMutex; // Xếp hàng đợi các node kia hủy bỏ xong mới vào dọn

      try {
        await this.clearAllReferences();
        await this.clearPromptBox();
      } catch (e) {
        // Bỏ qua nếu lỗi dọn dẹp
      } finally {
        releaseCleanupMutex();
      }
    }

    this.log('Đã dừng hệ thống hoàn toàn và xóa hàng đợi.', 'success');
  }


  // Dừng tác vụ đang chạy hiện tại (bấm từ nút thùng rác)
  async skipCurrent() {
    if (this.isRunning) {
      if (this.queue.length === 0) {
        this.log('Hủy tác vụ cuối cùng -> Dừng toàn bộ hệ thống...', 'warning');
        this.stop();
        return;
      }

      this.log('Hủy tác vụ hiện tại, tạm dừng hệ thống chuyển sang tác vụ kế...', 'warning');
      this.isRunning = false;
      this.isPaused = true;

      this.emit('paused', true);
      this.emit('wf-builder-status', { state: 'paused', message: 'Đã hủy tác vụ, chờ bắt đầu tác vụ kế...' });
      this.emitQueueUpdate();

      // DỌN DẸP WORKSPACE TRƯỚC KHI TẠM DỪNG (CÓ KHÓA MUTEX)
      if (this.page) {
        this.log('🧹 Đang chờ giao diện để dọn dẹp...', 'info');
        let releaseCleanupMutex;
        const cleanupMutex = new Promise(r => releaseCleanupMutex = r);
        const currentMutex = this.uiMutex || Promise.resolve();
        this.uiMutex = currentMutex.then(() => cleanupMutex);

        await currentMutex;
        try {
          await this.clearAllReferences();
          await this.clearPromptBox();
        } catch (e) { } finally {
          releaseCleanupMutex();
        }
      }
    }
  }


  getStatus() {
    return {
      isRunning: this.isRunning,
      isPaused: this.isPaused,
      currentIndex: this.currentIndex,
      totalPrompts: this.prompts.length,
      results: this.results
    };
  }

  delay(ms) {
    return new Promise(resolve => {
      let elapsed = 0;
      const step = 100; // Kiểm tra mỗi 100ms
      const timer = setInterval(() => {
        // Lập tức ngắt delay nếu bị nhấn Stop!
        if (!this.isRunning) {
          clearInterval(timer);
          return resolve();
        }
        // CHỈ cộng thời gian nếu KHÔNG BỊ PAUSE (Đóng băng thời gian khi Pause)
        if (!this.isPaused) {
          elapsed += step;
        }

        if (elapsed >= ms) {
          clearInterval(timer);
          resolve();
        }
      }, step);
    });
  }





  // Cập nhật trạng thái Queue xuống Frontend UI
  emitQueueUpdate() {
    // --- BẢN VÁ TỰ CHỮA LÀNH (SELF-HEALING UI) ---
    // Nếu phát hiện Hàng đợi trống + Không có Task chạy -> ÉP UI VỀ NÚT RUN
    if (this.queue.length === 0 && !this.currentTask && this.isPaused) {
      this.isPaused = false;
      this.emit('paused', false);
      this.emit('stopped', true);
      this.emit('wf-builder-status', { state: 'idle', message: '✅ Sẵn sàng' });
    }

    // Helper parse thông tin task
    const parseTaskData = (task, idx, statusType) => {
      let name = "Tác vụ không xác định";
      let desc = "";

      if (task.type === 'start') {
        const prompts = task.args[0];
        if (prompts && prompts.length === 1) {
          name = "Chạy Prompt";
          desc = prompts[0];
        } else {
          name = "Basic Prompts";
          desc = `${prompts ? prompts.length : 0} prompts`;
        }
      }
      else if (task.type === 'two_stage_workflow' || task.type === 'fashion_workflow') {
        name = "Workflow Tự động";
        const count = task.args[0].tasks ? task.args[0].tasks.length : (task.args[0].outfits ? task.args[0].outfits.length : 0);
        desc = `${count} tác vụ`;
      }
      else if (task.type === 'builder_workflow') {
        const wf = task.args[0];
        name = wf.name || "Untitled Workflow";
        desc = `Chạy toàn bộ Workflow (${wf.nodes ? wf.nodes.length : 0} nodes)`;
      }
      else if (task.type === 'single_node') {
        const wf = task.args[0];
        const nodeId = task.args[1];
        const node = wf.nodes ? wf.nodes.find(n => n.id === nodeId) : null;

        if (node) {
          const defaultNames = {
            'prompt': 'Text / Prompt',
            'prompt_list': 'Prompt List',
            'gemini_prompt': 'Gemini Prompt',
            'upload_image': 'Upload Media',
            'generate_image': 'Generate Image',
            'generate_video': 'Generate Video',
            'merge_video': 'Ghép Video (Merge)',
            'download': 'Download'
          };
          const defaultName = defaultNames[node.type] || node.type;
          name = node.customName ? node.customName : `${defaultName} (${node.id})`;

          if (node.type === 'prompt' && node.config && node.config.text) {
            desc = node.config.text;
          } else if (node.type === 'prompt_list' && node.config && node.config.text) {
            const promptCount = node.config.text.split('\n').filter(Boolean).length;
            desc = `Danh sách: ${promptCount} prompts`;
          } else {
            desc = `Chạy node độc lập`;
          }
        } else {
          name = "Chạy Node Riêng";
          desc = `Node ID: ${nodeId}`;
        }
      }

      return { id: idx, type: task.type, name, desc, status: statusType, progress: task.progress };
    };

    // Tạo mảng kết hợp (Active Task đứng đầu, Queue theo sau)
    const displayList = [];

    if (this.currentTask && this.isRunning) {
      // KỂ CẢ KHI isRunning = true, NẾU isPaused = true THÌ HIỂN THỊ TẠM DỪNG
      const activeStatus = this.isPaused ? 'paused' : 'running';
      displayList.push(parseTaskData(this.currentTask, -1, activeStatus));
    }

    this.queue.forEach((t, i) => {
      displayList.push(parseTaskData(t, i, i === 0 ? 'next' : 'waiting'));
    });

    this.emit('queue_update', displayList);
    this.updateWfbStats();
  }





  // === REFERENCE IMAGE STUBS ===
  // Các method này không còn cần thiết với hệ thống API.
  // uploadImageToFlow() đã thay thế bằng _apiClient.uploadImage()
  async clickPlusButton() { return false; }
  async _uploadImageFileToFlow(filePath) { return await this.uploadImageToFlow(filePath, 'ref') !== null; }
  async uploadAllImagesToFlow(filePaths) {
    const uploaded = [];
    for (const fp of filePaths) {
      const id = await this.uploadImageToFlow(fp, 'ref');
      if (id) uploaded.push(fp);
    }
    return uploaded;
  }
  async uploadReferenceImage(filePath) { return await this.uploadImageToFlow(filePath, 'ref') !== null; }

  // ═══════════════════════════════════════════════════════════
  //  BUILDER WORKFLOW EXECUTION ENGINE
  // ═══════════════════════════════════════════════════════════

  /**
     * Sắp xếp nodes theo thứ tự topo (từ input → output)
     */
  _wfTopoSort(nodes, connections) {
    const inDeg = {}, adj = {};
    nodes.forEach(n => { inDeg[n.id] = 0; adj[n.id] = []; });
    connections.forEach(c => {
      const from = c.fromNode || c.source; // Hỗ trợ cả 2 chuẩn
      const to = c.toNode || c.target;
      if (!from || !to || !adj[from]) return;
      if (!adj[from].includes(to)) adj[from].push(to);
      inDeg[to] = (inDeg[to] || 0) + 1;
    });
    const queue = nodes.filter(n => inDeg[n.id] === 0).map(n => n.id);
    const sorted = [];
    while (queue.length) {
      const id = queue.shift();
      sorted.push(id);
      (adj[id] || []).forEach(nid => { if (--inDeg[nid] === 0) queue.push(nid); });
    }
    return sorted.map(id => nodes.find(n => n.id === id)).filter(Boolean);
  }

  /**
   * Thu thập inputs từ các node upstream cho node hiện tại
   */
  _wfCollectInputs(node, connections, nodeOutputs, wfNodes) {
    const result = { text: null, textList: [], images: [], videos: [] };
    const nodeConns = connections.filter(c => c.toNode === node.id || c.target === node.id);

    for (const conn of nodeConns) {
      const fromNodeId = conn.fromNode || conn.source;
      const out = nodeOutputs[fromNodeId];
      if (!out) continue;

      const fromNodeObj = wfNodes ? wfNodes.find(n => n.id === fromNodeId) : null;
      const isMultiOutputGenNode = fromNodeObj && (fromNodeObj.type === 'generate_image' || fromNodeObj.type === 'generate_video');

      const toPortStr = conn.toPort !== undefined ? conn.toPort : (conn.targetHandle ? conn.targetHandle.replace(/\D/g, '') : '0');
      const toPort = parseInt(toPortStr) || 0;

      const fromPortStr = conn.fromPort !== undefined ? conn.fromPort : (conn.sourceHandle ? conn.sourceHandle.replace(/\D/g, '') : '0');
      const fromPort = parseInt(fromPortStr) || 0;

      if (toPort === 0) {
        if (out.text != null) result.text = out.text;
        if (out.textList) result.textList.push(...out.textList);
      } else {
        if (isMultiOutputGenNode) {
          if (out.images && out.images[fromPort]) result.images.push(out.images[fromPort]);
          if (out.videos && out.videos[fromPort]) result.videos.push(out.videos[fromPort]);
        } else {
          if (out.images && out.images.length > 0) result.images.push(...out.images);
          if (out.videos && out.videos.length > 0) result.videos.push(...out.videos);
        }
      }
    }

    if (node.type === 'download' || node.type === 'merge_video') {
      result.images = [];
      result.videos = [];
      for (const conn of nodeConns) {
        const fromNodeId = conn.fromNode || conn.source;
        const out = nodeOutputs[fromNodeId];
        if (!out) continue;

        const fromNodeObj = wfNodes ? wfNodes.find(n => n.id === fromNodeId) : null;
        const isMultiOutputGenNode = fromNodeObj && (fromNodeObj.type === 'generate_image' || fromNodeObj.type === 'generate_video');
        const fromPortStr = conn.fromPort !== undefined ? conn.fromPort : (conn.sourceHandle ? conn.sourceHandle.replace(/\D/g, '') : '0');
        const fromPort = parseInt(fromPortStr) || 0;

        if (isMultiOutputGenNode) {
          if (out.images && out.images[fromPort]) result.images.push(out.images[fromPort]);
          if (out.videos && out.videos[fromPort]) result.videos.push(out.videos[fromPort]);
        } else {
          if (out.images) result.images.push(...out.images);
          if (out.videos) result.videos.push(...out.videos);
        }
      }
    }
    return result;
  }

  _wfExtractNodeState(node) {
    const fs = require('fs');
    let output = {};
    switch (node.type) {
      case 'prompt':
        output = { text: node.config.text || '' };
        break;
      case 'gemini_prompt':
        output = { text: node.config.promptTemplate || node.config.text || '' };
        break;
      case 'prompt_list':
        const tl = (node.config.text || '').split('\n').map(s => s.trim()).filter(Boolean);
        output = { textList: tl };
        break;
      case 'upload_image':
        if (node.config.imagePath && fs.existsSync(node.config.imagePath)) {
          const isVideo = node.config.imagePath.match(/\.(mp4|webm|mov|avi)$/i);
          const mediaObj = { localPath: node.config.imagePath, path: node.config.imagePath, url: node.config.imageUrl || '', type: isVideo ? 'video' : 'image' };
          if (isVideo) {
            output = { videos: [mediaObj], images: [] };
          } else {
            output = { images: [mediaObj], videos: [] };
          }
        }
        break;
      case 'generate_image':
      case 'generate_video': {
        if (node.previewMedia && node.previewMedia.length > 0) {
          const mediaType = node.type === 'generate_video' ? 'videos' : 'images';
          output = {
            [mediaType]: node.previewMedia.map(m => ({
              url: m.url, type: m.type || 'image', sourcePrompt: m.sourcePrompt || ''
            }))
          };
        }
        break;
      }
    }
    return output;
  }

  /**
   * Thu thập inputs từ các node upstream cho node hiện tại
   * Returns: { text: string|null, images: [{path,url,type}], videos: [{path,url}] }
   */
  _wfCollectInputs(node, connections, nodeOutputs, wfNodes) {
    const result = { text: null, textList: [], images: [], videos: [] };
    const nodeConns = connections.filter(c => c.toNode === node.id);

    for (const conn of nodeConns) {
      const out = nodeOutputs[conn.fromNode];
      if (!out) continue;

      const fromNodeObj = wfNodes ? wfNodes.find(n => n.id === conn.fromNode) : null;
      const isMultiOutputGenNode = fromNodeObj && (fromNodeObj.type === 'generate_image' || fromNodeObj.type === 'generate_video');

      if (conn.toPort === 0) {
        // Port 0 = text/prompt input
        if (out.text != null) result.text = out.text;
        if (out.textList) result.textList.push(...out.textList);
      } else {
        // Port > 0 = image reference inputs
        if (isMultiOutputGenNode) {
          const idx = conn.fromPort;
          if (out.images && out.images[idx]) result.images.push(out.images[idx]);
          if (out.videos && out.videos[idx]) result.videos.push(out.videos[idx]);
        } else {
          if (out.images && out.images.length > 0) result.images.push(...out.images);
          if (out.videos && out.videos.length > 0) result.videos.push(...out.videos);
        }
      }
    }

    // For download & merge node: collect ALL streams from ALL connections (multi-stream)
    if (node.type === 'download' || node.type === 'merge_video') {
      result.images = [];
      result.videos = [];
      for (const conn of nodeConns) {
        const out = nodeOutputs[conn.fromNode];
        if (!out) continue;

        const fromNodeObj = wfNodes ? wfNodes.find(n => n.id === conn.fromNode) : null;
        const isMultiOutputGenNode = fromNodeObj && (fromNodeObj.type === 'generate_image' || fromNodeObj.type === 'generate_video');

        if (isMultiOutputGenNode) {
          const idx = conn.fromPort;
          if (out.images && out.images[idx]) result.images.push(out.images[idx]);
          if (out.videos && out.videos[idx]) result.videos.push(out.videos[idx]);
        } else {
          if (out.images) result.images.push(...out.images);
          if (out.videos) result.videos.push(...out.videos);
        }
      }
    }

    return result;
  }

  /**
   * Chuyển đổi file path → base64 data URL để upload lên Flow
   */
  _fileToDataUrl(filePath) {
    try {
      const buf = fs.readFileSync(filePath);
      const ext = path.extname(filePath).slice(1).toLowerCase() || 'png';
      const mime = ext === 'jpg' ? 'jpeg' : ext;
      return `data:image/${mime};base64,${buf.toString('base64')}`;
    } catch (e) {
      this.log(`Không đọc được file ${filePath}: ${e.message}`, 'warning');
      return null;
    }
  }

  /**
   * Helper: fetch URL qua browser page -> luu vao temp file
   */
  async _wfFetchUrlToTemp(url, mediaType) {
    // Dùng _fetchUrlToBuffer (HTTP thuần) thay vì page.evaluate
    const ext = mediaType === 'video' ? '.mp4' : '.png';
    const tmpDir = path.join(os.tmpdir(), 'veo3_wf');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const localPath = path.join(tmpDir, `ref_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);
    try {
      const buf = await this._fetchUrlToBuffer(url);
      if (!buf) return null;
      fs.writeFileSync(localPath, buf);
      return localPath;
    } catch (e) {
      this.log(`  Không tải được ref từ URL: ${e.message}`, 'warning');
      return null;
    }
  }

  /**
     * Chay generate node (image hoac video)
     * Upload TAT CA ref images (nhieu anh), sau do download ket qua ve temp
     */
  async _wfRunGenNode(node, inputs, genType) {
    const promptList = (() => {
      if (inputs.textList && inputs.textList.length > 0) return inputs.textList;
      if (inputs.text) return [inputs.text];
      const t = node.config.promptTemplate || node.config.text || '';
      if (!t.trim()) throw new Error(`Node ${node.id}: Không có prompt!`);
      return t.split('\n').map(s => s.trim()).filter(Boolean);
    })();

    const quantity = parseInt(node.config.quantity) || 1;
    const aspectRatio = ASPECT_RATIO_MAP[node.config.ratio] || '16:9';
    const allPreviewFiles = [];
    const allPreviewData = [];

    // Khởi tạo bộ đếm ngoài vòng lặp prompt để bắt chính xác lỗi 403 liên tiếp
    let attempt403Count = 0;

    for (let pIdx = 0; pIdx < promptList.length; pIdx++) {
      const promptText = promptList[pIdx];
      if (!this.isRunning) break;
      while (this.isPaused) { await this.delay(1000); if (!this.isRunning) break; }

      this.log(`  [Node ${node.id}] Prompt ${pIdx + 1}/${promptList.length}: "${promptText.substring(0, 50)}..."`, 'info');

      // ── Upload ảnh tham chiếu nếu có ──────────────────────────
      // ── Upload ảnh tham chiếu hoặc keyframes ──────────────────────────
      let startImageId = null;
      let endImageId = null;
      let referenceMediaIds = [];

      if (inputs.images && inputs.images.length > 0) {
        const isFrameMode = (node.type === 'generate_video' && (!node.config.videoMode || node.config.videoMode === 'FRAME'));
        for (let i = 0; i < inputs.images.length; i++) {
          const img = inputs.images[i];
          let mediaId = null;

          if (img.id && /^[A-Za-z0-9-]+$/.test(img.id) && !img.id.startsWith('img_')) {
            // Natively generated Google Media ID (e.g. from Generate Video)
            mediaId = img.id;
          } else {
            let src = img.localPath || img.url || null;
            if (!src) continue;

            // Normalize Google protocol-relative URLs
            if (src.startsWith('//lh3')) src = 'https:' + src;

            // Ensure direct URLs are downloaded to a local file before API upload
            if (src.startsWith('http://') || src.startsWith('https://')) {
              this.log(`  [Node ${node.id}] Đang tải ảnh từ URL để làm tham chiếu...`, 'info');
              const localFile = await this._wfFetchUrlToTemp(src, img.type || 'image');
              if (localFile) src = localFile; // swap src to the exact local file path
            }

            if (src) {
              mediaId = await this.uploadImageToFlow(src, 'ref');
            }
          }

          if (!mediaId) continue;

          if (isFrameMode) {
            if (i === 0) startImageId = mediaId;
            else if (i === 1) endImageId = mediaId;
          } else {
            referenceMediaIds.push(mediaId);
          }
        }
      }

      // ── Gọi API tạo media ──────────────────────────────────────
      let genResult;
      let generationAttempts = 0;
      const MAX_GEN_ATTEMPTS = 5;

      while (generationAttempts < MAX_GEN_ATTEMPTS) {
        generationAttempts++;
        let startResult;

        // ── Chống Burst API: xếp hàng chờ để không dội bom API cùng 1 tích tắc gây 403 ──
        if (!this._apiBurstMutex) this._apiBurstMutex = Promise.resolve();
        this._apiBurstMutex = this._apiBurstMutex.then(() => this.delay(3500));
        await this._apiBurstMutex;

        try {
          if (genType === 'image') {
            startResult = await this._apiClient.generateImage(promptText, {
              aspectRatio,
              count: quantity,
              referenceImages: referenceMediaIds.length > 0 ? referenceMediaIds : undefined,
            });
          } else {
            let videoModel = VIDEO_MODEL_MAP[node.config.videoModel || this.settings.videoModel] || 'veo_3_1_fast';
            const hasR2V = (referenceMediaIds && referenceMediaIds.length > 0);
            if (videoModel === 'veo_3_1_lite' && hasR2V) {
              videoModel = 'veo_3_1_fast';
              this.log(`⚠️ [Node ${node.id}] Video Lite không hỗ trợ ảnh tham chiếu (Like). Tự chuyển sang model Fast!`, 'warning');
            }

            startResult = await this._apiClient.generateVideo(promptText, {
              model: videoModel,
              aspectRatio,
              count: quantity,
              startImageId: startImageId || undefined,
              endImageId: endImageId || undefined,
              referenceImages: referenceMediaIds.length > 0 ? referenceMediaIds : undefined,
            });
          }
        } catch (apiErr) {
          const is403 = apiErr.message.includes('AUTH_ERROR_403') || apiErr.message.includes('403');
          if (is403) {
            const attempt403 = (attempt403Count = (attempt403Count || 0) + 1);

            // Option A: On 2nd 403 failure, try switching to a backup cookie account
            if (attempt403 >= 2 && this._tokenManager && typeof this._tokenManager.switchToNextAccount === 'function') {
              this.log(`⚡ [Node ${node.id}] 403 liên tục (lần ${attempt403}) — đang chuyển tài khoản dự phòng...`, 'warning');
              const switched = await this._tokenManager.switchToNextAccount('403 persistent');
              if (switched) {
                this.log(`✅ [Node ${node.id}] Đã chuyển tài khoản thành công. Retry...`, 'success');
                this._apiClient._projectId = null; // reset project for new account
                attempt403Count = 0; // Reset counter sau khi chuyển sang tài khoản mới
              } else {
                // No backup accounts — fall back to wait
                const waitSec = Math.min(90 + (attempt403 - 1) * 30, 150);
                this.log(`⚠️ [Node ${node.id}] Không có tài khoản dự phòng. Chờ ${waitSec}s...`, 'warning');
                await this.delay(waitSec * 1000);
                if (!this.isRunning) break; // Break while loop
                if (this._tokenManager) {
                  if (typeof this._tokenManager._rotateRecaptchaSession === 'function') {
                    await this._tokenManager._rotateRecaptchaSession('403 retry');
                  }
                  this._tokenManager._recaptchaCallCount = 0;
                  this._tokenManager._lastRecaptchaAt = 0;
                }
              }
            } else {
              // First 403: just rotate session and wait briefly
              const waitSec = 90;
              this.log(`⚠️ [Node ${node.id}] reCAPTCHA bị block (403). Chờ ${waitSec}s rồi retry...`, 'warning');
              await this.delay(waitSec * 1000);
              if (!this.isRunning) break; // Break while loop
              if (this._tokenManager) {
                if (typeof this._tokenManager._rotateRecaptchaSession === 'function') {
                  await this._tokenManager._rotateRecaptchaSession('403 retry');
                }
                this._tokenManager._recaptchaCallCount = 0;
                this._tokenManager._lastRecaptchaAt = 0;
              }
            }
            continue; // Continue while loop to retry API
          } else {
            if (apiErr.message && apiErr.message.startsWith('POLICY_VIOLATION')) {
              this.log(`🚫 [Google Policy] [Node ${node.id}] Prompt bị chặn do chính sách Google: ${apiErr.message.replace('POLICY_VIOLATION: ', '')}`, 'error');
              break; // Do not retry policy violations
            }
            this.log(`❌ [Node ${node.id}] Lỗi API: ${apiErr.message}`, 'error');
            break; // Break on hard exceptions like network failures after retries in ApiClient
          }
        }

        // ── Xử lý kết quả sau khi gọi API ────────────────────────
        attempt403Count = 0; // Call API thành công, reset trạng thái 403 liên tiếp

        if (genType === 'image') {
          // IMAGE: kết quả có ngay trong response, KHÔNG cần poll checkVideoStatus
          const images = (startResult.media || []).map((m, idx) => ({
            type: 'image',
            url: m.image?.generatedImage?.fifeUrl
              || m.mediaMetadata?.mediaStatus?.downloadUrl
              || m.mediaMetadata?.image?.fifeUrl
              || '',
            id: m.image?.generatedImage?.mediaId || m.name || `img_${idx}`,
            editLink: null,
          })).filter(m => m.url);

          if (images.length === 0) {
            this.log(`⚠️ [Node ${node.id}] Image API không có URL!`, 'warning');
            break; // Give up
          }

          genResult = { media: images };
          this.log(`✅ OK [Node ${node.id}] image x${images.length} tạo xong!`, 'success');
          break; // Break retry loop
        } else {
          // VIDEO: async — poll cho đến khi hoàn thành
          const mediaItems = (startResult.media || []).map(m => ({
            name: m.name,
            projectId: m.projectId || this._apiClient._projectId,
          }));

          if (mediaItems.length === 0) {
            this.log(`⚠️ [Node ${node.id}] API không trả về media items để poll!`, 'warning');
            break;
          }

          const waitMs = this.settings.waitForGeneration || 300000;
          genResult = await this.waitForGeneration(waitMs, mediaItems, 'video', null);

          if (genResult.status === 'server_error') {
            if (generationAttempts < MAX_GEN_ATTEMPTS) {
              await this.delay(3000);
              continue; // Silently retry video generation
            } else {
              this.log(`❌ [Node ${node.id}] Máy chủ Google liên tục báo lỗi sau ${MAX_GEN_ATTEMPTS} lần thử! Chi tiết: ${genResult.error}`, 'error');
            }
          }

          if (!genResult.media || genResult.media.length === 0) {
            this.log(`⚠️ [Node ${node.id}] Không có media thành công!`, 'warning');
            break; // Give up
          }

          this.log(`✅ OK [Node ${node.id}] video x${genResult.media.length} xong!`, 'success');
          break; // Break retry loop (Success)
        }
      } // End while retry loop

      if (!genResult || !genResult.media || genResult.media.length === 0) continue; // Next prompt

      this.emit('newMedia', { nodeId: node.id, media: genResult.media });

      const previewFiles = genResult.media.map(m => ({
        url: m.url, type: m.type, id: m.id, editLink: null, sourcePrompt: promptText
      }));

      // ── Download preview data để gửi về UI ────────────────────
      for (const m of genResult.media) {
        try {
          let buf = null;
          let actualType = m.type;
          let mime = m.type === 'video' ? 'video/mp4' : 'image/png';

          if (m.type === 'video' && m.id && this._apiClient) {
            const projectId = m.projectId || this._apiClient._projectId;

            // ── DIAGNOSTIC: probe all URL types to find which one returns real video ──
            if (this._apiClient.probeVideoUrlTypes) {
              const probeResults = await this._apiClient.probeVideoUrlTypes(m.id).catch(() => []);
              const videoTypes = probeResults.filter(r => r.isVideo);
              if (videoTypes.length > 0) {
                this.log(`  ✅ Found ${videoTypes.length} video URL type(s): ${videoTypes.map(r => r.type.replace('MEDIA_URL_TYPE_', '')).join(', ')}`, 'success');
              } else {
                this.log(`  ⚠️ Probe: all URL types return JPEG/non-video`, 'warning');
              }
            }

            // ── Attempt 0: Direct video URL from API response ─────────────────
            const directApiUrl = m.directUrl || m.videoUrl;
            if (directApiUrl && !buf) {
              this.log(`  🔗 Direct API URL...`, 'info');
              const raw = await this._fetchUrlToBuffer(directApiUrl);
              if (raw && raw.length > 500000) {
                const isMp4 = raw.slice(4, 8).toString('ascii') === 'ftyp';
                if (isMp4 || (raw[0] === 0x1A && raw[1] === 0x45)) {
                  buf = raw; mime = isMp4 ? 'video/mp4' : 'video/webm'; actualType = 'video';
                  this.log(`  ✅ Direct API: ${Math.round(buf.length / 1024)}KB`, 'info');
                }
              }
            }

            // ── Attempt 1: Navigate to workflow page → capture ALL tRPC calls + video URL ──
            // Logs every API endpoint called, finds <video>.currentSrc, tries download button
            if (!buf && this._apiClient.downloadVideoViaWorkflowPage) {
              this.log(`  🌐 Workflow page exploration...`, 'info');
              try {
                const workflowId = m.workflowId;
                const { url: videoGcsUrl, tRPCCalls } = await this._apiClient.downloadVideoViaWorkflowPage(m.id, projectId, workflowId);
                this.log(`  📋 tRPC calls seen: ${tRPCCalls.join(', ') || 'none'}`, 'info');
                if (videoGcsUrl) {
                  this.log(`  ⬇️ Downloading from workflow page URL...`, 'info');
                  const raw = await this._fetchUrlToBuffer(videoGcsUrl);
                  if (raw && raw.length > 500000) {
                    const isMp4 = raw.slice(4, 8).toString('ascii') === 'ftyp';
                    if (isMp4 || (raw[0] === 0x1A && raw[1] === 0x45)) {
                      buf = raw; mime = isMp4 ? 'video/mp4' : 'video/webm'; actualType = 'video';
                      this.log(`  ✅ Workflow page video: ${Math.round(buf.length / 1024)}KB`, 'success');
                    }
                  } else if (raw) {
                    this.log(`  ⚠️ Workflow page URL returned ${raw.length}B — likely not real video`, 'warning');
                  }
                }
              } catch (e) {
                this.log(`  ⚠️ Workflow page error: ${e.message}`, 'warning');
              }
            }

            // ── Attempt 2: CDP <video> element injection ──────────────────────
            if (!buf && this._apiClient.downloadVideoViaCDP) {
              this.log(`  🎬 CDP <video> download...`, 'info');
              const cdpBuf = await this._apiClient.downloadVideoViaCDP(m.id);
              if (cdpBuf && cdpBuf.length > 500000) {
                const isMp4 = cdpBuf.slice(4, 8).toString('ascii') === 'ftyp';
                buf = cdpBuf; mime = isMp4 ? 'video/mp4' : 'video/webm'; actualType = 'video';
              } else if (cdpBuf) {
                this.log(`  ⚠️ CDP returned ${Math.round(cdpBuf.length / 1024)}KB (too small — thumbnail)`, 'warning');
              }
            }

            // ── Attempt 3: ffmpeg with browser cookies ────────────────────────
            // ffmpeg libav HTTP: no Sec-Fetch-* headers, media player UA
            // NOTE: if ffmpeg returns <500KB, it got JPEG thumbnail (1-frame MP4 wrapper)
            if (!buf && this._apiClient.downloadVideoViaFfmpeg) {
              const videoApiUrl = `https://labs.google/fx/api/trpc/media.getMediaUrlRedirect` +
                `?name=${encodeURIComponent(m.id)}&mediaUrlType=MEDIA_URL_TYPE_THUMBNAIL`;
              this.log(`  🎞️ ffmpeg download...`, 'info');
              const ffBuf = await this._apiClient.downloadVideoViaFfmpeg(videoApiUrl);
              if (ffBuf && ffBuf.length > 500000) {
                const isMp4 = ffBuf.slice(4, 8).toString('ascii') === 'ftyp';
                buf = ffBuf; mime = isMp4 ? 'video/mp4' : 'video/webm'; actualType = 'video';
                this.log(`  ✅ ffmpeg real video: ${Math.round(buf.length / 1024)}KB`, 'info');
              } else if (ffBuf) {
                this.log(`  ⚠️ ffmpeg ${Math.round(ffBuf.length / 1024)}KB — JPEG thumbnail wrapped as MP4, not real video`, 'warning');
                // Still use it as thumbnail preview (better than nothing)
                buf = ffBuf; mime = 'video/mp4'; actualType = 'image'; // treat as image preview
              }
            }

            // ── FALLBACK: download m.url (thumbnail JPEG from CDP capture) ────
            if (!buf && m.url) {
              const raw = await this._fetchUrlToBuffer(m.url);
              if (raw && raw.length > 8) {
                const isMp4 = raw.slice(4, 8).toString('ascii') === 'ftyp';
                const isWebM = raw[0] === 0x1A && raw[1] === 0x45;
                const isJpeg = raw[0] === 0xFF && raw[1] === 0xD8;
                buf = raw;
                if (isMp4 || isWebM) {
                  mime = isMp4 ? 'video/mp4' : 'video/webm';
                  actualType = 'video';
                  this.log(`  ✅ URL download: ${Math.round(raw.length / 1024)}KB`, 'info');
                } else {
                  mime = isJpeg ? 'image/jpeg' : 'image/png';
                  actualType = 'image';
                  this.log(`  ℹ️ URL chỉ có thumbnail ảnh`, 'info');
                }
              }
            }



          } else {
            // ── Image: download bình thường ───────────────────────────────────
            buf = await this._fetchUrlToBuffer(m.url);
            if (buf && buf.length > 8) {
              const magic4 = buf.slice(0, 4);
              const isJpeg = magic4[0] === 0xFF && magic4[1] === 0xD8;
              const isPng = magic4[0] === 0x89 && magic4[1] === 0x50;
              mime = isJpeg ? 'image/jpeg' : isPng ? 'image/png' : 'image/jpeg';
              actualType = 'image';
            }
          }

          if (buf) {
            const b64 = buf.toString('base64');
            allPreviewData.push({ url: `data:${mime};base64,${b64}`, type: actualType });
          } else {
            allPreviewData.push({ url: m.url, type: m.type });
          }
        } catch {
          allPreviewData.push({ url: m.url, type: m.type });
        }
      }

      allPreviewFiles.push(...previewFiles);

      // Chống spam chỉ khi trong cùng 1 Node có nhiều prompt (Batch)
      if (promptList.length > 1 && pIdx < promptList.length - 1) {
        this.log(`⏳ Đợi bảo vệ spam trước prompt tiếp theo của Node này...`, 'info');
        await this.delay(10000);
      }
    }

    this.emit('wfNodeResult', { nodeId: node.id, media: allPreviewData });
    return genType === 'image' ? { images: allPreviewFiles } : { videos: allPreviewFiles };
  }



  /**
     * Node: Gemini Prompt (Hỗ trợ Text, Image, và Video)
     */
  async _wfRunGeminiNode(node, inputs, connections = []) {
    const apiKey = node.config.apiKey?.trim();
    if (!apiKey) {
      this.log(`  [GEMINI] Chưa cài API Key!`, 'error');
      throw new Error('Bạn chưa dán API Key cho Node Gemini.');
    }

    const inputContext = inputs.text || '';
    let finalPrompt = inputContext;

    if (node.config.useAdditionalText && node.config.additionalText) {
      const addText = node.config.additionalText.trim();
      if (addText) {
        finalPrompt = finalPrompt ? `${finalPrompt}\n\n${addText}` : addText;
      }
    }

    const fs = require('fs');
    const path = require('path');
    const parts = [];

    // 1. Thêm Text Prompt vào payload
    if (finalPrompt.trim()) {
      parts.push({ text: finalPrompt });
    }

    // 2. Xử lý Hình ảnh (Dùng Base64 Inline)
    if (inputs.images && inputs.images.length > 0) {
      for (const img of inputs.images) {
        let imgPath = img.localPath || img.path;

        if ((!imgPath || !fs.existsSync(imgPath)) && img.url) {
          imgPath = await this._wfFetchUrlToTemp(img.url, 'image');
        }

        if (imgPath && fs.existsSync(imgPath)) {
          try {
            let ext = path.extname(imgPath).slice(1).toLowerCase();
            if (!ext) ext = 'png';
            const mimeType = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;

            const base64Data = fs.readFileSync(imgPath).toString('base64');
            parts.push({
              inlineData: { mimeType: mimeType, data: base64Data }
            });
            this.log(`  [GEMINI] Đã đính kèm ảnh: ${path.basename(imgPath)}`, 'info');
          } catch (err) {
            this.log(`  [GEMINI] Lỗi đọc ảnh ${imgPath}: ${err.message}`, 'warning');
          }
        }
      }
    }

    // 3. Xử lý Video (Dùng Gemini File API)
    if (inputs.videos && inputs.videos.length > 0) {
      for (const vid of inputs.videos) {
        let vidPath = vid.localPath || vid.path;

        if ((!vidPath || !fs.existsSync(vidPath)) && vid.url) {
          vidPath = await this._wfFetchUrlToTemp(vid.url, 'video');
        }

        if (vidPath && fs.existsSync(vidPath)) {
          try {
            this.log(`  [GEMINI] Đang upload video lên hệ thống Google: ${path.basename(vidPath)}...`, 'info');
            const stats = fs.statSync(vidPath);
            let ext = path.extname(vidPath).slice(1).toLowerCase();
            const mimeType = ext === 'webm' ? 'video/webm' : 'video/mp4';
            const fileBuffer = fs.readFileSync(vidPath);

            // Upload Raw byte trực tiếp lên File API
            const uploadRes = await fetch(`https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`, {
              method: 'POST',
              headers: {
                'X-Goog-Upload-Protocol': 'raw',
                'X-Goog-Upload-Command': 'start, upload, finalize',
                'X-Goog-Upload-Header-Content-Length': stats.size.toString(),
                'X-Goog-Upload-Header-Content-Type': mimeType,
                'Content-Type': mimeType
              },
              body: fileBuffer
            });

            const uploadData = await uploadRes.json();
            if (!uploadRes.ok || !uploadData.file) {
              throw new Error(uploadData.error?.message || 'Lỗi upload video.');
            }

            const fileUri = uploadData.file.uri;
            const fileName = uploadData.file.name; // Dùng để check status
            this.log(`  [GEMINI] Upload thành công! Chờ xử lý video...`, 'success');

            // Video cần thời gian để Gemini trích xuất frame (Processing -> Active)
            let isReady = false;
            for (let i = 0; i < 12; i++) { // Thử tối đa 12 lần (1 phút)
              const checkRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${apiKey}`);
              const checkData = await checkRes.json();

              if (checkData.state === 'ACTIVE') {
                isReady = true;
                break;
              } else if (checkData.state === 'FAILED') {
                throw new Error('Gemini báo lỗi khi xử lý video này.');
              }

              await this.delay(5000); // Đợi 5s rồi check lại
            }

            if (!isReady) {
              this.log(`  [GEMINI] ⚠️ Video có thể chưa sẵn sàng, nhưng vẫn thử gọi API...`, 'warning');
            } else {
              this.log(`  [GEMINI] Video đã sẵn sàng để phân tích!`, 'success');
            }

            // Truyền File URI thay vì Base64
            parts.push({
              fileData: { mimeType: mimeType, fileUri: fileUri }
            });

          } catch (err) {
            this.log(`  [GEMINI] Lỗi xử lý video ${vidPath}: ${err.message}`, 'error');
          }
        }
      }
    }

    if (parts.length === 0) {
      throw new Error('Cần ít nhất Text, Hình ảnh, hoặc Video để gọi Gemini.');
    }

    this.log(`  [GEMINI] Đang gọi Gemini API (Tự động chuyển kênh chờ server)...`, 'info');

    const modelsToTry = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];
    let aiText = '';
    let lastErrorMsg = '';

    for (const model of modelsToTry) {
      try {
        const gRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: parts }],
            generationConfig: { temperature: 0.7 }
          })
        });

        const gData = await gRes.json();
        if (!gRes.ok || !gData.candidates || !gData.candidates[0]) {
          throw new Error(gData.error?.message || `Lỗi máy chủ Google (${gRes.status}).`);
        }

        aiText = gData.candidates[0].content.parts[0].text;

        this.log(`  [GEMINI] Thành công với ${model}! Output: "${aiText.substring(0, 60)}..."`, 'success');
        lastErrorMsg = '';
        break; // Thoát vòng lặp vì đã thành công

      } catch (err) {
        lastErrorMsg = err.message;
        // Chỉ log cảnh báo mềm rồi tiếp tục vòng lặp
        this.log(`  [GEMINI] Model ${model} bận/lỗi. Đang tự động đổi luồng dự phòng...`, 'warning');
      }
    }

    if (lastErrorMsg) {
      this.log(`  [GEMINI] Lỗi: Cả 3 kênh Gemini đều bận. Lỗi cuối: ${lastErrorMsg}`, 'error');
      throw new Error('Lỗi Gemini API: ' + lastErrorMsg);
    }

    this.emit('wfNodeUpdateConfig', {
      nodeId: node.id,
      config: { promptTemplate: aiText, text: aiText }
    });
    this.emit('wfNodeResult', { nodeId: node.id, media: [{ type: 'text', url: aiText }] });

    return { text: aiText };
  }



  /**
   * Chon anh moi nhat tu lich su Flow:
   * 1. Mo panel "+"
   * 2. Scroll danh sach xuong day -> item moi nhat hien ra (data-item-index cao nhat)
   * 3. Click item cuoi => khong can filter, nhanh hon
   */


  /**
   * Download media ve thu muc temp de truyen giua cac nodes
   * Luu them editLink va sourcePrompt de node sau dung lai tu lich su Flow
   */
  async _wfDownloadMediaLocal(mediaList, prefix, sourcePrompt) {
    const tmpDir = path.join(os.tmpdir(), 'veo3_wf');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

    const downloaded = [];
    for (let i = 0; i < mediaList.length; i++) {
      const media = mediaList[i];
      const ext = media.type === 'video' ? '.mp4' : '.png';
      const filename = `${prefix}_${i}${ext}`;
      const localPath = path.join(tmpDir, filename);
      try {
        if (media.localPath && fs.existsSync(media.localPath)) {
          fs.copyFileSync(media.localPath, localPath);
        } else if (media.url) {
          const buf = await this._fetchUrlToBuffer(media.url);
          if (!buf) continue;
          fs.writeFileSync(localPath, buf);
        } else {
          continue; // No valid source found
        }

        downloaded.push({
          localPath,
          url: media.url,
          type: media.type,
          id: media.id,
          editLink: media.editLink || null,
          sourcePrompt: sourcePrompt || null  // prompt da dung de tao anh nay
        });
        this.log(`  Tai tam: ${filename}`, 'info');
      } catch (e) {
        this.log(`  Loi tai tam ${filename}: ${e.message}`, 'warning');
      }
    }
    return downloaded;
  }

  /**
   * Download node: tai tat ca streams ve thu muc dich theo tuan tu
   * Ho tro ca anh va video, dam bao khong trung ten file
   */
  async _wfRunDownloadNode(node, inputs) {
    const { directory } = node.config;
    const allMedia = [...(inputs.images || []), ...(inputs.videos || [])];

    if (allMedia.length === 0) {
      this.log('  Download node: Khong co media de tai', 'warning');
      return;
    }

    const nodeQuality = node.config?.quality || 'original';
    const destDir = directory || path.join(__dirname, 'downloads');
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

    this.log(`  Download ${allMedia.length} file(s) -> ${destDir} [Chất lượng: ${nodeQuality}]`, 'info');

    const downloadedFiles = [];
    const seenNames = new Set();

    for (let i = 0; i < allMedia.length; i++) {
      const media = allMedia[i];
      const ext = media.type === 'video' ? '.mp4' : '.png';
      // Ten file doc nhat: dung id neu co, else timestamp+index
      const base = media.id ? `veo3_wf_${media.id}` : `veo3_wf_${Date.now()}_${i}`;
      let filename = `${base}${ext}`;
      let dup = 1;
      while (seenNames.has(filename)) filename = `${base}_${dup++}${ext}`;
      seenNames.add(filename);
      const destPath = path.join(destDir, filename);

      try {
        // Uu tien copy file local neu có truoc (VD: tu _wfRunMergeVideoNode)
        if (media.localPath && fs.existsSync(media.localPath)) {
          fs.copyFileSync(media.localPath, destPath);
          // Upscale nếu cần
          if (nodeQuality && !['original', 'native', 'gốc'].includes(nodeQuality.toLowerCase())) {
            await this.upscaleWithFFmpeg(destPath, nodeQuality, media.type === 'video' ? 'video' : 'image');
          }
          downloadedFiles.push({ path: destPath, filename });
          this.log(`  [${i + 1}/${allMedia.length}] Copy tệp ghép nối thành công: ${filename}${!['original', 'native', 'gốc'].includes(nodeQuality.toLowerCase()) ? ` [${nodeQuality}]` : ''}`, 'success');
          this.emit('mediaDownloaded', { files: [{ path: destPath, filename }], prompt: 'workflow' });
          continue;
        }

        // Tải trực tiếp từ preview URL qua API HTTP
        if (media.url) {
          const buf = await this._fetchUrlToBuffer(media.url);
          if (!buf) { this.log(`  [${i + 1}/${allMedia.length}] Không tải được: ${filename}`, 'warning'); continue; }
          fs.writeFileSync(destPath, buf);
          // Upscale nếu cần
          if (nodeQuality && !['original', 'native', 'gốc'].includes(nodeQuality.toLowerCase())) {
            await this.upscaleWithFFmpeg(destPath, nodeQuality, media.type === 'video' ? 'video' : 'image');
          }
          downloadedFiles.push({ path: destPath, filename });
          this.log(`  [${i + 1}/${allMedia.length}] Tải: ${filename}${!['original', 'native', 'gốc'].includes(nodeQuality.toLowerCase()) ? ` [${nodeQuality}]` : ''}`, 'success');
          this.emit('mediaDownloaded', { files: [{ path: destPath, filename }], prompt: 'workflow' });
          continue;
        }

        this.log(`  [${i + 1}/${allMedia.length}] Khong co URL de tai`, 'warning');
      } catch (e) {
        this.log(`  Loi tai stream ${i + 1}: ${e.message}`, 'error');
      }
    }

    this.log(`  Hoan thanh: ${downloadedFiles.length}/${allMedia.length} files`, 'success');
    return downloadedFiles;
  }

  /**
   * Node: Ghep cac streams video (Merge Video)
   */
  async _wfRunMergeVideoNode(node, inputs) {
    const allMedia = [...(inputs.videos || [])];
    if (allMedia.length < 2) {
      throw new Error('Ghép video cần ít nhất 2 luồng video cắm vào cổng Input.');
    }

    this.log(`  [MERGE] Đang tải ${allMedia.length} video về máy cục bộ để ghép...`, 'info');
    const localVideos = await this._wfDownloadMediaLocal(allMedia, `merge_tmp_${Date.now()}`);

    if (localVideos.length < 2) {
      throw new Error(`Ghép video thất bại: Chỉ tải được ${localVideos.length}/${allMedia.length} video.`);
    }

    const ffmpeg = require('fluent-ffmpeg');
    let ffmpegPath = require('ffmpeg-static');
    let ffprobePath = require('ffprobe-static').path;

    if (ffmpegPath) ffmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked');
    if (ffprobePath) ffprobePath = ffprobePath.replace('app.asar', 'app.asar.unpacked');

    ffmpeg.setFfmpegPath(ffmpegPath);
    ffmpeg.setFfprobePath(ffprobePath);

    this.log(`  [MERGE] Đang kiểm tra tỉ lệ khung hình (ffprobe)...`, 'info');

    const getMeta = (pathFile) => {
      return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(pathFile, (err, metadata) => {
          if (err) reject(err); else resolve(metadata);
        });
      });
    };

    let firstRatio = null;
    let firstRes = null;

    for (let i = 0; i < localVideos.length; i++) {
      const v = localVideos[i];
      try {
        const meta = await getMeta(v.localPath);
        const stream = meta.streams.find(s => s.width && s.height);
        if (stream) {
          const w = stream.width;
          const h = stream.height;
          const ratioClass = w > h ? 'landscape' : (h > w ? 'portrait' : 'square');

          if (firstRatio === null) {
            firstRatio = ratioClass;
            firstRes = `${w}x${h}`;
          } else if (firstRatio !== ratioClass) {
            throw new Error(`Hai video đầu vào không cùng tỉ lệ khung hình (Khác biệt: ${firstRes} và ${w}x${h}). Hãy đảm bảo chúng cùng chuẩn Ngang hoặc Dọc!`);
          }
        }
      } catch (e) {
        if (e.message.includes('không cùng tỉ lệ khung hình')) throw e;
        this.log(`  [Cảnh báo] Lỗi đọc ffprobe metadata: ${e.message}`, 'warning');
      }
    }

    this.log(`  [MERGE] Các video Đều trùng tỉ lệ (${firstRatio}). Đang gọi FFmpeg ghép nối...`, 'info');
    this.emit('wfNodeStatus', { nodeId: node.id, status: 'running', detail: 'Ghép video FFmpeg...' });

    const tmpDir = path.join(require('os').tmpdir(), 'veo3_wf');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const outputPath = path.join(tmpDir, `merged_veo3_${Date.now()}.mp4`);

    return new Promise((resolve, reject) => {
      const command = ffmpeg();
      localVideos.forEach(v => {
        command.input(v.localPath);
      });

      command.on('error', (err) => {
        this.log(`  Lệnh FFmpeg thất bại: ${err.message}`, 'error');
        reject(new Error(`Lỗi FFmpeg Plugin: ${err.message}`));
      })
        .on('end', () => {
          this.log(`  [MERGE] Đã ghép thành công video!`, 'success');

          let dataUrl = '';
          try {
            // Phát dataURL cho UI preview
            const b64 = fs.readFileSync(outputPath, 'base64');
            dataUrl = `data:video/mp4;base64,${b64}`;
            this.emit('wfNodeResult', { nodeId: node.id, media: [{ url: dataUrl, type: 'video' }] });
          } catch (e) { }

          resolve({
            videos: [{
              localPath: outputPath,
              url: dataUrl || '',
              type: 'video',
              id: `veo3_merged_${Date.now()}`
            }]
          });
        })
        .mergeToFile(outputPath, tmpDir);
    });
  }

  async runBuilderWorkflow(workflow, isFromQueue = false) {
    if (this.isRunning && !isFromQueue) {
      this.queue.push({ type: 'builder_workflow', args: [workflow] });
      this.emitQueueUpdate();
      this.log(`Tiến trình đang chạy! Đã thêm tác vụ (Builder Workflow) vào hàng đợi. Vị trí: ${this.queue.length}`, 'warning');
      return;
    }

    this.isRunning = true;
    this.isPaused = false;
    this.currentTask = { type: 'builder_workflow', args: [workflow] };
    this.emitQueueUpdate();
    this.emit('wf-builder-status', { state: 'running' });

    const { nodes, connections, name } = workflow;
    const nodeOutputs = {};

    // Progress Tracking
    const genNodes = nodes.filter(n => !n._isContextNode);
    this.currentTask.progress = { total: genNodes.length, completed: 0, runningType: null };

    this.log('═══════════════════════════════════', 'info');
    this.log(`▶ Bắt đầu Builder Workflow: "${name}"`, 'success');
    this.log(`  Nodes: ${nodes.length} | Connections: ${connections.length}`, 'info');
    this.log('═══════════════════════════════════', 'info');

    this.log('🧹 Đang dọn dẹp dữ liệu cũ của lần chạy trước...', 'info');
    for (const node of nodes) {
      if (!node._isContextNode && ['generate_image', 'generate_video', 'merge_video', 'gemini_prompt'].includes(node.type)) {
        node.previewMedia = []; // Xóa dữ liệu rác trong bộ nhớ backend
        this.emit('wfNodeResult', { nodeId: node.id, media: [] }); // Ép UI frontend xóa ảnh/video cũ
      }
    }

    try {
      // Đảm bảo hệ thống API đã sẵn sàng
      if (!this._apiClient) {
        const conn = await this.connect();
        if (!conn.success) {
          this.isRunning = false;
          this.currentTask = null; this.emitQueueUpdate();
          return;
        }
      }

      await this.ensureInProject();
      this.log(`🚀 Kích hoạt cơ chế Parallel Execution...`, 'info');

      // 🟢 KHỞI TẠO HỆ THỐNG MUTEX VÀ CLAIM MỚI
      this.uiMutex = Promise.resolve();
      this.claimedHrefs = new Set();
      const nodePromises = {};

      const executeNodeAsync = async (node) => {
        // CHỜ CÁC NODE CHA HOÀN TẤT
        const parentConns = connections.filter(c => c.toNode === node.id || c.target === node.id);
        for (const conn of parentConns) {
          const fromId = conn.fromNode || conn.source;
          if (nodePromises[fromId]) {
            await nodePromises[fromId];
          }
        }

        if (!this.isRunning) return;
        while (this.isPaused) { await this.delay(1000); if (!this.isRunning) return; }

        if (node._isContextNode) {
          nodeOutputs[node.id] = this._wfExtractNodeState(node);
          return;
        }

        this.currentTask.progress.runningType = node.type;
        this.emitQueueUpdate();

        this.emit('wfNodeStatus', { nodeId: node.id, status: 'running' });
        this.log(`⚙ Đang thực thi: [${node.type.toUpperCase()}] ${node.id}`, 'info');

        const inputs = this._wfCollectInputs(node, connections, nodeOutputs, nodes);
        let output = {};

        switch (node.type) {
          case 'prompt':
            output = { text: node.config.text || inputs.text || '' };
            break;
          case 'prompt_list':
            const promptListStr = inputs.text || node.config.text || '';
            output = { textList: promptListStr.split('\n').map(s => s.trim()).filter(Boolean) };
            this.emit('wfNodeUpdateConfig', { nodeId: node.id, config: { text: promptListStr } });
            this.emit('wfNodeResult', { nodeId: node.id, media: [{ type: 'text', url: promptListStr }] });
            break;
          case 'gemini_prompt':
            output = await this._wfRunGeminiNode(node, inputs, connections);
            break;
          case 'upload_image':
            output = this._wfExtractNodeState(node);
            break;
          case 'generate_image':
            output = await this._wfRunGenNode(node, inputs, 'image');
            break;
          case 'generate_video':
            output = await this._wfRunGenNode(node, inputs, 'video');
            break;
          case 'download':
            await this._wfRunDownloadNode(node, inputs);
            break;
          case 'merge_video':
            output = await this._wfRunMergeVideoNode(node, inputs);
            break;
          default:
            this.log(`Node type không hỗ trợ: ${node.type}`, 'warning');
        }

        nodeOutputs[node.id] = output;
        this.currentTask.progress.completed += 1;
        this.emitQueueUpdate();

        this.emit('wfNodeStatus', { nodeId: node.id, status: 'done' });
        this.emit('workflowStats', this.wfbStats);
      };

      // ĐẢM BẢO KHỞI TẠO THEO ĐÚNG THỨ TỰ TOPO
      const sorted = this._wfTopoSort(nodes, connections);

      for (const node of sorted) {
        nodePromises[node.id] = executeNodeAsync(node);
      }

      await Promise.all(Object.values(nodePromises));

      if (this.isRunning) {
        this.log('═══════════════════════════════════', 'info');
        this.log('✅ Builder Workflow hoàn tất!', 'success');
        this.log('═══════════════════════════════════', 'info');
        this.emit('wfComplete', { success: true, name });
        this.updateWfbStats('done');
      }

    } catch (err) {
      this.log(`Lỗi Builder Workflow: ${err.message}`, 'error');
      this.emit('wfError', { error: err.message });
      this.updateWfbStats('error');
    } finally {
      this.currentTask = null;
      this.emitQueueUpdate();

      if (this.queue.length > 0) {
        this.isRunning = true;
        setTimeout(() => this.checkQueue(), 100);
      } else {
        this.isRunning = false;
        this.isPaused = false;
        this.emit('wf-builder-status', { state: 'idle', message: '✅ Hoàn tất' });
        this.emit('stopped', true);
      }
    }
  }


  // Đóng browser (Chrome) gracefully — gọi khi server shutdown
  async closeBrowser() {
    try {
      if (this.browser) {
        this.log('Đang đóng Chrome...', 'info');
        await this.browser.close();
        this.browser = null;
        this.page = null;
        this.log('Đã đóng Chrome.', 'info');
      }
    } catch (e) {
      // Bỏ qua lỗi khi close (browser đã bị đóng bên ngoài)
    }
  }


  /**
       * Chạy riêng 1 node generate (image/video)
       */
  async runSingleNode(workflow, targetNodeId, isFromQueue = false) {
    if (this.isRunning && !isFromQueue) {
      this.queue.push({ type: 'single_node', args: [workflow, targetNodeId] });
      this.emitQueueUpdate();
      this.log(`Tiến trình khác đang chạy! Đã thêm tác vụ (Single Node) vào hàng đợi. Vị trí: ${this.queue.length}`, 'warning');
      return;
    }

    this.isRunning = true;
    this.isPaused = false;

    // --- TRACK CURRENT TASK & BẬT NÚT PAUSE/STOP MÀU ĐỎ TRONG GIAO DIỆN BUILDER ---
    this.currentTask = { type: 'single_node', args: [workflow, targetNodeId] };
    this.currentTask.progress = { total: 1, completed: 0, runningType: null };
    this.emitQueueUpdate();
    this.emit('wf-builder-status', { state: 'running' });

    const { nodes, connections } = workflow;
    const targetNode = nodes.find(n => n.id === targetNodeId);
    if (!targetNode) {
      this.log(`Không tìm thấy node: ${targetNodeId}`, 'error');
      this.isRunning = false;

      this.currentTask = null;
      this.emitQueueUpdate();
      this.emit('wfError', { error: `Không tìm thấy node ${targetNodeId}` });
      return;
    }

    this.log('═══════════════════════════════════', 'info');
    this.log(`▶ Chạy riêng node: [${targetNode.type.toUpperCase()}] ${targetNode.id}`, 'success');
    this.log('═══════════════════════════════════', 'info');

    try {
      // Đảm bảo hệ thống API đã sẵn sàng
      if (!this._apiClient) {
        const conn = await this.connect();
        if (!conn.success) {
          this.isRunning = false;
          this.currentTask = null; this.emitQueueUpdate();
          return;
        }
      }

      await this.ensureInProject();
      // Reset claim tracking cho single node run
      this.claimedHrefs = new Set();
      this.uiMutex = Promise.resolve();

      const nodeOutputs = {};
      const parentConns = connections.filter(c => c.toNode === targetNodeId);
      for (const conn of parentConns) {
        const parentNode = nodes.find(n => n.id === conn.fromNode);
        if (!parentNode) continue;

        const outState = this._wfExtractNodeState(parentNode);
        if (outState && Object.keys(outState).length > 0) {
          nodeOutputs[parentNode.id] = outState;
        }
      }

      this.currentTask.progress.runningType = targetNode.type;
      this.emitQueueUpdate();

      this.emit('wfNodeStatus', { nodeId: targetNode.id, status: 'running' });

      const inputs = this._wfCollectInputs(targetNode, connections, nodeOutputs, workflow.nodes);
      let output = {};

      switch (targetNode.type) {
        case 'prompt_list':
          const promptListStr = inputs.text || targetNode.config.text || '';
          output = { textList: promptListStr.split('\n').map(s => s.trim()).filter(Boolean) };
          this.emit('wfNodeUpdateConfig', { nodeId: targetNode.id, config: { text: promptListStr } });
          this.emit('wfNodeResult', { nodeId: targetNode.id, media: [{ type: 'text', url: promptListStr }] });
          break;
        case 'gemini_prompt':
          output = await this._wfRunGeminiNode(targetNode, inputs, connections);
          break;
        case 'generate_image':
          output = await this._wfRunGenNode(targetNode, inputs, 'image');
          break;
        case 'generate_video':
          output = await this._wfRunGenNode(targetNode, inputs, 'video');
          break;
        case 'download':
          const downloadResult = await this._wfRunDownloadNode(targetNode, inputs);
          output = { ...inputs, localPath: downloadResult };
          break;
        case 'merge_video':
          output = await this._wfRunMergeVideoNode(targetNode, inputs);
          break;
        default:
          this.log(`Node type ${targetNode.type} không hỗ trợ`, 'warning');
      }
      nodeOutputs[targetNode.id] = output;

      this.currentTask.progress.completed = 1;
      this.emitQueueUpdate();

      this.emit('wfNodeStatus', { nodeId: targetNode.id, status: 'done' });

      if (this.isRunning) {
        this.emit('wfComplete', { success: true, name: `Node ${targetNode.id}` });
        this.updateWfbStats('done');
      }

    } catch (err) {
      this.log(`Lỗi chạy node: ${err.message}`, 'error');
      this.emit('wfNodeStatus', { nodeId: targetNode.id, status: 'error' });
      this.emit('wfError', { error: err.message });
    } finally {
      this.currentTask = null;
      this.emitQueueUpdate();

      if (this.queue.length > 0) {
        this.isRunning = true;
        setTimeout(() => this.checkQueue(), 100);
      } else {
        this.isRunning = false;
        this.isPaused = false;

        this.emit('wf-builder-status', { state: 'idle', message: '✅ Hoàn tất' });
        this.emit('stopped', true);
      }
    }
  }
}

module.exports = FlowAutomation;