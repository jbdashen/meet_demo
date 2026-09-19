@echo off
REM 一键启动: 信令服务器(3001) + Electron 客户端
cd /d P:\meet_demo
echo [1/2] 启动信令服务器...
start "meet_signaling" node server\index.js
REM 等 1.5s 让信令服务起来
timeout /t 2 /nobreak >nul
echo [2/2] 启动 Electron 客户端...
node_modules\electron\dist\electron.exe P:\meet_demo
