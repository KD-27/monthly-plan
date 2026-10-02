@echo off
setlocal
title Monthly Plan

rem ============================================================
rem  Starts the small local server that owns data\data.json, then
rem  opens the app.  Your log lives in the data folder beside this file,
rem  so it is simply there every time you open it -- nothing to
rem  import, ever.  The server stops by itself when you close the
rem  window, and this launcher exits straight away.
rem ============================================================

set "APPDIR=%~dp0"
cd /d "%APPDIR%"
set "PORT=8731"
set "PAGE=http://127.0.0.1:%PORT%/index.html"

rem --- find a windowless Python to run the server with ---
set "PY="
if exist "%SystemRoot%\pyw.exe" set "PY=%SystemRoot%\pyw.exe -3"
if not defined PY (
  for %%P in (
    "%LocalAppData%\Programs\Python\Python312\pythonw.exe"
    "%ProgramFiles%\Python39\pythonw.exe"
    "C:\Python314\pythonw.exe"
  ) do if not defined PY if exist %%P set "PY=%%~P"
)
if not defined PY (
  where pythonw >nul 2>&1 && set "PY=pythonw"
)

if defined PY (
  start "" %PY% "%APPDIR%server.py"

  rem Give it a moment to claim the port, so the first load finds the file.
  powershell -NoProfile -Command "for($i=0;$i -lt 60;$i++){try{(New-Object Net.Sockets.TcpClient('127.0.0.1',%PORT%)).Close();exit 0}catch{Start-Sleep -Milliseconds 100}};exit 1" >nul 2>&1
  if errorlevel 1 (
    echo The local server did not start -- opening without file saving.
    set "PAGE=file:///%APPDIR:\=/%index.html"
  )
) else (
  echo Python was not found, so data.json cannot be used.
  echo Install Python from python.org to get automatic local saving.
  timeout /t 4 >nul
  set "PAGE=file:///%APPDIR:\=/%index.html"
)

rem --- prefer a clean app window in Chrome, then Edge ---
set "BROWSER="
for %%P in (
  "%ProgramFiles%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
  "%LocalAppData%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
  "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
) do if not defined BROWSER if exist %%P set "BROWSER=%%~P"

rem A browser profile of its own, kept off OneDrive.  Clearing your normal
rem browsing data can then never touch the app -- which is what emptied it.
set "PROFILE=%LocalAppData%\MonthlyPlan\chrome"
if not exist "%PROFILE%" mkdir "%PROFILE%" >nul 2>&1

rem Opens full screen -- no title bar, no taskbar.  F11 toggles back to a window.
if defined BROWSER (
  start "" "%BROWSER%" --app="%PAGE%" --start-fullscreen --window-size=1080,900 --user-data-dir="%PROFILE%" --no-first-run --no-default-browser-check
) else (
  start "" "%PAGE%"
)

endlocal
