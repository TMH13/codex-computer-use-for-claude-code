@echo off
rem Installs or updates Codex computer use for Claude Code. Double-click it, or run:
rem   install.cmd             install, or update after pulling a new version
rem   install.cmd uninstall   remove it
rem It uses the Node.js that ships with the Codex desktop app, or Node.js from PATH.
rem Set CODEX_CU_NO_PAUSE=1 to skip the final pause when running it from a script.
setlocal EnableExtensions DisableDelayedExpansion

set "NODE="
set "RUNTIMES=%LOCALAPPDATA%\OpenAI\Codex\runtimes\cua_node"
if exist "%RUNTIMES%\" for /f "delims=" %%D in ('dir /b /ad /o-d "%RUNTIMES%" 2^>nul') do (
  if not defined NODE if exist "%RUNTIMES%\%%D\bin\node.exe" set "NODE=%RUNTIMES%\%%D\bin\node.exe"
)
if not defined NODE for %%N in (node.exe) do set "NODE=%%~$PATH:N"

set "RESULT=1"
if defined NODE goto run
echo Codex's Node.js wasn't found. Install the Codex desktop app, open it once
echo ^(Computer Use must be available in it^), then run this again.
goto done

:run
"%NODE%" "%~dp0installer\install.js" %*
set "RESULT=%ERRORLEVEL%"

:done
if not defined CODEX_CU_NO_PAUSE pause
exit /b %RESULT%
