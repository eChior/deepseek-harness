@echo off
setlocal DisableDelayedExpansion
set ELECTRON_RUN_AS_NODE=1
rem The packaged layout keeps pnpm beside this directory; a development launch uses the workspace copy.
set "DSH_ENTRY=%~dp0..\pnpm\bin\pnpm.mjs"
if not exist "%DSH_ENTRY%" set "DSH_ENTRY=%~dp0..\..\node_modules\pnpm\bin\pnpm.mjs"
rem The host injects the packaged node; the sibling node.exe covers a standalone launch.
set "DSH_NODE=%DSH_DESKTOP_NODE_EXECUTABLE%"
if not defined DSH_NODE set "DSH_NODE=%~dp0node.exe"
"%DSH_NODE%" --expose-internals "%DSH_ENTRY%" %*
exit /b %errorlevel%
