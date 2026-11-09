using System.Buffers;
using System.Diagnostics;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
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

// Where the measured backend is remembered. The Host may pin a path with
// `DSH_OCR_CACHE`; otherwise the file sits beside the executable, which is the
// directory a download was unpacked into and is writable by the user. `%TEMP%`
// is the last resort: certain launchers run the reader under a restricted
// token that can read the directory but not create a file in it, and a write
// that silently fails there is exactly what makes every call pay for a fresh
// measurement again.
string[] CacheCandidates()
{
    List<string> paths = [];
    string? configured = Environment.GetEnvironmentVariable("DSH_OCR_CACHE");
    if (!string.IsNullOrWhiteSpace(configured)) paths.Add(configured);
    paths.Add(Path.Combine(AppContext.BaseDirectory, "dsh-ocr-backend.txt"));
    string temp = Path.Combine(Path.GetTempPath(), "dsh-ocr-backend.txt");
    if (!paths.Contains(temp, StringComparer.OrdinalIgnoreCase)) paths.Add(temp);
    return [.. paths];
}

OcrBackend? Remembered()
{
    foreach (string path in CacheCandidates())
    {
        try
        {
            if (!File.Exists(path)) continue;
            OcrBackend? backend = Named(File.ReadAllText(path));
            if (backend is not null) return backend;
        }
        catch (IOException)
        {
            // Try the next candidate.
        }
        catch (UnauthorizedAccessException)
        {
            // Same.
        }
    }
    return null;
}

void Remember(OcrBackend backend)
{
    foreach (string path in CacheCandidates())
    {
        try
        {
            File.WriteAllText(path, backend.ToString().ToLowerInvariant());
            return;
        }
        catch (IOException)
        {
            // Try the next candidate.
        }
        catch (UnauthorizedAccessException)
        {
            // Same.
        }
    }
    // A measurement that never sticks is what makes every call slow, so the
    // failure is worth one line on stderr even though it costs nothing else.
    Console.Error.WriteLine("backend cache write failed on every candidate path");
}

// Command line: the Host asks for machine-readable output when it wants the
// geometry as well as the text. The old contract — a path, or base64 on stdin,
// and plain text on stdout — is unchanged when no switch is given, so a Host
// that predates this build keeps working against the new binary and vice versa.
bool json = false;
bool withChars = false;
bool serve = false;
string? filePath = null;
OcrBackend? forcedBackend = null;
foreach (string arg in args)
{
    if (arg == "--json")
    {
        json = true;
    }
    else if (arg == "--chars")
    {
        // Character boxes need the CTC alignment, which is why they are a
        // switch of their own: the default read keeps that work out.
        withChars = true;
        json = true;
    }
    else if (arg == "--serve")
    {
        // Keep the model loaded and answer one image per line until stdin
        // closes. The Host starts one process per image otherwise, and the
        // model load plus the first inference dominate such a call.
        serve = true;
        json = true;
    }
    else if (arg == "--version")
    {
        Console.Out.WriteLine("dsh-ocr 2");
        return 0;
    }
    else if (arg.StartsWith("--backend=", StringComparison.Ordinal))
    {
        forcedBackend = Named(arg["--backend=".Length..]);
        if (forcedBackend is null)
        {
            Console.Error.WriteLine($"unknown backend: {arg}");
            return 4;
        }
    }
    else if (arg.StartsWith("--", StringComparison.Ordinal))
    {
        Console.Error.WriteLine($"unknown option: {arg}");
        return 4;
    }
    else
    {
        filePath = arg;
    }
}

// The Host asks for the report through the environment so that a machine whose
// download predates the switch keeps writing plain text: an older reader
// ignores the variable, the Host parses whichever answer it gets.
if (!json && Environment.GetEnvironmentVariable("DSH_OCR_JSON") is "1" or "true")
{
    json = true;
}

// Run one image through an already loaded model.
PaddleOcrResult Run(PaddleOcrAll ocr, SKBitmap bitmap)
{
    unsafe
    {
        // Defaults otherwise: the detector's side limit shrinks a 1500px page to
        // 960px, which still reads every line of a procedure sheet correctly;
        // raising it to 2560 started reading window chrome in screenshots as
        // characters, so the default is the better trade for both inputs.
        return ocr.Run(
            new ReadOnlySpan<byte>((byte*)bitmap.GetPixels(), bitmap.RowBytes * bitmap.Height),
            bitmap.Width,
            bitmap.Height,
            returnCtcAlignment: withChars,
            sourceStride: bitmap.RowBytes,
            format: ImagePixelFormat.Bgra32);
    }
}

