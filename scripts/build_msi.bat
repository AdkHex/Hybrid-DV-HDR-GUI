@echo off
setlocal enabledelayedexpansion

set PROJECT_DIR=%~dp0..\
pushd "%PROJECT_DIR%"

echo === Hybrid DV HDR Tool - MSI Build Helper ===
echo.

set ROOT_BIN=%PROJECT_DIR%bin
set TAURI_BIN=%PROJECT_DIR%src-tauri\bin

if not exist "%TAURI_BIN%" (
  echo [WARN] src-tauri\bin not found.
  if exist "%ROOT_BIN%" (
    echo Copying %ROOT_BIN% -> %TAURI_BIN% ...
    xcopy /e /i /y "%ROOT_BIN%" "%TAURI_BIN%\" >nul
  ) else (
    echo [WARN] bin folder not found in project root.
  )
)

if not exist "%TAURI_BIN%" (
  echo [ERROR] src-tauri\bin is missing. Tauri expects resources relative to src-tauri.
  goto :end
)

if not exist "%TAURI_BIN%\dovi_tool.exe" (
  echo [ERROR] Missing src-tauri\bin\dovi_tool.exe
  goto :end
)
if not exist "%TAURI_BIN%\mkvmerge.exe" (
  echo [ERROR] Missing src-tauri\bin\mkvmerge.exe
  goto :end
)
if not exist "%TAURI_BIN%\mkvextract.exe" (
  echo [ERROR] Missing src-tauri\bin\mkvextract.exe
  goto :end
)
if not exist "%TAURI_BIN%\ffmpeg.exe" (
  echo [ERROR] Missing src-tauri\bin\ffmpeg.exe
  goto :end
)
echo.
echo Contents of src-tauri\bin:
dir /b "%TAURI_BIN%"
echo.

:: Download helper (PowerShell)
set PS_DOWNLOAD=powershell -NoProfile -ExecutionPolicy Bypass -Command "param([string]$url,[string]$out); (New-Object Net.WebClient).DownloadFile($url,$out)"

:: Install Node.js LTS (no Microsoft Store required)
where node >nul 2>&1
if errorlevel 1 (
  echo Installing Node.js LTS...
  set NODE_MSI=%TEMP%\\node-lts.msi
  %PS_DOWNLOAD% "https://nodejs.org/dist/latest-v20.x/node-v20.18.0-x64.msi" "%NODE_MSI%"
  msiexec /i "%NODE_MSI%" /quiet /norestart
) else (
  echo Node.js already installed.
)

:: Install Rust (rustup)
where rustc >nul 2>&1
if errorlevel 1 (
  echo Installing Rust toolchain...
  set RUSTUP=%TEMP%\\rustup-init.exe
  %PS_DOWNLOAD% "https://win.rustup.rs/x86_64" "%RUSTUP%"
  "%RUSTUP%" -y
  set PATH=%PATH%;%USERPROFILE%\\.cargo\\bin
) else (
  echo Rust already installed.
)

:: Install WiX Toolset (for MSI)
where candle >nul 2>&1
if errorlevel 1 (
  echo Installing WiX Toolset...
  set WIX_EXE=%TEMP%\\wix311.exe
  %PS_DOWNLOAD% "https://github.com/wixtoolset/wix3/releases/download/wix3112rtm/wix311.exe" "%WIX_EXE%"
  "%WIX_EXE%" /quiet /norestart
) else (
  echo WiX Toolset already installed.
)

:: Install Visual Studio Build Tools (C++ Desktop)
where cl >nul 2>&1
if errorlevel 1 (
  echo Installing Visual Studio Build Tools (C++ Desktop)...
  set VS_BT=%TEMP%\\vs_BuildTools.exe
  %PS_DOWNLOAD% "https://aka.ms/vs/17/release/vs_BuildTools.exe" "%VS_BT%"
  "%VS_BT%" --quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended
) else (
  echo Visual Studio Build Tools already installed.
)

echo.
echo Installing project dependencies...
call npm install

echo.
echo Building MSI with Tauri...
call npm run tauri:build

echo.
echo Done. MSI output should be under:
echo %PROJECT_DIR%src-tauri\target\release\bundle\msi\

:end
popd
endlocal
pause
