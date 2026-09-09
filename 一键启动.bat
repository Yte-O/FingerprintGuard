@echo off
chcp 65001 >nul
title FingerprintGuard 启动器
echo ===================================================
echo             FingerprintGuard 启动器
echo ===================================================
echo.
echo 正在检查 Node.js 环境...
node -v >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 未检测到 Node.js，请先安装 Node.js!
    pause
    exit /b
)

echo 正在启动 GUI 服务...
start "" node gui_server.js
echo.
echo 服务已在后台启动！
echo 如果浏览器没有自动打开，请手动访问 http://127.0.0.1:7842
echo.
echo 按任意键退出此窗口...
pause >nul
