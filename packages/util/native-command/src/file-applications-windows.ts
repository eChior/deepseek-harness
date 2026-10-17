/** Windows Shell association queries and invocation; paths are encoded data, never PowerShell expressions. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NativeCommandRunner } from './runner.ts'
import { windowsPowerShell } from './windows-powershell.ts'

/**
 * Shell objects are called through their native vtables, never wrapped in runtime callable wrappers: on
 * Windows 7 the handler enumerator fails (.NET Framework) or crashes (.NET) on the extra interface probes a
 * wrapper makes. Invoke preserves packaged-app and DDE handling.
 */
const WINDOWS_ASSOCIATIONS = String.raw`
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class DshFileAssociations {
  [UnmanagedFunctionPointer(CallingConvention.StdCall)]
  delegate int EnumNext(IntPtr self, uint count, out IntPtr handler, out uint fetched);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)]
  delegate int TextGetter(IntPtr self, out IntPtr text);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)]
  delegate int IconGetter(IntPtr self, out IntPtr path, out int index);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)]
  delegate int DataInvoker(IntPtr self, IntPtr data);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)]
  delegate int HandlerBinder(IntPtr self, IntPtr context, ref Guid handler, ref Guid iid, out IntPtr result);
  // Vtable slots after IUnknown's three. IEnumAssocHandlers: Next. IShellItem: BindToHandler.
  // IAssocHandler: GetName, GetUIName, GetIconLocation, IsRecommended, MakeDefault, Invoke.
  const int EnumNextSlot = 3, BindToHandlerSlot = 3, GetNameSlot = 3, GetUINameSlot = 4, GetIconLocationSlot = 5, InvokeSlot = 8;
  static T Method<T>(IntPtr instance, int slot) where T : class {
    IntPtr table = Marshal.ReadIntPtr(instance);
    return (T)(object)Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(table, slot * IntPtr.Size), typeof(T));
  }
  static string HandlerText(IntPtr handler, int slot) {
    IntPtr text;
    Marshal.ThrowExceptionForHR(Method<TextGetter>(handler, slot)(handler, out text));
    try { return Marshal.PtrToStringUni(text); } finally { Marshal.FreeCoTaskMem(text); }
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  static extern int SHAssocEnumHandlers(string extension, uint filter, out IntPtr handlers);
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  static extern int SHCreateItemFromParsingName(string path, IntPtr context, ref Guid iid, out IntPtr item);
  [DllImport("shlwapi.dll", CharSet = CharSet.Unicode)]
  static extern int AssocQueryString(uint flags, uint kind, string association, string extra, StringBuilder output, ref uint size);
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  static extern int SHDefExtractIcon(string path, int index, uint flags, out IntPtr large, out IntPtr small, uint size);
  [DllImport("user32.dll")]
  static extern bool DestroyIcon(IntPtr icon);
  [DllImport("shlwapi.dll", CharSet = CharSet.Unicode)]
  static extern int SHLoadIndirectString(string source, StringBuilder output, uint size, IntPtr reserved);

  [DllImport("shlwapi.dll", PreserveSig = false)]
  static extern void SHCreateThreadRef(IntPtr count, out IntPtr reference);
  [DllImport("shlwapi.dll", PreserveSig = false)]
  static extern void SHSetThreadRef(IntPtr reference);
  [DllImport("shell32.dll")]
  static extern void SHSetInstanceExplorer(IntPtr reference);
  [StructLayout(LayoutKind.Sequential)]
  struct Message {
    public IntPtr window;
    public uint message;
    public UIntPtr wParam;
    public IntPtr lParam;
    public uint time;
    public int x, y;
    public uint reserved;
  }
  [DllImport("user32.dll", SetLastError = true)]
  static extern UIntPtr SetTimer(IntPtr window, UIntPtr id, uint milliseconds, IntPtr callback);
  [DllImport("user32.dll")]
  static extern bool KillTimer(IntPtr window, UIntPtr id);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern int GetMessage(out Message message, IntPtr window, uint min, uint max);
  [DllImport("user32.dll")]
  static extern bool TranslateMessage(ref Message message);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern IntPtr DispatchMessage(ref Message message);

  // Shell handlers may return before their asynchronous launch work releases the host.
  // The shared Shell reference, rather than an arbitrary delay, owns that lifetime.
  static void WithShellLifetime(Action action) {
    IntPtr count = Marshal.AllocHGlobal(sizeof(int));
    IntPtr reference = IntPtr.Zero;
    try {
      Marshal.WriteInt32(count, 0);
      SHCreateThreadRef(count, out reference);
      SHSetThreadRef(reference);
      SHSetInstanceExplorer(reference);
      int owned = Marshal.ReadInt32(count);
      try { action(); }
      finally {
        if (Marshal.ReadInt32(count) > owned) {
          // USER_TIMER_MINIMUM wakes the STA to inspect the reference count while dispatching COM work.
          UIntPtr timer = SetTimer(IntPtr.Zero, UIntPtr.Zero, 10, IntPtr.Zero);
          if (timer == UIntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
          // Windows 7's Shell holds the reference until the launched application exits, so the drain there only
          // gives asynchronous launch work a bounded window; later Windows releases it once the handoff completes.
          bool bounded = Environment.OSVersion.Version < new Version(6, 2);
          int deadline = Environment.TickCount + 3000;
          try {
            while (Marshal.ReadInt32(count) > owned) {
              if (bounded && Environment.TickCount - deadline > 0) break;
              Message message;
              if (GetMessage(out message, IntPtr.Zero, 0, 0) <= 0) throw new InvalidOperationException("Shell handoff message loop ended");
              TranslateMessage(ref message);
              DispatchMessage(ref message);
            }
          } finally { KillTimer(IntPtr.Zero, timer); }
        }
      }
    } finally {
      SHSetInstanceExplorer(IntPtr.Zero);
      SHSetThreadRef(IntPtr.Zero);
      int remaining = reference == IntPtr.Zero ? 0 : Marshal.Release(reference);
      // An interrupted drain leaves its counter owned by the terminating helper process.
      if (remaining == 0) Marshal.FreeHGlobal(count);
    }
  }

  public sealed class Application {
    public string id;
    public string name;
    public string icon;
    public bool @default;
  }
  static string Associated(string extension, uint kind) {
    uint size = 0;
    AssocQueryString(0, kind, extension, null, null, ref size);
    if (size == 0) return null;
    var text = new StringBuilder((int)size);
    return AssocQueryString(0, kind, extension, null, text, ref size) == 0 ? text.ToString() : null;
  }
  // Resolve a packaged application's indirect icon reference, for example
  // @{Microsoft.WindowsNotepad_...?ms-resource://.../NotepadAppList.png}, to
  // the resource file the Shell would draw; an unresolved reference is null.
  static string ResolveIndirectIcon(string source) {
    var output = new StringBuilder(1024);
    return SHLoadIndirectString(source, output, (uint)output.Capacity, IntPtr.Zero) == 0 ? output.ToString() : null;
  }
  // Read one icon source into a 32px PNG: an image file directly, otherwise the
  // resource the Shell extracts at the given index. A missing resource is null.
  static string PngFromIconSource(string source, int index) {
    IntPtr large = IntPtr.Zero, small = IntPtr.Zero;
    try {
      if (Path.GetExtension(source).Equals(".png", StringComparison.OrdinalIgnoreCase)) {
        using (var original = Image.FromFile(source))
        using (var resized = new Bitmap(original, new Size(32, 32)))
        using (var stream = new MemoryStream()) {
          resized.Save(stream, ImageFormat.Png);
          return "data:image/png;base64," + Convert.ToBase64String(stream.ToArray());
        }
      }
      if (SHDefExtractIcon(source, index, 0, out large, out small, 32) != 0 || large == IntPtr.Zero) return null;
      using (var image = Icon.FromHandle(large))
      using (var bitmap = image.ToBitmap())
      using (var stream = new MemoryStream()) {
        bitmap.Save(stream, ImageFormat.Png);
        return "data:image/png;base64," + Convert.ToBase64String(stream.ToArray());
      }
    } catch (Exception) {
      // Missing icon resources do not make the application unusable.
      return null;
    } finally {
      if (large != IntPtr.Zero) DestroyIcon(large);
      if (small != IntPtr.Zero) DestroyIcon(small);
    }
  }
  // Best-effort fallback: some handlers return their executable path from GetName, but a
  // packaged handler's name may be an AUMID or family name, which extracts no icon.
  static string IconData(IntPtr handler, string id) {
    string source = null; int index = 0;
    IntPtr location; int locationIndex;
    // A handler without a drawable icon location falls back to its name.
    if (Method<IconGetter>(handler, GetIconLocationSlot)(handler, out location, out locationIndex) >= 0) {
      try { source = Marshal.PtrToStringUni(location); index = locationIndex; } finally { Marshal.FreeCoTaskMem(location); }
    }
    if (!String.IsNullOrEmpty(source)) {
      source = Environment.ExpandEnvironmentVariables(source);
      if (source.StartsWith("@{", StringComparison.Ordinal) && source.EndsWith("}", StringComparison.Ordinal)) {
        var resolved = ResolveIndirectIcon(source);
        if (!String.IsNullOrEmpty(resolved)) source = resolved;
      }
      var icon = PngFromIconSource(source, index);
      if (icon != null) return icon;
    }
    return String.IsNullOrEmpty(id) || String.Equals(id, source, StringComparison.OrdinalIgnoreCase)
      ? null
      : PngFromIconSource(id, 0);
  }
  static void Visit(string path, Action<IntPtr> visit) {
    var extension = Path.GetExtension(path);
    if (extension.Length == 0) return;
    IntPtr handlers;
    Marshal.ThrowExceptionForHR(SHAssocEnumHandlers(extension, 0, out handlers));
    if (handlers == IntPtr.Zero) return;
    try {
      var next = Method<EnumNext>(handlers, EnumNextSlot);
      while (true) {
        IntPtr handler; uint fetched;
        int result = next(handlers, 1, out handler, out fetched);
        Marshal.ThrowExceptionForHR(result);
        if (result != 0 || fetched == 0 || handler == IntPtr.Zero) break;
        try { visit(handler); } finally { Marshal.Release(handler); }
      }
    } finally { Marshal.Release(handlers); }
  }
  public static Application[] List(string path) {
    var extension = Path.GetExtension(path);
    var executable = extension.Length == 0 ? null : Associated(extension, 2);
    var appId = extension.Length == 0 ? null : Associated(extension, 21);
    var apps = new List<Application>();
    var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    Visit(path, delegate(IntPtr handler) {
      string id = HandlerText(handler, GetNameSlot), name = HandlerText(handler, GetUINameSlot);
      if (!seen.Add(id)) return;
      apps.Add(new Application { id = id, name = name, icon = IconData(handler, id),
        @default = String.Equals(id, executable, StringComparison.OrdinalIgnoreCase) || String.Equals(id, appId, StringComparison.OrdinalIgnoreCase) });
    });
    return apps.ToArray();
  }
  public static void Open(string path, string application) {
    WithShellLifetime(delegate { OpenRegistered(path, application); });
  }
  static void OpenRegistered(string path, string application) {
    bool opened = false;
    Visit(path, delegate(IntPtr handler) {
      if (opened || !String.Equals(HandlerText(handler, GetNameSlot), application, StringComparison.OrdinalIgnoreCase)) return;
      var iid = new Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"); // IShellItem
      IntPtr item;
      Marshal.ThrowExceptionForHR(SHCreateItemFromParsingName(path, IntPtr.Zero, ref iid, out item));
      IntPtr data = IntPtr.Zero;
      try {
        var bhid = new Guid("b8c0bd9f-ed24-455c-83e6-d5390c4fe8c4"); // BHID_DataObject
        var dataIid = new Guid("0000010e-0000-0000-c000-000000000046"); // IDataObject
        Marshal.ThrowExceptionForHR(Method<HandlerBinder>(item, BindToHandlerSlot)(item, IntPtr.Zero, ref bhid, ref dataIid, out data));
        Marshal.ThrowExceptionForHR(Method<DataInvoker>(handler, InvokeSlot)(handler, data));
        opened = true;
      } finally {
        if (data != IntPtr.Zero) Marshal.Release(data);
        Marshal.Release(item);
      }
    });
    if (!opened) throw new InvalidOperationException("Application is not registered for this file");
  }
}`

