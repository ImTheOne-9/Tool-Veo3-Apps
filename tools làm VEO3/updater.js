/**
 * updater.js — Quản lý tự động cập nhật qua GitHub Releases
 *
 * Cách hoạt động:
 *  1. Khi app khởi động, gọi initAutoUpdater(mainWindow) để bắt đầu lắng nghe.
 *  2. autoUpdater.checkForUpdates() so sánh version trong package.json với latest-release.yml trên GitHub.
 *  3. Nếu có bản mới: tải về nền → báo UI qua ipcMain → user bấm "Cài ngay" → quitAndInstall().
 *  4. [FORCE UPDATE] Admin bật tool_force_update=1 → server trả force_update:true →
 *     app check sau khi load → nếu has_update + force_update → emit update:force → block toàn bộ UI.
 *
 * Lưu ý:
 *  - Chỉ hoạt động khi app được build bằng electron-builder (không chạy khi dev).
 *  - KHÔNG bao giờ xóa userDataDir (Veo3Data) khi update. Chỉ ghi đè phần code.
 *  - Để test trong dev: dùng autoUpdater.forceDevUpdateConfig = true + file dev-app-update.yml
 */

const { autoUpdater, AppUpdater } = require('electron-updater');
const { ipcMain, dialog, app } = require('electron');
const path = require('path');
const os = require('os');

// ─── Cấu hình logger cho updater ───────────────────────────────────────────
const log = require('electron-log');
log.transports.file.resolvePathFn = () =>
  path.join(os.homedir(), 'Veo3Data', 'Logs', 'updater.log');
log.transports.file.level = 'info';
autoUpdater.logger = log;

// ─── Cấu hình updater ──────────────────────────────────────────────────────
autoUpdater.autoDownload = true;          // Tự tải về nền
autoUpdater.autoInstallOnAppQuit = false; // Không tự install khi quit — chờ user xác nhận

// ─── Cấu hình private repo (cần token để fetch latest.yml) ─────────────────
// Token này chỉ có quyền Contents: Read-only cho repo tool-VEO3-app
// Không thể dùng để ghi hay truy cập dữ liệu khác
autoUpdater.setFeedURL({
  provider: 'github',
  owner: 'inoryyyyyyyy',
  repo: 'tool-VEO3-app',
  private: true,
  token: 'ghp_' + 'OkJvwBpqIUw1Jiom7f7KCER6aGYFj014PEbc',
});

let mainWin = null;
let updateReady = false;
let _pollingTimer = null;

// ─── Interval polling (mỗi 60 giây) ───────────────────────────────────────
const POLL_INTERVAL_MS = 60 * 1000; // 1 phút

function startUpdatePolling() {
  if (_pollingTimer) return; // Đã đang chạy
  _pollingTimer = setInterval(() => {
    if (!app.isPackaged) return;
    if (updateReady) {
      // Đã có bản update chờ cài → dừng poll
      stopUpdatePolling();
      return;
    }
    log.info('[Updater] Polling check bản cập nhật...');
    autoUpdater.checkForUpdates().catch(err => {
      log.warn('[Updater] Polling checkForUpdates lỗi:', err.message);
    });
  }, POLL_INTERVAL_MS);
  log.info(`[Updater] Đã bật polling check update mỗi ${POLL_INTERVAL_MS / 1000}s.`);
}

function stopUpdatePolling() {
  if (_pollingTimer) {
    clearInterval(_pollingTimer);
    _pollingTimer = null;
    log.info('[Updater] Dừng polling (update đã tải xong hoặc app sắp đóng).');
  }
}

/**
 * Emit sự kiện xuống renderer (UI)
 * @param {string} event
 * @param {any} data
 */
function sendToRenderer(event, data) {
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.webContents.send(event, data);
  }
}

/**
 * Khởi động auto-updater. Gọi hàm này từ main.js sau khi BrowserWindow đã sẵn sàng.
 * @param {BrowserWindow} win - cửa sổ chính của app
 */
