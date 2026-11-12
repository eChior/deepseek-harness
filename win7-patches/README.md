# Windows 7 前置条件

Windows 7 版必须先装这些，再运行安装包。Windows 10 / 11 的桌面版不需要。

以管理员身份运行 `安装补丁.bat`，等它跑完：它按顺序装四个 MSU，然后装 `VC_redist.x64.exe`，
最后提示重启。`检测补丁.bat` 用来查一台机器上缺哪几个。

| 文件 | 为什么必须 |
|---|---|
| `Windows6.1-KB2533623-x64.msu` | 修复 LoadLibrary 搜索路径，新版 Chromium 缺它会拒绝启动 |
| `Windows6.1-KB2670838-x64.msu` | DirectX 11.1 / 平台更新，Chromium 的图形栈依赖它 |
| `Windows6.1-KB2999226-x64.msu` | Universal C Runtime（UCRT） |
| `windows6.1-kb4474419-v3-x64_*.msu` | SHA-2 代码签名支持，不装则现在的安装器与更新会被拒 |
| `VC_redist.x64.exe` | Visual C++ 2015-2022 运行库 |