// One full read on one device: load the model, run the image, report the result
// and how long the whole thing took. Loading is part of the measurement because
// it is part of what the caller waits for. The loaded model is returned so a
// serve loop can keep it.
(PaddleOcrAll Ocr, PaddleOcrResult Result, double Milliseconds) LoadAndRun(SKBitmap bitmap, OcrBackend backend)
{
    PaddleOcrOptions options = new()
    {
        Detector = new PaddleOcrDetectorOptions { Backend = backend },
        Recognizer = new PaddleOcrRecognizerOptions { Backend = backend },
        Classifier = new PaddleOcrClassifierOptions { Backend = backend },
    };
    Stopwatch watch = Stopwatch.StartNew();
    PaddleOcrAll ocr = PaddleOcrAll.LoadAsync(ChineseV6TinyModels.Default, options).GetAwaiter().GetResult();
    try
    {
        PaddleOcrResult result = Run(ocr, bitmap);
        watch.Stop();
        return (ocr, result, watch.Elapsed.TotalMilliseconds);
    }
    catch
    {
        ocr.Dispose();
        throw;
    }
}

// The machine-readable form. `recognitionScore` is the recognizer's raw score,
// not a probability, so it is reported as-is rather than dressed up as a
// confidence. Coordinates are in the input image's pixels.
string ToJson(PaddleOcrResult result, OcrBackend backend, double milliseconds, SKBitmap bitmap)
{
    // The default encoder escapes every non-ASCII character, so a page of
    // Chinese would reach the Host as six bytes per character of "\uXXXX".
    // The output is a pipe, not HTML, so the relaxed encoder is the right one:
    // it writes the text as UTF-8 and still produces valid JSON.
    JsonWriterOptions options = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };
    ArrayBufferWriter<byte> buffer = new();
    using (Utf8JsonWriter writer = new(buffer, options))
    {
        writer.WriteStartObject();
        writer.WriteNumber("version", 1);
        writer.WriteString("backend", backend.ToString().ToLowerInvariant());
        writer.WriteNumber("elapsedMs", Math.Round(milliseconds));
        writer.WriteStartObject("image");
        writer.WriteNumber("width", bitmap.Width);
        writer.WriteNumber("height", bitmap.Height);
        writer.WriteEndObject();
        writer.WriteString("text", result.Text);
        writer.WriteStartArray("lines");
        foreach (PaddleOcrLine line in result.Lines)
        {
            writer.WriteStartObject();
            writer.WriteString("text", line.Text);
            PaddleOcrDetectionBox box = line.Box;
            writer.WriteStartObject("box");
            writer.WriteNumber("x1", box.X1);
            writer.WriteNumber("y1", box.Y1);
            writer.WriteNumber("x2", box.X2);
            writer.WriteNumber("y2", box.Y2);
            writer.WriteNumber("x3", box.X3);
            writer.WriteNumber("y3", box.Y3);
            writer.WriteNumber("x4", box.X4);
            writer.WriteNumber("y4", box.Y4);
            writer.WriteEndObject();
            writer.WriteNumber("detectionScore", box.Score);
            writer.WriteNumber("recognitionScore", line.RecognitionScore);
            writer.WriteNumber("classificationScore", line.ClassificationScore);
            writer.WriteNumber("classificationLabel", line.ClassificationLabel);
            writer.WriteNumber("rotationDegrees", line.AppliedRotationDegrees);
            if (withChars)
            {
                PaddleOcrCharacterBox[]? characters = line.EstimateCharacterBoxes();
                if (characters is not null)
                {
                    writer.WriteStartArray("characters");
                    foreach (PaddleOcrCharacterBox character in characters)
                    {
                        writer.WriteStartObject();
                        writer.WriteString("text", character.Text);
                        writer.WriteNumber("score", character.Score);
                        writer.WriteStartObject("box");
                        writer.WriteNumber("x1", character.X1);
                        writer.WriteNumber("y1", character.Y1);
                        writer.WriteNumber("x2", character.X2);
                        writer.WriteNumber("y2", character.Y2);
                        writer.WriteNumber("x3", character.X3);
                        writer.WriteNumber("y3", character.Y3);
                        writer.WriteNumber("x4", character.X4);
                        writer.WriteNumber("y4", character.Y4);
                        writer.WriteEndObject();
                        writer.WriteEndObject();
                    }
                    writer.WriteEndArray();
                }
            }
            writer.WriteEndObject();
        }
        writer.WriteEndArray();
        writer.WriteEndObject();
    }
    return Encoding.UTF8.GetString(buffer.WrittenSpan);
}

