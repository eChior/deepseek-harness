@echo off
set ELECTRON_RUN_AS_NODE=1
rem The host injects the packaged node; the sibling node.exe covers a standalone launch.
set "DSH_NODE=%DSH_DESKTOP_NODE_EXECUTABLE%"
if not defined DSH_NODE set "DSH_NODE=%~dp0node.exe"
"%DSH_NODE%" --expose-internals %*
