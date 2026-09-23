@echo off
REM ============================================================
REM  Gimbal Cam - build the Android APK on this PC.
REM  Double-click this file. Requires the Android SDK (same setup as GroundLink).
REM  When done, the APK is copied to:  Tracker\GimbalCam-latest.apk
REM ============================================================
setlocal
cd /d "%~dp0"

REM Reuse GroundLink's SDK location if this project doesn't have its own yet.
if not exist local.properties if exist ..\..\native-app\android\local.properties (
  copy /Y ..\..\native-app\android\local.properties local.properties >nul
)

echo.
echo === Building Gimbal Cam APK (the first build downloads Gradle and takes a few minutes) ===
call gradlew.bat assembleDebug
if errorlevel 1 goto :failed

set "APK=%~dp0app\build\outputs\apk\debug\app-debug.apk"
if not exist "%APK%" goto :failed
copy /Y "%APK%" "%~dp0..\..\GimbalCam-latest.apk" >nul

echo.
echo ============================================================
echo  BUILD SUCCESSFUL
echo  APK ready at:  %~dp0..\..\GimbalCam-latest.apk
echo  Move GimbalCam-latest.apk to your phone and install it.
echo ============================================================
echo.
pause
exit /b 0

:failed
echo.
echo ************************************************************
echo  BUILD FAILED - scroll up for the first error.
echo ************************************************************
pause
exit /b 1
