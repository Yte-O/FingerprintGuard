@echo off
chcp 65001 >nul
title FingerprintGuard 启动器

echo ========================================================
echo          FingerprintGuard 客户端指纹伪装系统
echo ========================================================
echo.

cd /d "%~dp0"

:: 检查是否存在 FingerprintGuard.exe 原生启动器
if exist "FingerprintGuard.exe" (
    echo [OK] 正在启动后台服务与托盘程序...
    start "" "FingerprintGuard.exe"
    echo.
    echo 启动完成！控制面板将在浏览器中自动打开。
    echo 提示：您可以随时在任务栏右下角托盘图标中管理服务。
    timeout /t 3 >nul
    exit /b 0
)

:: 检查 Node.js 环境
where node >nul 2>nul
if %errorlevel% neq 0 (
    if exist "D:\a\nodejs\node.exe" (
        set "NODE_BIN=D:\a\nodejs\node.exe"
    ) else if exist "C:\Program Files\nodejs\node.exe" (
        set "NODE_BIN=C:\Program Files\nodejs\node.exe"
    ) else (
        echo [错误] 未在系统中检测到 Node.js！
        echo 请先安装 Node.js 18+ (https://nodejs.org/)
        echo.
        pause
        exit /b 1
    )
) else (
    set "NODE_BIN=node"
)

:: 检查是否存在依赖
if not exist "node_modules" (
    echo [提示] 检测到首次运行，正在安装依赖包...
    call npm install --no-audit --no-fund
    if %errorlevel% neq 0 (
        echo [警告] 依赖安装失败，尝试直接启动...
    )
)

echo [OK] 正在启动 GUI 控制面板服务...
"%NODE_BIN%" gui_server.js

pause
