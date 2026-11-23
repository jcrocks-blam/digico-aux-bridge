@echo off
rem Runs the bridge in this window with every OSC message printed.
rem Stop the service first (it uses the same ports):  net stop DigicoAuxBridge
cd /d "%~dp0"
DigicoAuxBridge.exe --log-osc
echo.
echo Bridge exited with code %errorlevel%
pause
