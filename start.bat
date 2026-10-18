@echo off
title Telegram-MiMo Bridge
cd /d "%~dp0"

set "NODE=node"
where node >nul 2>nul
if errorlevel 1 (
  if exist "%APPDATA%\Xiaomi MiMo\runtimes\bundled\52714f768b8b\node\node.exe" (
    set "NODE=%APPDATA%\Xiaomi MiMo\runtimes\bundled\52714f768b8b\node\node.exe"
  )
)

if not defined HTTPS_PROXY set "HTTPS_PROXY=http://127.0.0.1:7890"
if not defined HTTP_PROXY set "HTTP_PROXY=http://127.0.0.1:7890"
if not defined NODE_USE_ENV_PROXY set "NODE_USE_ENV_PROXY=1"

echo Starting Telegram-MiMo Bridge...
echo Node: %NODE%
echo Proxy: %HTTPS_PROXY%
echo.

if not exist "config.json" (
  if exist "config.example.json" (
    echo Copy config.example.json to config.json, then fill in bot_token.
  ) else (
    echo config.json not found.
  )
  pause
  exit /b 1
)

"%NODE%" "%~dp0bridge.js"
echo.
echo Bridge exited with code %ERRORLEVEL%.
pause
