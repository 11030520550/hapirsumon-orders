@echo off
rem Local test version: the real site on a real PostgreSQL in the browser, test data only.
rem Double-click this file. Needs Node.js (https://nodejs.org) and Chrome or Edge.
cd /d "%~dp0..\.."
where node >nul 2>nul || (echo Node.js is not installed. Install it from https://nodejs.org and run this file again. & pause & exit /b 1)
start "" "http://127.0.0.1:8010/"
node testing\local-pg\start-local.mjs --port 8010
pause
