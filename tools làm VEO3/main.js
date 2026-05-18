const { app, BrowserWindow, Menu, ipcMain, dialog } = require('electron');
const path = require('path');
const { fork } = require('child_process');
const { initAutoUpdater } = require('./updater');

// Khởi động server backend (Express on port 3000)
require('./server.js');

// ─── Khởi động Captcha Solver Server (port 3456) ───────────────────────────
let captchaProcess = null;

function startCaptchaServer() {
    const captchaScript = path.join(__dirname, 'captcha_server.js');
    try {
        captchaProcess = fork(captchaScript, [], {
            env: { ...process.env, CAPTCHA_PORT: '3456' },
            silent: false, // pipe stdout/stderr to parent console
        });

        captchaProcess.on('error', (err) => {
            console.error('[Captcha Server] Failed to start:', err.message);
        });

        captchaProcess.on('exit', (code) => {
            console.log(`[Captcha Server] Exited with code ${code}`);
            captchaProcess = null;
        });

        // Set env var so token_manager can auto-detect the solver
        process.env.CAPTCHA_SOLVER_URL = 'http://127.0.0.1:3456/captcha';

        console.log('[Captcha Server] Started on port 3456');
    } catch (err) {
        console.error('[Captcha Server] Error starting:', err.message);
    }
}

function stopCaptchaServer() {
    if (captchaProcess) {
        try { captchaProcess.kill(); } catch {}
        captchaProcess = null;
        console.log('[Captcha Server] Stopped');
    }
}

startCaptchaServer();

Menu.setApplicationMenu(null);

// true khi dev (npm run electron), false khi build production
const isDev = process.env.NODE_ENV !== 'production';

let mainWindow = null;

// ─── Single Instance Lock ─────────────────────────────────────────────────────
// Chặn mở nhiều cửa sổ app cùng lúc
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
    // Instance thứ 2 → quit ngay, để instance đầu xử lý
    app.quit();
} else {
    // Instance đầu tiên — lắng nghe khi có instance thứ 2 cố mở
    app.on('second-instance', () => {
        if (!mainWindow) return;
        // Hiện dialog hỏi user
        const choice = dialog.showMessageBoxSync(mainWindow, {
            type: 'question',
            buttons: ['Mở cửa sổ hiện tại', 'Không, cảm ơn'],
            defaultId: 0,
            cancelId: 1,
            title: 'Ứng dụng đang chạy',
            message: '⚠️  Workflow AI Giá Rẻ đang chạy!',
            detail: 'Ứng dụng đã được mở rồi.\nBạn có muốn đưa cửa sổ lên trước không?',
            noLink: true,
        });

        if (choice === 0) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.show();
            mainWindow.focus();
        }
    });

    function createWindow() {
        mainWindow = new BrowserWindow({
            width: 1600,
            height: 900,
            minWidth: 1200,
            minHeight: 800,
            autoHideMenuBar: true,
            center: true,
            webPreferences: {
                nodeIntegration: true,
                contextIsolation: false,
                devTools: isDev,
            }
        });

        mainWindow.loadURL('http://localhost:3000');
        initAutoUpdater(mainWindow);

        // ─── Bảo mật: Chặn DevTools trong production ──────────────────────────
        if (!isDev) {
            mainWindow.webContents.on('before-input-event', (event, input) => {
                if (
                    input.key === 'F12' ||
                    (input.control && input.shift && ['I', 'J', 'C'].includes(input.key)) ||
                    (input.control && input.key === 'u')
                ) {
                    event.preventDefault();
                }
            });
            mainWindow.webContents.on('devtools-opened', () => {
                mainWindow.webContents.closeDevTools();
            });
        }

        mainWindow.on('closed', () => {
            mainWindow = null;
        });
    }

    app.whenReady().then(createWindow);

    app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') {
            stopCaptchaServer();
            app.quit();
        }
    });

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
}