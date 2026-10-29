@echo off
rem BRICK RIOT local development: double-click to start everything.
rem Opens three windows (database, game server, web client) and the game in your browser.
rem Close those windows (or press Ctrl+C in them) to stop.
cd /d "%~dp0"
where npm >nul 2>nul || set "PATH=%LOCALAPPDATA%\Programs\node-v24.22.1-win-x64;%PATH%"
start "BRICK RIOT - database" cmd /k npm run db:start
rem Give PostgreSQL a moment to start and apply migrations.
timeout /t 10 /nobreak >nul
start "BRICK RIOT - game server" cmd /k npm run start:server
start "BRICK RIOT - web client" cmd /k npm run dev
timeout /t 8 /nobreak >nul
start "" http://localhost:5173
