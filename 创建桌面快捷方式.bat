@echo off
chcp 65001 >nul
title 创建桌面快捷方式
cd /d "%~dp0"

echo 正在为 FingerprintGuard 创建桌面快捷方式...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ws = New-Object -ComObject WScript.Shell; $desktop = [Environment]::GetFolderPath('Desktop'); $s = $ws.CreateShortcut([System.IO.Path]::Combine($desktop, 'FingerprintGuard.lnk')); $target = [System.IO.Path]::Combine((Get-Location).Path, 'FingerprintGuard.exe'); $s.TargetPath = $target; $s.WorkingDirectory = (Get-Location).Path; $s.IconLocation = $target + ',0'; $s.Description = 'FingerprintGuard 客户端指纹伪装系统'; $s.Save()"

if %errorlevel% equ 0 (
    echo.
    echo ========================================================
    echo [成功] 已在您的桌面上生成「FingerprintGuard」快捷方式！
    echo 双击桌面图标即可随时一键启动。
    echo ========================================================
) else (
    echo [失败] 创建快捷方式时遇到错误。
)
echo.
pause
