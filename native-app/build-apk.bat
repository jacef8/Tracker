@echo off
REM ============================================================
REM  GroundLink - build the Android APK on this PC.
REM  Double-click this file (or run it from PowerShell).
REM  Requires: Android SDK installed + Node in PATH (already set up).
REM  When done, the APK is copied to:  Tracker\GroundLink-latest.apk
REM ============================================================
setlocal
cd /d "%~dp0"

echo.
echo === [1/2] Syncing Capacitor (native config + plugins) ===
call npx cap sync android
if errorlevel 1 goto :failed

echo.
echo === [2/2] Building debug APK (this can take a couple minutes) ===
cd android
call gradlew.bat assembleDebug
if errorlevel 1 goto :failed

set "APK=%~dp0android\app\build\outputs\apk\debug\app-debug.apk"
if not exist "%APK%" goto :failed

copy /Y "%APK%" "%~dp0..\GroundLink-latest.apk" >nul

echo.
echo ============================================================
echo  BUILD SUCCESSFUL
echo  APK ready at:  %~dp0..\GroundLink-latest.apk
echo  (also at: %APK%)
echo  Move GroundLink-latest.apk to your phone and install it.
echo ============================================================
echo.
pause
exit /b 0

:failed
echo.
echo ************************************************************
echo  BUILD FAILED - scroll up to see the error.
echo  Copy the red/error lines and send them to Claude to fix.
echo ************************************************************
echo.
pause
exit /b 1
