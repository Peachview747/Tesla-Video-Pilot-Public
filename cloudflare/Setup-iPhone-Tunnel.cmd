@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 22 or newer from https://nodejs.org/ then run this file again.
  pause
  exit /b 1
)
call npm ci --no-audit --no-fund
if errorlevel 1 (
  echo Dependency setup failed. Check your internet connection and Node.js installation.
  pause
  exit /b 1
)
node setup-iphone.mjs
if errorlevel 1 (
  echo Setup did not finish. Read the error above before connecting your iPhone.
  pause
  exit /b 1
)
pause
