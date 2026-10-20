@echo off
title Telegram-MiMo Watchdog
cd /d "%~dp0"
echo Starting watchdog (auto-restart bridge)...
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0watchdog.ps1"
