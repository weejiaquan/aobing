@echo off
echo Starting local server at http://localhost:8080
echo Press Ctrl+C to stop.
cd /d "%~dp0discord"
python -m http.server 8080
pause
