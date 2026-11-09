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
whole installation. On Linux the unpacked `dsh-ocr` needs `chmod +x`: a zip
carries no Unix permission bits. A deployment that keeps the file elsewhere sets the path:

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
| stdout | one recognized line per line by default, UTF-8; a JSON report on request |
| exit 0 | the text on stdout, possibly empty |
| exit ≠ 0 | a diagnostic on stderr; the caller reports it and keeps the image out of the session |

stdout is UTF-8 explicitly, not the console's code page: a Windows process that
writes through the ANSI page turns every recognized Chinese character into
garbage that no redaction rule matches.

Plain text stays the default so a Host older than the reader keeps working:
`--json` or `DSH_OCR_JSON=1` asks for the JSON report, and the Host parses either
answer. The report carries each line together with its detected box:

```json
{
  "version": 1,
  "backend": "cpu",
  "elapsedMs": 562,
  "image": { "width": 1440, "height": 900 },
  "text": "华润三九众益制药有限公司",
  "lines": [
    {
      "text": "华润三九众益制药有限公司",
      "box": { "x1": 24, "y1": 16, "x2": 216.2, "y2": 18, "x3": 216, "y3": 39, "x4": 23.8, "y4": 37 },
      "detectionScore": 0.8486,
      "recognitionScore": 38.536,
      "classificationScore": 0.9999,
      "rotationDegrees": 0,
      "characters": []
    }
  ]
}
```

`box` holds the four corners in input-image pixels, clockwise from the top-left.
`detectionScore` and `classificationScore` are 0–1 confidences;
`recognitionScore` is the recognizer's raw score, not normalized, and only
useful for relative comparison. `--chars` adds a `characters` array to every
line, each with `text`, `score` and its own `box`; it implies `--json`, because
plain text cannot carry the coordinates. `--backend=cpu|vulkan|metal` matches
`DSH_OCR_BACKEND`, and the argument wins.

Passing a file path as the only argument reads that file instead, which is what
makes the binary debuggable by hand.

### Serving several images

The Host keeps the reader alive by default so the model loads once: started with
`--serve`, it reads one base64 image per line on stdin and writes one JSON report
per line on stdout, in the order the images were written; `--serve --chars` adds
the per-character boxes. `--version` prints `dsh-ocr 2` and exits — the Host uses
it to find out whether a binary understands the serve protocol, and an older one
that does not is still read one process per image. The process exits at EOF, and
the Host stops it when the Host exits. The Host sets `DOTNET_TieredCompilation=0`
for the server: tiered JIT re-compiles the kernels between tier-0 and tier-1, and
a server pays that on every image for the first few, while a one-shot process is
too short-lived to benefit — so the switch is only turned off for the server.
Without a remembered backend the first served image starts on the CPU: the Vulkan
measurement alone costs seconds on an integrated GPU, and a server that reads many
images should not spend that before its first answer. A machine that wants Vulkan
pins `DSH_OCR_BACKEND=vulkan`, or runs one one-shot call first so the measurement
is written to the cache.

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
CPU against Vulkan — the winner is written to a cache file, and every later call
loads one model only. A measurement beats a device name: an integrated GPU is
often the slower choice, and the numbers differ per machine.

The cache is written, in order, to `DSH_OCR_CACHE`, beside the executable, or
`%TEMP%`. The executable comes before `%TEMP%` for a reason: a Host subprocess
with a restricted token may not be able to write `%TEMP%`, and while the cache
has never been written every call measures both backends again, which turns one
image into 1.7–2 s. Only when all three candidates fail does the reader report
`backend cache write failed on every candidate path` on stderr.

On the machine this was written on (AMD Radeon 780M integrated), a one-shot call —
process start, decode, model load, recognition — measured about 640 ms on the CPU
against 770 ms on Vulkan, so it chose the CPU. The first served image still pays
the process start and the model load (about 1 s, including the protocol probe);
after that each image is recognition only, about 85 ms for a 1440×900 screenshot —
the same order as the upstream benchmark for this class of device. A discrete card
is the other way round by a factor of several. A Kylin machine with a Mali GPU is
measured the same way, and one without a Vulkan loader stays on the CPU without a
word on stdout.

`DSH_OCR_BACKEND=cpu|vulkan|metal` and `--backend` skip the measurement. The
chosen backend is reported on stderr, never on stdout, so the Host's contract is
unchanged.

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
