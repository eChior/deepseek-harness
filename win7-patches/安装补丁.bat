@echo off
chcp 936 >nul 2>nul
setlocal
cd /d "%~dp0"
title Win7 补丁安装

set "LOG=%~dp0install.log"
set "DRY=0"
if /i "%~1"=="dry" set "DRY=1"
set "FAILED=0"
set "INSTALLED_NOW=0"
set "FOUND=0"

> "%LOG%" echo ============================================================
>> "%LOG%" echo   %date% %time%
>> "%LOG%" echo   目录: %~dp0
>> "%LOG%" echo   运行者: %USERNAME%@%COMPUTERNAME%
>> "%LOG%" echo ============================================================

echo ============================================================
echo   Win7 SP1 x64 补丁安装
echo   目录: %~dp0
echo   日志: %LOG%
echo   启动: %date% %time%
echo ============================================================
echo.

net session >nul 2>&1
if errorlevel 1 goto no_admin
echo   [OK] 管理员权限

call :env_info
echo.

call :reboot_check
if "%REBOOT%"=="1" goto need_reboot_first

echo ------------------------------------------------------------
echo   补丁检测与安装
echo ------------------------------------------------------------
call :step KB2533623 "Windows6.1-KB2533623-x64.msu" "DLL 加载安全"
call :step KB2670838 "Windows6.1-KB2670838-x64.msu" "平台更新"
call :step KB2999226 "Windows6.1-KB2999226-x64.msu" "通用 C 运行库"
call :step KB4474419 "windows6.1-kb4474419-v3-x64_b5614c6cea5cb4e198717789633dca16308ef79c.msu" "SHA-2 支持"

echo.
if "%INSTALLED_NOW%"=="1" goto need_reboot

call :vc_stage
goto end

rem ============================================================
rem  子程序
rem ============================================================

:env_info
call :getreg "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion" ProductName OSNAME
call :getreg "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion" CSDVersion SPVER
call :getreg "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" PROCESSOR_ARCHITECTURE ARCH
if not defined OSNAME set "OSNAME=未知系统"
if not defined SPVER set "SPVER=无ServicePack"
if not defined ARCH set "ARCH=未知架构"
echo   系统: %OSNAME%  %SPVER%  %ARCH%
>> "%LOG%" echo   系统: %OSNAME%  %SPVER%  %ARCH%
if "%ARCH%"=="AMD64" goto :eof
echo   [警告] 当前不是 64 位系统，本目录的补丁不适用。
>> "%LOG%" echo   [警告] 非 AMD64
goto :eof

:getreg
set "%~3="
for /f "tokens=2,*" %%A in ('reg query "%~1" /v %~2 2^>nul ^| findstr /i /c:"%~2"') do set "%~3=%%B"
goto :eof

:reboot_check
set "REBOOT=0"
reg query "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending" >nul 2>&1
if errorlevel 1 goto :eof
set "REBOOT=1"
goto :eof

:checkkb
set "FOUND=0"
if exist "%SystemRoot%\servicing\Packages\*%~1*.mum" set "FOUND=1"
if "%FOUND%"=="1" goto :eof
reg query "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\%~1" >nul 2>&1
if errorlevel 1 goto :eof
set "FOUND=1"
goto :eof

:step
call :checkkb %~1
if "%FOUND%"=="1" goto step_installed
if not exist "%~dp0%~2" goto step_nofile
if "%DRY%"=="1" goto step_dry
echo   [缺失] %~1   正在安装 ...
>> "%LOG%" echo   安装 %~1 ...
wusa "%~dp0%~2" /quiet /norestart
set "RC=%errorlevel%"
>> "%LOG%" echo   %~1 退出码 %RC%
if "%RC%"=="0" goto step_ok
if "%RC%"=="3010" goto step_ok
if "%RC%"=="2359302" goto step_installed
set "FAILED=1"
echo   [失败] %~1   退出码 %RC%
echo          0x80240017 表示系统版本不匹配，不是 Win7 SP1 x64
goto :eof

:step_ok
set "INSTALLED_NOW=1"
echo   [完成] %~1   安装成功，重启后生效
goto :eof

:step_installed
echo   [已装] %~1   %~3   跳过
>> "%LOG%" echo   [已装] %~1
goto :eof

:step_nofile
echo   [错误] 目录里找不到 %~2
>> "%LOG%" echo   [错误] 缺少 %~2
set "FAILED=1"
goto :eof

:step_dry
echo   [缺失] %~1   试运行，不安装
>> "%LOG%" echo   [缺失] %~1  dry
goto :eof

:checkvc
set "VCVER="
set "VCSTATUS=missing"
for /f "tokens=2,*" %%A in ('reg query "HKLM\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" /v Version 2^>nul ^| findstr /i /c:"Version"') do set "VCVER=%%B"
if defined VCVER set "VCSTATUS=installed"
goto :eof

:vc_stage
echo ------------------------------------------------------------
echo   VC++ 2015-2022 运行库 x64
echo ------------------------------------------------------------
call :checkvc
if "%VCSTATUS%"=="installed" goto vc_installed
if not exist "%~dp0VC_redist.x64.exe" goto vc_nofile
if "%DRY%"=="1" goto vc_dry
echo   正在安装 VC_redist.x64.exe ...
>> "%LOG%" echo   安装 VC_redist.x64.exe
"%~dp0VC_redist.x64.exe" /install /quiet /norestart
set "RC=%errorlevel%"
>> "%LOG%" echo   VC 退出码 %RC%
if "%RC%"=="0" goto vc_ok
if "%RC%"=="3010" goto vc_ok
set "FAILED=1"
echo   [失败] VC++ 运行库   退出码 %RC%
goto :eof

:vc_ok
echo   [完成] VC++ 运行库
goto :eof

:vc_installed
echo   [已装] VC++ 运行库   %VCVER%   跳过
>> "%LOG%" echo   [已装] VC++ %VCVER%
goto :eof

:vc_nofile
echo   [错误] 目录里找不到 VC_redist.x64.exe
set "FAILED=1"
goto :eof

:vc_dry
echo   [缺失] VC++ 运行库   试运行，不安装
goto :eof

rem ============================================================
rem  结束
rem ============================================================

:need_reboot
echo.
echo ============================================================
echo   请重启电脑
echo ============================================================
echo   刚装的补丁需要重启后才生效（尤其是 KB4474419）。
echo   重启后再次双击本脚本，会自动继续装 VC++ 运行库。
echo.
>> "%LOG%" echo   [提示] 需要重启后继续
goto end

:need_reboot_first
echo.
echo ============================================================
echo   系统里有尚未生效的重启
echo ============================================================
echo   请先重启电脑，再运行本脚本。
echo.
goto end

:no_admin
echo.
echo ============================================================
echo   [错误] 没有管理员权限
echo ============================================================
echo   补丁必须是管理员才能装，否则会静默失败。
echo   请右键本文件 - 选择「以管理员身份运行」。
echo.
>> "%LOG%" echo   [错误] 非管理员
goto end

:end
echo.
if "%FAILED%"=="1" echo   [注意] 有失败项，日志: %LOG%
echo ============================================================
echo   结束
echo ============================================================
echo.
pause
endlocal
exit /b 0
