@echo off
title Server Panel
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 or newer is required. Install it from https://nodejs.org and run this file again.
  pause
  exit /b 1
)
node server\launch.js
echo.
echo The panel has stopped.
pause
