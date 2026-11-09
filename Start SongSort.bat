@echo off
title SongSort
cd /d "%~dp0"
where npm >nul 2>nul
if errorlevel 1 (
  echo SongSort needs Node.js. Please install it from https://nodejs.org and run this again.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Setting up SongSort for the first time. This takes about a minute...
  call npm install
)
echo Starting SongSort. Your browser will open. Close this window to stop SongSort.
call npm start