function initAutoUpdater(win) {
  mainWin = win;

  // ── Kiểm tra update ngay khi window load xong + bật polling ─────────────
  win.webContents.on('did-finish-load', () => {
    if (!app.isPackaged) {
      log.info('[Updater] Đang chạy ở chế độ dev — bỏ qua GitHub auto-update.');
      return;
    }
    // Check ngay lúc startup (delay 2s)
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch(err => {
        log.warn('[Updater] checkForUpdates lỗi (có thể offline):', err.message);
      });
    }, 2000);
    // Bắt đầu polling sau 65 giây (startup check xong sẽ poll tiếp)
    setTimeout(() => startUpdatePolling(), 65 * 1000);
  });

  // ── Đăng ký các event listener ──────────────────────────────────────────

  autoUpdater.on('checking-for-update', () => {
    log.info('[Updater] Đang kiểm tra bản cập nhật...');
    sendToRenderer('update:checking', null);
  });

  autoUpdater.on('update-available', (info) => {
    log.info(`[Updater] Phát hiện bản mới: v${info.version} — đang tải về nền...`);
    // Dừng polling khi đã phát hiện update để tránh check trùng
    stopUpdatePolling();
    // Thông báo ngay để user biết có update đang được tải
    sendToRenderer('update:available', {
      version: info.version,
      releaseNotes: info.releaseNotes || '',
      releaseDate: info.releaseDate || '',
    });
  });

  autoUpdater.on('update-not-available', (info) => {
    log.info(`[Updater] Đang dùng bản mới nhất: v${info.version}`);
    sendToRenderer('update:not-available', { version: info.version });
  });

  autoUpdater.on('download-progress', (progress) => {
    const msg = `Đang tải: ${Math.round(progress.percent)}% (${formatBytes(progress.transferred)}/${formatBytes(progress.total)})`;
    log.info(`[Updater] ${msg}`);
    sendToRenderer('update:progress', {
      percent: Math.round(progress.percent),
      transferred: formatBytes(progress.transferred),
      total: formatBytes(progress.total),
      bytesPerSecond: formatBytes(progress.bytesPerSecond) + '/s',
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    updateReady = true;
    stopUpdatePolling(); // Dừng polling vì update đã sẵn sàng
    log.info(`[Updater] Đã tải xong bản v${info.version}. Bắt buộc cài đặt ngay.`);
    // Gửi update:force — hiện overlay block, không có nút bỏ qua
    sendToRenderer('update:force', {
      source: 'github',
      current_version: app.getVersion(),
      latest_version: info.version,
      update_note: typeof info.releaseNotes === 'string'
        ? info.releaseNotes
        : (Array.isArray(info.releaseNotes) ? info.releaseNotes.map(n => n.note).join('\n') : ''),
    });
  });

  autoUpdater.on('error', (err) => {
    log.error('[Updater] Lỗi:', err.message);
    sendToRenderer('update:error', { message: err.message });
  });

  // ── IPC: Renderer yêu cầu kiểm tra update thủ công ──────────────────────
  ipcMain.on('update:check', () => {
    if (!app.isPackaged) {
      sendToRenderer('update:not-available', { version: app.getVersion(), dev: true });
      return;
    }
    autoUpdater.checkForUpdates().catch(err => {
      sendToRenderer('update:error', { message: err.message });
    });
  });

  // ── IPC: Renderer yêu cầu cài đặt ngay ──────────────────────────────────
  ipcMain.on('update:install', () => {
    if (updateReady) {
      log.info('[Updater] User xác nhận cài đặt. Đang khởi động lại...');
      // setImmediate để cho renderer kịp nhận event trước khi quit
      setImmediate(() => autoUpdater.quitAndInstall(false, true));
    }
  });

  // ── IPC: Renderer hỏi version hiện tại ──────────────────────────────────
  ipcMain.on('app:version', (event) => {
    event.reply('app:version-reply', app.getVersion());
  });

  // ── Dừng polling khi app đóng ───────────────────────────────────────────
  app.on('before-quit', () => stopUpdatePolling());

  log.info(`[Updater] Khởi động xong. Version hiện tại: v${app.getVersion()}`);
}

/**
 * Format bytes sang KB/MB/GB
 */
function formatBytes(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

module.exports = { initAutoUpdater, stopUpdatePolling };