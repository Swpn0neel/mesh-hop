@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 or newer is required.
  echo Install it from https://nodejs.org/ and run this file again.
  pause
  exit /b 1
)
if not exist "node_modules\ws\package.json" (
  echo Installing the two small runtime dependencies...
  call npm install
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
echo Finding and testing public US exits. This normally takes 15-40 seconds...
call npm run public
if errorlevel 1 pause
