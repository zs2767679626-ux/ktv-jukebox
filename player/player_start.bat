@echo off
cd /d "%~dp0"
pythonw player.py >> player.log 2>&1
