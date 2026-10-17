@echo off
setlocal DisableDelayedExpansion
set "ELECTRON_RUN_AS_NODE=1"
rem The packaged layout keeps pnpm beside this directory; a development launch uses the workspace copy.
set "DSH_PNPM_ENTRY=%~dp0..\pnpm\bin\pnpm.mjs"
if not exist "%DSH_PNPM_ENTRY%" set "DSH_PNPM_ENTRY=%~dp0..\..\node_modules\pnpm\bin\pnpm.mjs"
"%DSH_DESKTOP_NODE_EXECUTABLE%" --expose-internals "%DSH_PNPM_ENTRY%" %*
exit /b %errorlevel%
