# Windows 7 prerequisites

Install these before running the Windows 7 build. The build needs them; the
desktop build for Windows 10 and 11 does not.

Run `安装补丁.bat` as an administrator and let it finish — it applies the four
MSU packages in order, then installs `VC_redist.x64.exe`. `检测补丁.bat` reports
which of them are missing on a machine.

| File | Why it is needed |
|---|---|
| `Windows6.1-KB2533623-x64.msu` | LoadLibrary search-order hardening; newer Chromium refuses to start without it |
| `Windows6.1-KB2670838-x64.msu` | DirectX 11.1 / platform update, the graphics stack Chromium links against |
| `Windows6.1-KB2999226-x64.msu` | Universal C runtime (UCRT) |
| `windows6.1-kb4474419-v3-x64_*.msu` | SHA-2 code-signing support, without it current installers and updates are rejected |
| `VC_redist.x64.exe` | Visual C++ 2015-2022 runtime |
