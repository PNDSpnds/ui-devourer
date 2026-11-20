@echo off
chcp 65001 >nul
setlocal EnableExtensions
title UI 吞噬者 v1.1
cd /d "%~dp0"

set "NODE_EXE="
for %%I in (node.exe) do if not defined NODE_EXE set "NODE_EXE=%%~$PATH:I"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" set "NODE_EXE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"

if not defined NODE_EXE (
  echo [错误] 未找到 Node.js 20.19+。
  echo 请从 https://nodejs.org/ 安装后重新运行此启动器。
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\vite\bin\vite.js" (
  echo [错误] 项目依赖缺失。
  echo 请在此目录打开终端并运行：npm install
  echo.
  pause
  exit /b 1
)

netstat -ano | findstr /C:":5173" | findstr /C:"LISTENING" >nul 2>nul
if not errorlevel 1 (
  echo UI 吞噬者已在 http://127.0.0.1:5173/ 运行
  if /I not "%~1"=="--no-browser" start "" "http://127.0.0.1:5173/"
  exit /b 0
)

if not exist ".tmp" mkdir ".tmp"
set "TEMP=%CD%\.tmp"
set "TMP=%CD%\.tmp"

echo.
echo   UI 吞噬者 // v1.1
echo   项目：%CD%
echo   URL:     http://127.0.0.1:5173/
echo.
echo   关闭本窗口即可停止服务器。
echo.

if /I not "%~1"=="--no-browser" (
  start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Milliseconds 1800; Start-Process 'http://127.0.0.1:5173/'"
)

"%NODE_EXE%" "node_modules\vite\bin\vite.js" --host 127.0.0.1 --port 5173 --strictPort

echo.
echo UI 吞噬者服务器已停止。
pause