/**
 * Execute the Windows Shell adapter in a Unicode STA PowerShell process; the adapter
 * source is a private temporary script file, removed once the call settles.
 * @param path - Windows file path, translated by the caller for WSL.
 * @param application - registered handler to invoke; null requests the application list.
 * @param signal - caller cancellation.
 * @param run - native command runner.
 * @returns adapter output; query mode emits a JSON array.
 */
export async function windowsFileApplications(
  path: string, application: string | null, signal: AbortSignal, run: NativeCommandRunner,
): Promise<string> {
  const encodedPath = Buffer.from(path).toString('base64')
  const encodedApplication = Buffer.from(application ?? '').toString('base64')
  const script = `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$references = 'System', 'System.Core', 'System.Drawing'
# PowerShell 7 (Windows 7 build): explicit references replace its default .NET set (the ref folder under
# PSHOME), and the drawing types live in System.Drawing.Common there.
if ($PSVersionTable.PSEdition -eq 'Core') {
  $references = @(Get-ChildItem -LiteralPath (Join-Path $PSHOME 'ref') -Filter *.dll | ForEach-Object FullName) + 'System.Drawing.Common'
}
Add-Type -ReferencedAssemblies $references -TypeDefinition @'
${WINDOWS_ASSOCIATIONS}
'@
$path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'))
$application = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedApplication}'))
${application === null ? 'ConvertTo-Json -InputObject @([DshFileAssociations]::List($path)) -Depth 4 -Compress' : '[DshFileAssociations]::Open($path, $application)'}
`
  // The script travels as a file, not as command-line data: -EncodedCommand grew with the
  // embedded C# and overflowed the 32767-character CreateProcess limit for long paths.
  // PowerShell 5.1 decodes a -File script as ANSI unless it carries a BOM; the BOM keeps
  // the embedded UTF-8 source intact.
  const directory = await mkdtemp(join(tmpdir(), 'dsh-native-command-'))
  const scriptPath = join(directory, 'associations.ps1')
  try {
    await writeFile(scriptPath, `\uFEFF${script}`, 'utf8')
    const result = await run(windowsPowerShell(), [
      '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
    ], signal, 'hidden')
    return result.stdout
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
