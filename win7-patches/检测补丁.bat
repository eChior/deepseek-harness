@echo off
chcp 936 >nul 2>nul
setlocal
cd /d "%~dp0"
title Win7 补丁检测

set "OUT=%~dp0检测结果_%COMPUTERNAME%.txt"
set "MISS=0"
set "FOUND=0"

> "%OUT%" echo ============================================================
>> "%OUT%" echo   补丁检测结果
>> "%OUT%" echo   时间: %date% %time%
>> "%OUT%" echo   计算机: %COMPUTERNAME%   用户: %USERNAME%
>> "%OUT%" echo ============================================================

echo ============================================================
echo   Win7 补丁检测
echo   计算机: %COMPUTERNAME%
echo ============================================================
echo.

call :env_info
echo.

net session >nul 2>&1
if errorlevel 1 goto not_admin
echo   [OK] 管理员权限，检测结果最准确
goto run

:not_admin
echo   [提示] 非管理员运行：个别项目可能误报「未安装」
echo          建议右键 - 以管理员身份运行
echo.

:run
echo ------------------------------------------------------------
echo   补丁状态
echo ------------------------------------------------------------
call :show "KB2533623" "DLL 加载安全更新"
call :show "KB2670838" "平台更新 Direct2D/DirectWrite"
call :show "KB2999226" "通用 C 运行库 UCRT"
call :show "KB4474419" "SHA-2 代码签名支持"
call :showvc

echo.
echo ------------------------------------------------------------
if "%MISS%"=="0" goto all_ok
echo   共缺 %MISS% 项，请运行「安装补丁.bat」
>> "%OUT%" echo   共缺 %MISS% 项
goto done

:all_ok
echo   全部已安装，无需处理
>> "%OUT%" echo   全部已安装

:done
echo ------------------------------------------------------------
echo.
echo   结果已保存到: %OUT%
echo.
>> "%OUT%" echo ============================================================
pause
endlocal
exit /b 0

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
>> "%OUT%" echo   系统: %OSNAME%  %SPVER%  %ARCH%
goto :eof

:getreg
set "%~3="
for /f "tokens=2,*" %%A in ('reg query "%~1" /v %~2 2^>nul ^| findstr /i /c:"%~2"') do set "%~3=%%B"
goto :eof

:checkkb
set "FOUND=0"
if exist "%SystemRoot%\servicing\Packages\*%~1*.mum" set "FOUND=1"
if "%FOUND%"=="1" goto :eof
reg query "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\%~1" >nul 2>&1
if errorlevel 1 goto :eof
set "FOUND=1"
goto :eof

:checkvc
set "VCVER="
set "VCSTATUS=missing"
for /f "tokens=2,*" %%A in ('reg query "HKLM\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" /v Version 2^>nul ^| findstr /i /c:"Version"') do set "VCVER=%%B"
if defined VCVER set "VCSTATUS=installed"
goto :eof

:show
call :checkkb %~1
if "%FOUND%"=="1" goto show_yes
echo   [未安装] %~1   %~2
>> "%OUT%" echo   [未安装] %~1   %~2
set /a MISS+=1
goto :eof

:show_yes
echo   [已安装] %~1   %~2
>> "%OUT%" echo   [已安装] %~1   %~2
goto :eof

:showvc
call :checkvc
if "%VCSTATUS%"=="installed" goto showvc_yes
echo   [未安装] VC++ 2015-2022 x64
>> "%OUT%" echo   [未安装] VC++ 2015-2022 x64
set /a MISS+=1
goto :eof

:showvc_yes
echo   [已安装] VC++ 2015-2022 x64   版本 %VCVER%
>> "%OUT%" echo   [已安装] VC++ 2015-2022 x64   版本 %VCVER%
goto :eof