// Serve mode: one image per line on stdin, one report per line on stdout.
// The model is loaded once and kept, which is what removes the per-call load
// and first-inference cost the Host otherwise pays for every image.
if (serve)
{
    return Serve();
}

// Two ways in, matching assets/vision.ps1: a path for a person debugging the
// tool, and base64 on stdin for the Host, which never writes the image to disk.
Stream source;
if (filePath is not null)
{
    source = File.OpenRead(filePath);
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

    OcrBackend? fixedBackend = forcedBackend
        ?? Named(Environment.GetEnvironmentVariable("DSH_OCR_BACKEND"))
        ?? Remembered();

    if (fixedBackend is OcrBackend known)
    {
        (PaddleOcrAll ocr, PaddleOcrResult result, double milliseconds) = LoadAndRun(bitmap, known);
        using (ocr)
        {
            Console.Error.WriteLine($"backend={FormatBackend(known)} ({milliseconds:F0} ms)");
            Write(result, known, milliseconds, bitmap);
        }
        return 0;
    }

    (PaddleOcrAll Ocr, PaddleOcrResult Result, double Milliseconds) cpu = LoadAndRun(bitmap, OcrBackend.Cpu);
    (PaddleOcrAll Ocr, PaddleOcrResult Result, double Milliseconds)? gpu = null;
    try
    {
        gpu = LoadAndRun(bitmap, OcrBackend.Vulkan);
    }
    catch (Exception error) when (error is DllNotFoundException or InvalidOperationException or NotSupportedException or TypeInitializationException)
    {
        // No Vulkan loader or no device that can run the kernels: the CPU result
        // is what this machine reads images with, and that is not a failure.
        Console.Error.WriteLine($"vulkan unavailable: {error.GetType().Name}");
    }

    if (gpu is { } faster && faster.Milliseconds < cpu.Milliseconds)
    {
        cpu.Ocr.Dispose();
        Remember(OcrBackend.Vulkan);
        Console.Error.WriteLine($"backend=vulkan ({faster.Milliseconds:F0} ms vs cpu {cpu.Milliseconds:F0} ms)");
        using (faster.Ocr) Write(faster.Result, OcrBackend.Vulkan, faster.Milliseconds, bitmap);
    }
    else
    {
        gpu?.Ocr.Dispose();
        Remember(OcrBackend.Cpu);
        string note = gpu is { } slower ? $", vulkan {slower.Milliseconds:F0} ms" : string.Empty;
        Console.Error.WriteLine($"backend=cpu ({cpu.Milliseconds:F0} ms{note})");
        using (cpu.Ocr) Write(cpu.Result, OcrBackend.Cpu, cpu.Milliseconds, bitmap);
    }
}

return 0;

static string FormatBackend(OcrBackend backend) => backend.ToString().ToLowerInvariant();

void Write(PaddleOcrResult result, OcrBackend backend, double milliseconds, SKBitmap bitmap)
{
    Console.Out.Write(json
        ? ToJson(result, backend, milliseconds, bitmap)
        : result.Text);
}

