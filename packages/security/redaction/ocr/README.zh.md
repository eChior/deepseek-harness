# dsh-ocr — 可选的本地读图器

[English](README.md) | 中文

一个小的独立可执行文件，用 [PaddleOCR](https://github.com/sdcb/SimdPaddleOCR)
把图片里的文字读成文本，这样一张屏幕截图或一整页印刷文档，可以在被别人看到
之前先过一遍脱敏。

它**不在安装包里**。这个二进制自带模型和一份 .NET 运行时，把它发给每一台从
不读图的机器是浪费。所以它发布在内网上，需要的机器把压缩包解开到
`%USERPROFILE%\.dsh\redaction\ocr\`——插件每次读状态都会看这个目录，所以下载
并解压就是全部安装步骤。把文件放在别处的部署再填路径：

```yaml
# cordis.patch.yml, or the settings form for this plugin
- id: redaction
  config:
    ocrPath: D:\tools\dsh-ocr\dsh-ocr.exe
```

设置页会显示当前生效的是哪一个读图器、下载物该放到哪里，所以一台没有读图器的
机器是看得见的，而不是悄悄回退到别的引擎。

## 契约

本包的两个读图器用同样的方式接收图片，所以可选的那个可以直接替换：

| | |
|---|---|
| stdin | base64 编码的图片 |
| stdout | 一行一条识别结果，UTF-8 |
| exit 0 | stdout 上是识别到的文本，可能为空 |
| exit ≠ 0 | stderr 上是诊断信息；调用方报告它，并且不把图片带进会话 |

stdout 显式用 UTF-8，而不是控制台代码页：Windows 进程若按 ANSI 代码页写出，
模型认出的每个汉字都会变成乱码，任何脱敏规则都匹配不上。

唯一参数传一个文件路径时改读该文件——这是它能够手工调试的原因。

## 构建

需要 .NET 10 SDK。GPU 后端只存在于 `net10.0` 的构建里，`netstandard2.0` 那份
只有 CPU。

```powershell
# Windows x64
dotnet publish -c Release -r win-x64 --self-contained true `
  -p:PublishSingleFile=true -p:EnableCompressionInSingleFile=false `
  -p:IncludeNativeLibrariesForSelfExtract=false -o out/win-x64

# Linux arm64 (the Kylin machines)
dotnet publish -c Release -r linux-arm64 --self-contained true `
  -p:PublishSingleFile=true -p:EnableCompressionInSingleFile=false `
  -p:IncludeNativeLibrariesForSelfExtract=false -o out/linux-arm64
```

这两个开关都不能打开。`EnableCompressionInSingleFile=true` 与
`IncludeNativeLibrariesForSelfExtract=true` 一起用时，产出的可执行文件能启动、
什么都不输出、然后 exit 0——SkiaSharp 的原生库就是过不了自解压的那一部分，而
且失败是静默的。上面这套可用配置会把 `libSkiaSharp.dll` 留在可执行文件旁边，
所以发布物是一个 zip，装两个文件：

```powershell
tar -a -c -f dsh-ocr-win-x64.zip -C out/win-x64 dsh-ocr.exe libSkiaSharp.dll
tar -a -c -f dsh-ocr-linux-arm64.zip -C out/linux-arm64 dsh-ocr libSkiaSharp.so
```

## 跑在哪块设备上

默认在 CPU 上跑，机器上有一块确实更快的 GPU 时就用 GPU。这个工具读到的第一张
图会两种都测一遍——CPU 对 Vulkan——把更快的那个写进
`%TEMP%\dsh-ocr-backend.txt`，之后每次调用只加载一次模型。实测比设备名可靠：
核显经常是更慢的那一个，而且每台机器的数字都不一样。

写这份文档的那台机器（AMD Radeon 780M 核显）上 Vulkan 是 708 ms，CPU 是
422 ms，所以它选了 CPU。独显则相反，快好几倍。带 Mali GPU 的麒麟机器同样按
实测决定；没有 Vulkan 加载器的机器留在 CPU 上，stdout 上不会多一个字。

`DSH_OCR_BACKEND=cpu|vulkan|metal` 可以跳过实测。选中的后端只报到 stderr，
从不写 stdout，所以对宿主机的契约没有变化。

## 发布

二进制放到设置页让读图器去下载的那个内网 release 上：

```powershell
curl.exe -sS -X POST "http://10.151.5.175:3000/api/v1/repos/ITPublic/dsh-ocr/releases" `
  -H "Authorization: token <token>" -H "Content-Type: application/json" `
  -d '{"tag_name":"v1.0.0","name":"v1.0.0","body":"PaddleOCR reader for the redaction plugin"}'
```

然后用 `POST .../releases/<id>/assets?name=<name>` 与 `-F "attachment=@<file>"`
逐个上传文件。

## 为什么用 PaddleOCR 而不是系统引擎

系统引擎是机器上本来就有的，也仍然是默认。PaddleOCR 读印刷体工艺规程明显更
准，而这正是这个工具存在的理由：读错的公司名、被拆成两段的批号，都是没有规则
能匹配的值，然后它们就到了模型那里。

同一张 1500×900 的页面，两个引擎，同一台机器。上面的名称全部是虚构的：

| 行 | Windows 引擎 | PaddleOCR |
|---|---|---|
| 1 | `示例制药有限公司` | `示例制药有限公司` |
| 3 | `SOP 一 MFG 一2026 一014` | `SOP-MFG-2026-014` |
| 4 | `扌比号 ： 20261022` | `批号：20261022` |
| 5 | `、 制粒工序` | `一、制粒工序` |
| 7 | `投料量 25． 5kg … 搅拌 1 5 分钟` | `投料量 25.5kg，…，搅拌15分钟` |
| 9 | `± 3．0％` | `±3.0%` |
| 12 | `示例制药有阝艮公司` | `示例制药有限公司` |
| 13 | `DEV一2026 一014` | `DEV-2026-014` |

Windows 引擎把 `批` 读成 `扌比`、把 `限` 读成 `阝艮`、把每个连字符都读成 `一`、
漏掉 `一、制粒工序` 里的 `一`、把 `15` 拆成 `1 5`。PaddleOCR 全对，所以要读
文档截图就装它。

这里**没有**声称的事：对客户端自己的界面截图——图标、两字标签、状态栏——两个
引擎返回的都是同样零碎的文本，那是输入的问题，不是读图器的问题。读图器值不值
得装，看的是整页文档。
