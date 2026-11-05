# dsh-ocr — the optional local image reader

English | [中文](README.zh.md)

A small standalone executable that reads the text out of an image with
[PaddleOCR](https://github.com/sdcb/SimdPaddleOCR), so a screenshot of a screen
or a printed page can be redacted before anything else sees it.

It is **not** part of the installer. The binary carries a model and a .NET
runtime of its own, so shipping it to every machine that never reads an image
would be waste. It is published on the intranet instead, and a machine that
wants it unpacks the archive into `%USERPROFILE%\.dsh\redaction\ocr\` — the
provider looks there on every status read, so downloading and unpacking is the
whole installation. A deployment that keeps the file elsewhere sets the path:

```yaml
# cordis.patch.yml, or the settings form for this plugin
- id: redaction
  config:
    ocrPath: D:\tools\dsh-ocr\dsh-ocr.exe
```

The settings page shows which reader is in force and where a download belongs,
so a machine that has none is visible rather than silently falling back.

## The contract

Both readers of this package take the image the same way, so the optional one is
a drop-in replacement:

| | |
|---|---|
| stdin | the image as base64 |
| stdout | one recognized line per line, UTF-8 |
| exit 0 | the text on stdout, possibly empty |
| exit ≠ 0 | a diagnostic on stderr; the caller reports it and keeps the image out of the session |

stdout is UTF-8 explicitly, not the console's code page: a Windows process that
writes through the ANSI page turns every recognized Chinese character into
garbage that no redaction rule matches.

Passing a file path as the only argument reads that file instead, which is what
makes the binary debuggable by hand.

## Building it

Needs the .NET 10 SDK. The GPU backends only exist in the `net10.0` build; the
`netstandard2.0` one is CPU only.

```powershell
# Windows x64
dotnet publish -c Release -r win-x64 --self-contained true `
  -p:PublishSingleFile=true -p:EnableCompressionInSingleFile=true `
  -p:IncludeNativeLibrariesForSelfExtract=false `
  -p:PublishTrimmed=true -p:TrimMode=partial -o out/win-x64

# Linux arm64 (the Kylin machines)
dotnet publish -c Release -r linux-arm64 --self-contained true `
  -p:PublishSingleFile=true -p:EnableCompressionInSingleFile=true `
  -p:IncludeNativeLibrariesForSelfExtract=false `
  -p:PublishTrimmed=true -p:TrimMode=partial -o out/linux-arm64
```

Do not turn `IncludeNativeLibrariesForSelfExtract` on. Together with compression
it produces an executable that starts, prints nothing and exits 0 — SkiaSharp's
native library is the part that does not survive the self-extract, and the failure
is silent. Keeping the library beside the executable makes compression safe, and
trimming then takes the 84 MB untrimmed bundle down to 19 MB; the trimmed reader
was run against a real screenshot before it shipped, and `TrimMode=partial` is
what keeps PaddleOCR's reflection paths intact. A release ships a zip holding both
files:

```powershell
tar -a -c -f dsh-ocr-win-x64.zip -C out/win-x64 dsh-ocr.exe libSkiaSharp.dll
tar -a -c -f dsh-ocr-linux-arm64.zip -C out/linux-arm64 dsh-ocr libSkiaSharp.so
```

## Which device it runs on

The kernels run on the CPU by default and on a GPU when the machine has one that
is actually faster. The first image this tool ever reads is measured both ways —
CPU against Vulkan — the winner is written to `%TEMP%\dsh-ocr-backend.txt`, and
every later call loads one model only. A measurement beats a device name: an
integrated GPU is often the slower choice, and the numbers differ per machine.

On the machine this was written on (AMD Radeon 780M integrated) Vulkan measured
708 ms against the CPU's 422 ms, so it chose the CPU. A discrete card is the other
way round by a factor of several. A Kylin machine with a Mali GPU is measured the
same way, and one without a Vulkan loader stays on the CPU without a word on
stdout.

`DSH_OCR_BACKEND=cpu|vulkan|metal` skips the measurement. The chosen backend is
reported on stderr, never on stdout, so the Host's contract is unchanged.

## Publishing it

The binaries go to the intranet release that the settings page points readers
at:

```powershell
curl.exe -sS -X POST "http://10.151.5.175:3000/api/v1/repos/ITPublic/dsh-ocr/releases" `
  -H "Authorization: token <token>" -H "Content-Type: application/json" `
  -d '{"tag_name":"v1.0.0","name":"v1.0.0","body":"PaddleOCR reader for the redaction plugin"}'
```

then upload each file with `POST .../releases/<id>/assets?name=<name>` and
`-F "attachment=@<file>"`.

## Why PaddleOCR and not the platform engine

The platform engines are what a machine already has, and they stay the default.
PaddleOCR reads a printed procedure sheet noticeably better, and that is the
input this tool exists for: a misread company name or a batch number split across
tokens is a value no rule matches, and it then reaches the model.

The same 1500×900 page, both engines, same machine. Every name on it is invented:

| line | Windows engine | PaddleOCR |
|---|---|---|
| 1 | `示例制药有限公司` | `示例制药有限公司` |
| 3 | `SOP 一 MFG 一2026 一014` | `SOP-MFG-2026-014` |
| 4 | `扌比号 ： 20261022` | `批号：20261022` |
| 5 | `、 制粒工序` | `一、制粒工序` |
| 7 | `投料量 25． 5kg … 搅拌 1 5 分钟` | `投料量 25.5kg，…，搅拌15分钟` |
| 9 | `± 3．0％` | `±3.0%` |
| 12 | `示例制药有阝艮公司` | `示例制药有限公司` |
| 13 | `DEV一2026 一014` | `DEV-2026-014` |

The Windows engine reads `批` as `扌比`, reads `限` as `阝艮`, turns every hyphen
into `一`, drops the `一` of `一、制粒工序`, and splits `15` into `1 5`. PaddleOCR
gets all of them right, which is why a deployment that reads document screenshots
wants it.

Note what this does **not** claim: on a screenshot of the app itself — icons,
two-character labels, a status bar — both engines return the same fragmentary
text, and that is the input, not the reader. The reader is worth installing for
pages.
