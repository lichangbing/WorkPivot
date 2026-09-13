@echo off
wsl -d Ubuntu-24.04 -- systemctl --user start workpivot-local-worker
if errorlevel 1 goto failed
wsl -d Ubuntu-24.04 -- docker compose -p workpivot-local -f /home/lichb/workpivot-local/compose.yml --env-file /home/lichb/workpivot-local/.env up -d
if errorlevel 1 goto failed
set WORKPIVOT_SERVER_URL=http://127.0.0.1:39880
set WORKPIVOT_SMOKE=
start "WorkPivot" "%~dp0installers\portable\WorkPivot.exe" "--user-data-dir=%~dp0..\deploy\artifacts\local-client-profile"
exit /b 0
:failed
echo WorkPivot local backend could not start. Please check WSL and Docker.
pause
exit /b 1
