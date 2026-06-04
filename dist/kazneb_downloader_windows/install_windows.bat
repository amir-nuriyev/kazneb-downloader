@echo off
setlocal
cd /d "%~dp0"

set "NO_PAUSE="
if /I "%~1"=="--no-pause" set "NO_PAUSE=1"

echo KazNEB downloader setup
echo.

call :find_python
if errorlevel 1 (
    echo ERROR: Python was not found.
    echo Install Python 3.10 or newer from:
    echo https://www.python.org/downloads/windows/
    echo.
    echo During install, tick "Add python.exe to PATH".
    goto fail
)

%PY_CMD% -c "import sys; print('Using Python', sys.version); raise SystemExit(0 if sys.version_info >= (3, 10) else 1)"
if errorlevel 1 (
    echo.
    echo ERROR: Python 3.10 or newer is required.
    goto fail
)

echo.
echo Creating local virtual environment...
%PY_CMD% -m venv ".venv"
if errorlevel 1 goto fail

echo.
echo Installing Python libraries...
".venv\Scripts\python.exe" -m pip install --upgrade pip
if errorlevel 1 goto fail
".venv\Scripts\python.exe" -m pip install -r requirements.txt
if errorlevel 1 goto fail

echo.
echo Setup complete. Double-click run_download.bat to download a book.
goto done

:find_python
where py >nul 2>nul
if not errorlevel 1 (
    set "PY_CMD=py -3"
    exit /b 0
)

where python >nul 2>nul
if not errorlevel 1 (
    set "PY_CMD=python"
    exit /b 0
)

exit /b 1

:fail
echo.
echo Setup failed.
if not defined NO_PAUSE pause
exit /b 1

:done
if not defined NO_PAUSE pause
exit /b 0
