@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo   UniSci AI
echo ============================================
echo.
echo 启动中... 浏览器访问 http://localhost:8080
echo 按 Ctrl+C 停止
echo.
node server/server.js
pause
