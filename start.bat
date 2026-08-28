@echo off
title DROP
echo Menjalankan DROP...
echo.
echo Browser akan terbuka otomatis di http://127.0.0.1:3001
echo Tutup jendela ini (atau Ctrl+C) untuk berhenti.
echo.
start "" http://127.0.0.1:3001
node dist\server.js
pause
