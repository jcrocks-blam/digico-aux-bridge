@echo off
rem Builds dist\DigicoAuxBridge\DigicoAuxBridge.exe. Needs Node.js 22 or 24 LTS and internet (fetches postject once).
rem pushd (not cd) so this also works from a network/shared folder such as \\Mac\Home\... in Parallels.
pushd "%~dp0"
if errorlevel 1 (echo Could not open the project folder. & pause & exit /b 1)
where node >nul 2>&1
if errorlevel 1 (echo Node.js was not found. Install Node 22 or 24 LTS from nodejs.org, then open a new window. & popd & pause & exit /b 1)
echo Node version:
node -v
node build\build.js --exe > build-log.txt 2>&1
set RESULT=%errorlevel%
type build-log.txt
if not "%RESULT%"=="0" (echo. & echo Build failed. The full output is in build-log.txt. & popd & pause & exit /b 1)
echo.
echo Done. Copy the dist\DigicoAuxBridge folder to the bridge PC and run install.ps1 as Administrator.
popd
pause
