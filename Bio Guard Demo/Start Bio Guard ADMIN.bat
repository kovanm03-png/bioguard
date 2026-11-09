@echo off
title Bio Guard admin
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install it from nodejs.org, then run this again.
  pause
  exit /b
)
start "" http://localhost:5180/admin
node serve.js
pause
