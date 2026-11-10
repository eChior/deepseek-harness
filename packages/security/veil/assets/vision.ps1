# Read the text out of a PNG/JPEG/WebP/TIFF/BMP image with the recognizer that
# ships with Windows. The image arrives as base64 on standard input and is never
# written to disk: the recognizer decodes it from a stream held in memory. Only
# recognized text leaves this script.
#
# -NoProfile -NonInteractive -ExecutionPolicy Bypass is how the caller runs it.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]
function Await($WinRtTask, $ResultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}

[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime] | Out-Null
[Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[System.IO.WindowsRuntimeStreamExtensions] | Out-Null

$payload = [Console]::In.ReadToEnd()
if ([string]::IsNullOrWhiteSpace($payload)) { Write-Error 'no image data on stdin'; exit 3 }
$bytes = [Convert]::FromBase64String($payload.Trim())

$stream = New-Object System.IO.MemoryStream
$stream.Write($bytes, 0, $bytes.Length)
$stream.Position = 0
$random = [System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($stream)

$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($random)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

# The user's own language profile is the first choice; a client whose profile is
# not Chinese still reads Chinese documents through the explicit fallback.
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($null -eq $engine) {
  $language = New-Object Windows.Globalization.Language('zh-Hans-CN')
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
}
if ($null -eq $engine) { Write-Error 'no OCR engine is installed for this profile'; exit 2 }

$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

# Rebuild each line from word rectangles instead of joining words with a space:
# the recognizer reports one token per visual run, so a space between every pair
# both destroys English words and splits a document number in half.
$lines = New-Object System.Collections.Generic.List[string]
foreach ($line in $result.Lines) {
  $parts = New-Object System.Collections.Generic.List[string]
  $previous = $null
  foreach ($word in $line.Words) {
    if ($null -ne $previous) {
      $gap = $word.BoundingRect.X - ($previous.X + $previous.Width)
      if ($gap -gt [Math]::Max(2.0, $previous.Height * 0.12)) { $parts.Add(' ') }
    }
    $parts.Add($word.Text)
    $previous = $word.BoundingRect
  }
  $lines.Add(-join $parts)
}
$lines -join "`n"
