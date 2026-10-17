@echo off
setlocal DisableDelayedExpansion
set "ELECTRON_RUN_AS_NODE=1"
rem The packaged layout keeps pnpm beside this directory; a development launch uses the workspace copy.
set "DSH_PNPX_ENTRY=%~dp0..\pnpm\bin\pnpx.mjs"
if not exist "%DSH_PNPX_ENTRY%" set "DSH_PNPX_ENTRY=%~dp0..\..\node_modules\pnpm\bin\pnpx.mjs"
"%DSH_DESKTOP_NODE_EXECUTABLE%" --expose-internals "%DSH_PNPX_ENTRY%" %*
exit /b %errorlevel%
