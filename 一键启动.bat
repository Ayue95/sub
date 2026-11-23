@echo off
chcp 936 >nul
cd /d "%~dp0"
title Sub 本地预览

rem ==========================================================
rem  1. 找 Python —— 跳过微软商店那个 0 字节空壳
rem ==========================================================
set "PY="

if exist "%LOCALAPPDATA%\Python\bin\python.exe" set "PY=%LOCALAPPDATA%\Python\bin\python.exe"
if not defined PY if exist "%LOCALAPPDATA%\Python\pythoncore-3.14-64\python.exe" set "PY=%LOCALAPPDATA%\Python\pythoncore-3.14-64\python.exe"
if not defined PY if exist "%LOCALAPPDATA%\Python\pythoncore-3.13-64\python.exe" set "PY=%LOCALAPPDATA%\Python\pythoncore-3.13-64\python.exe"
if not defined PY if exist "%LOCALAPPDATA%\Python\pythoncore-3.12-64\python.exe" set "PY=%LOCALAPPDATA%\Python\pythoncore-3.12-64\python.exe"
if not defined PY if exist "%LOCALAPPDATA%\Programs\Python\Python313\python.exe" set "PY=%LOCALAPPDATA%\Programs\Python\Python313\python.exe"
if not defined PY if exist "%LOCALAPPDATA%\Programs\Python\Python312\python.exe" set "PY=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
if not defined PY if exist "C:/Python313/python.exe" set "PY=C:/Python313/python.exe"
if not defined PY if exist "C:/Python312/python.exe" set "PY=C:/Python312/python.exe"

rem 还没找到就从 PATH 里找，但排除 WindowsApps 目录
if not defined PY (
  for /f "delims=" %%i in ('where python 2^>nul') do (
    if not defined PY (
      echo %%i | findstr /i "WindowsApps" >nul
      if errorlevel 1 set "PY=%%i"
    )
  )
)

if not defined PY goto nopython

rem 确认这个 Python 真的能跑
"%PY%" -c "import sys" >nul 2>nul
if errorlevel 1 goto nopython

rem ==========================================================
rem  2. 已经在跑就直接开页面
rem ==========================================================
netstat -ano | findstr "127.0.0.1:8017" | findstr "LISTENING" >nul 2>nul
if not errorlevel 1 goto already

echo.
echo   正在启动 Sub 本地服务...
echo   浏览器会自动打开，请稍等。
echo.
echo   注意：会有一个最小化的黑窗口在后台跑服务，
echo         关掉它，服务就停了。
echo.

start "" /min "%PY%" -m http.server 8017 --bind 127.0.0.1
timeout /t 2 /nobreak >nul
start "" http://127.0.0.1:8017/?t=%RANDOM%%RANDOM%
timeout /t 3 /nobreak >nul
exit

:already
echo.
echo   服务已经在运行，直接打开页面...
start "" http://127.0.0.1:8017/?t=%RANDOM%%RANDOM%
timeout /t 2 /nobreak >nul
exit

:nopython
echo.
echo   没有找到可用的 Python，无法启动本地服务。
echo   请安装 Python 3（安装时勾选 Add Python to PATH），
echo   或联系维护者处理。
echo.
pause
exit
