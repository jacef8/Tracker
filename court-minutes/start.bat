@echo off
rem Double-click launcher for Court Minutes Builder (Windows).
rem Put your API keys in a file named .env next to this script (see .env.example).
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get it from https://nodejs.org and run this again.
  pause
  exit /b 1
)

if not exist node_modules (
  echo First run - installing dependencies...
  call npm install
  if errorlevel 1 ( pause & exit /b 1 )
)

start "" http://localhost:3100
node server.js
pause
