@echo off
:: Cố định thư mục cho Môi trường Dev
cd /d "%~dp0"

title KHOI DONG VEO3 TOOL
color 0B
echo ===================================================
echo =        VEO3 WORKFLOW AI - KHOI DONG BAN         =
echo ===================================================

:: 1. Kiem tra xem Nodejs da cai chua
node -v >nul 2>&1
if %errorlevel% neq 0 (
    color 0C
    echo [LOI] May tinh cua ban chua cai dat Node.js!
    echo Vui long tai Node.js phien ban LTS tai: https://nodejs.org
    echo Va cai dat roi moi chay lai File nay.
    pause
    exit
)

:: 2. Kiem tra xem da chay npm install chua (check thu muc node_modules)
if not exist "node_modules\" (
    echo [INFO] Lan dau mo Tool. Dang tai cac thu vien he thong ^(Khoang 1-2 phut^)...
    npm install
    echo [INFO] Da cai dat xong thu vien!
)

:: 3. Mo Google Chrome che do Remote Debugging (Bat buoc de dieu khien tren Flow)
echo [INFO] Dang bat Google Chrome An danh de Tool dieu khien...
start chrome --remote-debugging-port=9222 --user-data-dir="%~dp0\ChromeProfile"
timeout /t 2 /nobreak > NUL

:: 4. Chay Server Tool
echo [INFO] Dang chay VEO3 Local Server...
node server.js
pause
