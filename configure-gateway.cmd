@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0configure-gateway.ps1" %*
