@echo off
title VEO3 AUTO-BOT (STEALTH MODE)
color 0A
cd /d "%~dp0"

echo ===================================================
echo =        VEO3 AUTO-BOT STEALTH ENGINE             =
echo ===================================================
echo.

:: 1. Set environment variables
set CAPTCHA_SOLVER_URL=http://127.0.0.1:3000/captcha

:: 2. Launch Captcha Server silently in the background
echo [INFO] 1. Starting Local Captcha Solver Server...
start "Captcha Server" /MIN node captcha_server.js

:: Give it 2 seconds to boot
timeout /t 2 /nobreak > NUL

:: 3. Run the Bot
echo [INFO] 2. Starting Brave Headless Bot...
node test_api_client.js

echo.
echo [INFO] Testing Complete.
pause
