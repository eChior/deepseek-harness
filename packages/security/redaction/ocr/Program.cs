using System.Diagnostics;
using System.Text;
using Sdcb.SimdPaddleOCR;
using Sdcb.SimdPaddleOCR.Models.ChineseV6Tiny;
using SkiaSharp;

// The Host reads stdout as UTF-8. A Windows console defaults to the ANSI code
// page, which turns every Chinese character the model recognized into garbage
// the redaction rules then fail to match.
Console.OutputEncoding = new UTF8Encoding(false);

// Which device runs the kernels.
//
// The library's own `Auto` keeps a device it measured as slower on the CPU, but
// that judgement is per device type rather than per machine: on a laptop whose
// only adapter is an integrated GPU it still selects Vulkan, and Vulkan there
// measured twice as slow as the CPU. This tool therefore measures once, on the
// first image it ever reads, and remembers the winner; every later call pays a
// single model load. `DSH_OCR_BACKEND=cpu|vulkan|metal` skips the measurement
// for a machine whose operator knows better.
OcrBackend? Named(string? requested) => requested?.Trim().ToLowerInvariant() switch
{
    "cpu" => OcrBackend.Cpu,
    "vulkan" => OcrBackend.Vulkan,
    "metal" => OcrBackend.Metal,
    _ => null,
};

string CachePath() => Path.Combine(Path.GetTempPath(), "dsh-ocr-backend.txt");

OcrBackend? Remembered()
{
    try
    {
        string path = CachePath();
        return File.Exists(path) ? Named(File.ReadAllText(path)) : null;
    }
    catch (IOException)
    {
        return null;
    }
    catch (UnauthorizedAccessException)
    {
        return null;
    }
}

void Remember(OcrBackend backend)
{
    try
    {
        File.WriteAllText(CachePath(), backend.ToString().ToLowerInvariant());
    }
    catch (IOException)
    {
        // A cache that cannot be written only costs the next call a measurement.
    }
    catch (UnauthorizedAccessException)
    {
        // Same.
    }
}

// One full read on one device: load the model, run the image, report the text
// and how long the whole thing took. Loading is part of the measurement because
// it is part of what the caller waits for.
(string Text, double Milliseconds) Read(SKBitmap bitmap, OcrBackend backend)
{
    PaddleOcrOptions options = new()
    {
        Detector = new PaddleOcrDetectorOptions { Backend = backend },
        Recognizer = new PaddleOcrRecognizerOptions { Backend = backend },
        Classifier = new PaddleOcrClassifierOptions { Backend = backend },
    };
    Stopwatch watch = Stopwatch.StartNew();
    using PaddleOcrAll ocr = PaddleOcrAll.LoadAsync(ChineseV6TinyModels.Default, options).GetAwaiter().GetResult();
    string text;
    unsafe
    {
        // Defaults otherwise: the detector's side limit shrinks a 1500px page to
        // 960px, which still reads every line of a procedure sheet correctly;
        // raising it to 2560 started reading window chrome in screenshots as
        // characters, so the default is the better trade for both inputs.
        text = ocr.Run(
            new ReadOnlySpan<byte>((byte*)bitmap.GetPixels(), bitmap.RowBytes * bitmap.Height),
            bitmap.Width,
            bitmap.Height,
            bitmap.RowBytes,
            ImagePixelFormat.Bgra32).Text;
    }
    watch.Stop();
    return (text, watch.Elapsed.TotalMilliseconds);
}

// Two ways in, matching assets/vision.ps1: a path for a person debugging the
// tool, and base64 on stdin for the Host, which never writes the image to disk.
Stream source;
if (args.Length > 0)
{
    source = File.OpenRead(args[0]);
}
else
{
    string payload = Console.In.ReadToEnd().Trim();
    if (payload.Length == 0)
    {
        Console.Error.WriteLine("no image data on stdin");
        return 3;
    }

    source = new MemoryStream(Convert.FromBase64String(payload), writable: false);
}

using (source)
{
    using SKBitmap decoded = SKBitmap.Decode(source)
        ?? throw new InvalidDataException("cannot decode the image");
    using SKBitmap? converted = decoded.ColorType == SKColorType.Bgra8888
        ? null
        : decoded.Copy(SKColorType.Bgra8888)
            ?? throw new InvalidDataException("cannot convert the image to BGRA");
    SKBitmap bitmap = converted ?? decoded;

    OcrBackend? fixedBackend = Named(Environment.GetEnvironmentVariable("DSH_OCR_BACKEND"))
        ?? Remembered();

    if (fixedBackend is OcrBackend known)
    {
        (string text, double milliseconds) = Read(bitmap, known);
        Console.Error.WriteLine($"backend={known.ToString().ToLowerInvariant()} ({milliseconds:F0} ms)");
        Console.Out.Write(text);
        return 0;
    }

    (string cpuText, double cpuMs) = Read(bitmap, OcrBackend.Cpu);
    (string Text, double Milliseconds)? gpu = null;
    try
    {
        gpu = Read(bitmap, OcrBackend.Vulkan);
    }
    catch (Exception error) when (error is DllNotFoundException or InvalidOperationException or NotSupportedException or TypeInitializationException)
    {
        // No Vulkan loader or no device that can run the kernels: the CPU result
        // is what this machine reads images with, and that is not a failure.
        Console.Error.WriteLine($"vulkan unavailable: {error.GetType().Name}");
    }

    if (gpu is { } faster && faster.Milliseconds < cpuMs)
    {
        Remember(OcrBackend.Vulkan);
        Console.Error.WriteLine($"backend=vulkan ({faster.Milliseconds:F0} ms vs cpu {cpuMs:F0} ms)");
        Console.Out.Write(faster.Text);
    }
    else
    {
        Remember(OcrBackend.Cpu);
        string note = gpu is { } slower ? $", vulkan {slower.Milliseconds:F0} ms" : string.Empty;
        Console.Error.WriteLine($"backend=cpu ({cpuMs:F0} ms{note})");
        Console.Out.Write(cpuText);
    }
}

return 0;
