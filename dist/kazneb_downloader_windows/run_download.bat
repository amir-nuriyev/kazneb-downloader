@echo off
setlocal
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
    echo First-time setup is required. Running installer...
    call "%~dp0install_windows.bat" --no-pause
    if errorlevel 1 goto fail
)

if "%~1"=="" (
    echo Example:
    echo https://kazneb.kz/ru/catalogue/view/1658804
    echo.
    set /p "SOURCE=Paste KazNEB catalog/viewer URL: "
) else (
    set "SOURCE=%~1"
)

if "%SOURCE%"=="" (
    echo No URL entered.
    goto fail
)

set "OUTDIR=%~dp0output\kazneb"

echo.
echo Downloading from:
echo "%SOURCE%"
echo.

".venv\Scripts\python.exe" -u "%~dp0kazneb_to_pdf.py" "%SOURCE%" --work-dir "%OUTDIR%" --delay 0.15
if errorlevel 1 goto fail

echo.
echo Done. PDFs are under:
echo "%OUTDIR%"
echo.
pause
exit /b 0

:fail
echo.
echo Download failed.
pause
exit /b 1