// Pick the device on the first image and keep the model that ran it. The
// measurement and the first answer are the same run, so the first image does
// not pay for a measurement it cannot use.
(PaddleOcrAll Ocr, OcrBackend Backend, PaddleOcrResult Result, double Milliseconds) Choose(
    SKBitmap bitmap,
    OcrBackend? fixedBackend,
    bool measure)
{
    if (fixedBackend is OcrBackend known)
    {
        (PaddleOcrAll ocr, PaddleOcrResult result, double ms) = LoadAndRun(bitmap, known);
        return (ocr, known, result, ms);
    }

    // A server reads many images, so the first one must not pay for a Vulkan
    // measurement it may not even use — on an integrated GPU that measurement
    // alone is several seconds. Without a remembered backend it therefore
    // starts on the CPU; an operator who knows better pins one with
    // `DSH_OCR_BACKEND`. The one-shot path still measures, because there every
    // call is the first call and nothing would be remembered otherwise.
    if (!measure)
    {
        (PaddleOcrAll ocr, PaddleOcrResult result, double ms) = LoadAndRun(bitmap, OcrBackend.Cpu);
        return (ocr, OcrBackend.Cpu, result, ms);
    }

    (PaddleOcrAll Ocr, PaddleOcrResult Result, double Milliseconds) cpu = LoadAndRun(bitmap, OcrBackend.Cpu);
    (PaddleOcrAll Ocr, PaddleOcrResult Result, double Milliseconds)? gpu = null;
    try
    {
        gpu = LoadAndRun(bitmap, OcrBackend.Vulkan);
    }
    catch (Exception error) when (error is DllNotFoundException or InvalidOperationException or NotSupportedException or TypeInitializationException)
    {
        Console.Error.WriteLine($"vulkan unavailable: {error.GetType().Name}");
    }

    if (gpu is { } faster && faster.Milliseconds < cpu.Milliseconds)
    {
        cpu.Ocr.Dispose();
        Remember(OcrBackend.Vulkan);
        Console.Error.WriteLine($"backend=vulkan ({faster.Milliseconds:F0} ms vs cpu {cpu.Milliseconds:F0} ms)");
        return (faster.Ocr, OcrBackend.Vulkan, faster.Result, faster.Milliseconds);
    }

    gpu?.Ocr.Dispose();
    Remember(OcrBackend.Cpu);
    string note = gpu is { } slower ? $", vulkan {slower.Milliseconds:F0} ms" : string.Empty;
    Console.Error.WriteLine($"backend=cpu ({cpu.Milliseconds:F0} ms{note})");
    return (cpu.Ocr, OcrBackend.Cpu, cpu.Result, cpu.Milliseconds);
}

// One image per line on stdin, one JSON report per line on stdout. A request
// that cannot be read is answered with an error object so the Host can fail
// that image without losing the reader.
int Serve()
{
    OcrBackend? fixedBackend = forcedBackend
        ?? Named(Environment.GetEnvironmentVariable("DSH_OCR_BACKEND"))
        ?? Remembered();

    PaddleOcrAll? ocr = null;
    OcrBackend backend = OcrBackend.Cpu;
    string? line;
    while ((line = Console.In.ReadLine()) is not null)
    {
        string payload = line.Trim();
        if (payload.Length == 0) continue;

        try
        {
            using MemoryStream stream = new(Convert.FromBase64String(payload), writable: false);
            using SKBitmap decoded = SKBitmap.Decode(stream)
                ?? throw new InvalidDataException("cannot decode the image");
            using SKBitmap? converted = decoded.ColorType == SKColorType.Bgra8888
                ? null
                : decoded.Copy(SKColorType.Bgra8888)
                    ?? throw new InvalidDataException("cannot convert the image to BGRA");
            SKBitmap bitmap = converted ?? decoded;

            PaddleOcrResult result;
            double milliseconds;
            if (ocr is null)
            {
                (ocr, backend, result, milliseconds) = Choose(bitmap, fixedBackend, measure: false);
                Console.Error.WriteLine($"backend={FormatBackend(backend)} (serve)");
            }
            else
            {
                Stopwatch watch = Stopwatch.StartNew();
                result = Run(ocr, bitmap);
                watch.Stop();
                milliseconds = watch.Elapsed.TotalMilliseconds;
            }

            Console.Out.WriteLine(ToJson(result, backend, milliseconds, bitmap));
            Console.Out.Flush();
        }
        catch (Exception error) when (error is not OutOfMemoryException)
        {
            Console.Error.WriteLine($"request failed: {error.Message}");
            Console.Out.WriteLine(ErrorJson(error.Message));
            Console.Out.Flush();
        }
    }

    // One JSON object with an escaped message, written without reflection so a
    // trimmed build keeps it. The message can be a file path or a decoder
    // complaint, both of which carry quotes and backslashes on Windows.
    static string ErrorJson(string message)
    {
        using MemoryStream buffer = new();
        using (Utf8JsonWriter writer = new(buffer, new JsonWriterOptions { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping }))
        {
            writer.WriteStartObject();
            writer.WriteString("error", message);
            writer.WriteEndObject();
        }
        return Encoding.UTF8.GetString(buffer.ToArray());
    }

    ocr?.Dispose();
    return 0;
}
