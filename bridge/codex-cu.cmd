@echo off
rem Runs the codex-cu bridge for Claude Code with the Node.js that ships with
rem the Codex desktop app, or Node.js from PATH if Codex's can't be found.
rem   codex-cu.cmd mcp [--check]   the codex-cu MCP server (mcp-launcher.js)
rem   codex-cu.cmd hook            the hook: app approvals, turn end (approval-hook.js)
setlocal EnableExtensions DisableDelayedExpansion

set "NODE="
set "RUNTIMES=%LOCALAPPDATA%\OpenAI\Codex\runtimes\cua_node"
if exist "%RUNTIMES%\" for /f "delims=" %%D in ('dir /b /ad /o-d "%RUNTIMES%" 2^>nul') do (
  if not defined NODE if exist "%RUNTIMES%\%%D\bin\node.exe" set "NODE=%RUNTIMES%\%%D\bin\node.exe"
)
if not defined NODE for %%N in (node.exe) do set "NODE=%%~$PATH:N"
if not defined NODE (
  echo codex-cu: Node.js not found. Install the Codex desktop app and open it once.>&2
  exit /b 2
)

if /i "%~1"=="mcp" goto mcp
if /i "%~1"=="hook" goto hook
echo usage: codex-cu.cmd mcp [--check] ^| hook>&2
exit /b 2

:mcp
"%NODE%" "%~dp0mcp-launcher.js" %2
exit /b %ERRORLEVEL%

:hook
"%NODE%" "%~dp0approval-hook.js"
exit /b %ERRORLEVEL%
