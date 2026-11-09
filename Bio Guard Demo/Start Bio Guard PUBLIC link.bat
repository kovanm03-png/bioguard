@echo off
title Bio Guard PUBLIC link
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install it from nodejs.org, then run this again.
  pause
  exit /b
)
where cloudflared >nul 2>nul
if errorlevel 1 (
  echo.
  echo One-time setup: install the free Cloudflare tunnel tool.
  echo Open a new Command Prompt and run:   winget install --id Cloudflare.cloudflared
  echo Then close it, and double-click this file again.
  echo.
  pause
  exit /b
)
start "Bio Guard server (keep open)" cmd /k node serve.js
timeout /t 3 >nul
echo.
echo Look below for a link that ends in  trycloudflare.com  - that is the PUBLIC link.
echo Send it to the customer. Add /admin to the end of it for the admin login.
echo Keep BOTH black windows open while the customer is looking.
echo.
cloudflared tunnel --url http://localhost:5180
pause