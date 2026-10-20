@echo off
setlocal DisableDelayedExpansion
rem The packaged layout keeps the primary runtime beside this directory; a development
rem launch falls back to the workspace .desktop-build runtime, then the installed
rem dsh-runtimes copy under the DSH home.
set "DSH_PYTHON=%~dp0..\primary-runtime\dependencies\python\python.exe"
if not exist "%DSH_PYTHON%" set "DSH_PYTHON=%~dp0..\..\runtime\primary-runtime\dependencies\python\python.exe"
if not exist "%DSH_PYTHON%" set "DSH_PYTHON=%DSH_HOME%\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
if not exist "%DSH_PYTHON%" (
  echo python: the bundled runtime was not found on this machine 1>&2
  exit /b 127
)
"%DSH_PYTHON%" %*
exit /b %errorlevel%
