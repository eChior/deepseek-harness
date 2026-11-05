using System.Text;
using Sdcb.SimdPaddleOCR;
using Sdcb.SimdPaddleOCR.Models.ChineseV6Tiny;
using SkiaSharp;

// The Host reads stdout as UTF-8. A Windows console defaults to the ANSI code
// page, which turns every Chinese character the model recognized into garbage
// the redaction rules then fail to match.
Console.OutputEncoding = new UTF8Encoding(false);

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

    // Defaults throughout. The detector's side limit shrinks a 1500px page to
    // 960px, which still reads every line of a procedure sheet correctly; raising
    // it to 2560 started reading window chrome in screenshots as characters, so
    // the default is the better trade for both kinds of input.
    using PaddleOcrAll ocr = await PaddleOcrAll.LoadAsync(ChineseV6TinyModels.Default);

    unsafe
    {
        PaddleOcrResult result = ocr.Run(
            new ReadOnlySpan<byte>((byte*)bitmap.GetPixels(), bitmap.RowBytes * bitmap.Height),
            bitmap.Width,
            bitmap.Height,
            bitmap.RowBytes,
            ImagePixelFormat.Bgra32);

        // One recognized line per line, exactly what vision.ps1 writes: the
        // caller joins and normalizes, so the two engines stay interchangeable.
        Console.Out.Write(result.Text);
    }
}

return 0;
