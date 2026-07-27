@echo off
REM ============================================================
REM  GroundLink - build the SIGNED RELEASE bundle for Play Store.
REM  Double-click this file (or run it from PowerShell).
REM  Requires: Android SDK installed + Node in PATH (already set up),
REM            plus android\keystore.properties filled in (see below).
REM
REM  When done, both artifacts are copied to the repo root:
REM      GroundLink-release.aab   <- upload THIS one to Play Console
REM      GroundLink-release.apk   <- same build as an installable APK
REM  Both are gitignored, so they never get committed by accident.
REM
REM  This is the RELEASE counterpart to build-apk.bat (which makes the
REM  debug/sideload APK). Release builds are signed with the real upload
REM  key, whose passwords live in android\keystore.properties - a local,
REM  gitignored file. Nothing here ever prompts you: if that file is
REM  filled in, the whole build runs unattended.
REM ============================================================
setlocal
cd /d "%~dp0"

set "KP=android\keystore.properties"

echo.
echo === [1/4] Checking signing credentials ===

if not exist "%KP%" (
    echo   MISSING: native-app\%KP%
    echo.
    echo   This file holds the upload-key passwords. It is gitignored on
    echo   purpose, so a fresh clone will not have it. Copy it over from a
    echo   machine that has it, or start from keystore.properties.example
    echo   and fill in all four values.
    goto :failed
)

REM Verify each key has a non-empty value. Output is swallowed so the
REM passwords are never echoed to the console or a build log.
for %%K in (uploadStoreFile uploadStorePassword uploadKeyAlias uploadKeyPassword) do (
    findstr /R /C:"^%%K=." "%KP%" >nul 2>&1
    if errorlevel 1 (
        echo   %KP% is missing a value for: %%K
        echo   All four of uploadStoreFile / uploadStorePassword /
        echo   uploadKeyAlias / uploadKeyPassword must be set, or Gradle
        echo   will fail to sign the release build.
        goto :failed
    )
)

REM uploadStoreFile is just a filename, not a secret - safe to read and show.
set "STOREFILE="
for /f "tokens=1,* delims==" %%a in ('findstr /R /C:"^uploadStoreFile=" "%KP%"') do set "STOREFILE=%%b"
if not exist "android\app\%STOREFILE%" (
    echo   keystore.properties points at "%STOREFILE%", but
    echo   native-app\android\app\%STOREFILE% does not exist.
    goto :failed
)
echo   OK - signing with: %STOREFILE%

REM Surface the version being built. Play rejects an upload whose
REM versionCode matches one already published, so this is worth seeing.
set "VC="
set "VN="
for /f "tokens=2" %%v in ('findstr /R /C:"^ *versionCode " "android\app\build.gradle"') do set "VC=%%v"
for /f "tokens=2" %%v in ('findstr /R /C:"^ *versionName " "android\app\build.gradle"') do set "VN=%%v"
echo   Building versionCode %VC%, versionName %VN%

echo.
echo === [2/4] Syncing Capacitor (native config + plugins) ===
call npx cap sync android
if errorlevel 1 goto :failed

echo.
echo === [3/4] Building signed AAB + APK (this can take a few minutes) ===
REM Gradle needs the android dir as the working directory (to find
REM settings.gradle), but gradlew.bat is invoked by full path: some shells run
REM with NoDefaultCurrentDirectoryInExePath=1, which stops cmd resolving a bare
REM "gradlew.bat" out of the current directory.
cd android
call "%~dp0android\gradlew.bat" bundleRelease assembleRelease
if errorlevel 1 goto :failed
cd ..

echo.
echo === [4/4] Collecting artifacts ===
set "AAB=%~dp0android\app\build\outputs\bundle\release\app-release.aab"
set "APK=%~dp0android\app\build\outputs\apk\release\app-release.apk"
if not exist "%AAB%" goto :failed
if not exist "%APK%" goto :failed

copy /Y "%AAB%" "%~dp0..\GroundLink-release.aab" >nul
copy /Y "%APK%" "%~dp0..\GroundLink-release.apk" >nul

echo.
echo ============================================================
echo  RELEASE BUILD SUCCESSFUL  (versionCode %VC%, versionName %VN%)
echo.
echo  Play Store upload:  %~dp0..\GroundLink-release.aab
echo  Installable APK:    %~dp0..\GroundLink-release.apk
echo.
echo  Reminder: Play rejects a versionCode it has already seen. If this
echo  upload is rejected as a duplicate, bump versionCode in
echo  native-app\android\app\build.gradle and run this again.
echo ============================================================
echo.
pause
exit /b 0

:failed
echo.
echo ************************************************************
echo  RELEASE BUILD FAILED - scroll up to see the error.
echo  Copy the red/error lines and send them to Claude to fix.
echo ************************************************************
echo.
pause
exit /b 1
