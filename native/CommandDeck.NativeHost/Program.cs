using System.Runtime.InteropServices;
using System.Text.Json;
using System.Threading.Channels;

namespace CommandDeck.NativeHost;

internal static class Program
{
    internal static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    private sealed record Output(string Text, TaskCompletionSource<bool>? Completion);
    // Fixture telemetry may be dropped under backpressure; never block the native UI thread on a pipe.
    private static readonly Channel<Output> Outbound = Channel.CreateBounded<Output>(
        new BoundedChannelOptions(128) { FullMode = BoundedChannelFullMode.DropOldest, SingleReader = true },
        dropped => dropped.Completion?.TrySetResult(false));
    private static readonly Task Writer = Task.Run(WriteOutput);

    [STAThread]
    private static void Main(string[] args)
    {
        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
        Application.EnableVisualStyles();
        if (args.Contains("--owned-host-fixture")) Application.Run(new OwnedHostFixture());
        else if (args.Contains("--fixture")) Application.Run(new Fixture());
        else
        {
            Console.Error.WriteLine("Choose an explicit fixture mode. DSP attachment is not implemented.");
            Environment.ExitCode = 1;
        }
    }

    internal static void Send(object message) => Outbound.Writer.TryWrite(new Output(JsonSerializer.Serialize(message, Json), null));

    internal static async Task<bool> FlushReply(object message)
    {
        var completion = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        if (!Outbound.Writer.TryWrite(new Output(JsonSerializer.Serialize(message, Json), completion))) return false;
        try { return await completion.Task.WaitAsync(TimeSpan.FromSeconds(4)); }
        catch (TimeoutException) { return false; }
    }

    private static async Task WriteOutput()
    {
        try
        {
            await foreach (var item in Outbound.Reader.ReadAllAsync())
            {
                await Console.Out.WriteLineAsync(item.Text);
                await Console.Out.FlushAsync();
                item.Completion?.TrySetResult(true);
            }
        }
        catch (IOException)
        {
            Outbound.Writer.TryComplete();
            while (Outbound.Reader.TryRead(out var item)) item.Completion?.TrySetResult(false);
        }
    }
}

internal sealed class Fixture : Form
{
    private readonly System.Windows.Forms.Timer timer = new() { Interval = 250 };
    private int clicks, keys;

    internal Fixture()
    {
        Text = "CommandDeck fixture — no game";
        Width = 800; Height = 500; KeyPreview = true;
        BackColor = Color.FromArgb(25, 38, 48);
        MouseDown += (_, _) => { clicks++; Invalidate(); };
        KeyDown += (_, _) => { keys++; Invalidate(); };
        Paint += (_, e) => e.Graphics.DrawString($"DECK UI FIXTURE\nClicks {clicks} / Keys {keys}", Font, Brushes.White, 24, 24);
        Shown += (_, _) =>
        {
            Program.Send(new { type = "ready", pid = Environment.ProcessId, hwnd = Handle.ToInt64().ToString() });
            _ = Task.Run(() => { while (Console.ReadLine() is { } line) if (line == "close") BeginInvoke(Close); });
        };
        timer.Tick += (_, _) => Program.Send(new { type = "fixture", clicks, keys, parent = Win.GetParent(Handle).ToInt64().ToString(), visible = Win.IsWindowVisible(Handle) });
        timer.Start();
        FormClosed += (_, _) => timer.Dispose();
    }
}

internal static class Win
{
    internal const long Child = 0x40000000L, Visible = 0x10000000L, Popup = 0x80000000L, Caption = 0x00C00000L, ThickFrame = 0x00040000L;
    internal const uint NoZOrder = 0x0004, NoActivate = 0x0010, FrameChanged = 0x0020, Show = 0x0040;
    [StructLayout(LayoutKind.Sequential)]
    internal struct Rect { internal int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] internal static extern nint GetParent(nint hwnd);
    [DllImport("user32.dll", SetLastError = true)] internal static extern nint SetParent(nint hwnd, nint parent);
    [DllImport("user32.dll")][return: MarshalAs(UnmanagedType.Bool)] internal static extern bool IsWindow(nint hwnd);
    [DllImport("user32.dll")][return: MarshalAs(UnmanagedType.Bool)] internal static extern bool IsWindowVisible(nint hwnd);
    [DllImport("user32.dll")] internal static extern uint GetDpiForWindow(nint hwnd);
    [DllImport("user32.dll")] internal static extern uint GetWindowThreadProcessId(nint hwnd, out int pid);
    [DllImport("user32.dll")][return: MarshalAs(UnmanagedType.Bool)] internal static extern bool GetWindowRect(nint hwnd, out Rect rect);
    [DllImport("user32.dll", SetLastError = true)][return: MarshalAs(UnmanagedType.Bool)] internal static extern bool SetWindowPos(nint hwnd, nint after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW", SetLastError = true)] private static extern nint GetWindowLong(nint hwnd, int index);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW", SetLastError = true)] private static extern nint SetWindowLong(nint hwnd, int index, nint value);
    [DllImport("gdi32.dll")] internal static extern nint CreateRectRgn(int left, int top, int right, int bottom);
    [DllImport("gdi32.dll")] internal static extern int CombineRgn(nint dest, nint source1, nint source2, int mode);
    [DllImport("gdi32.dll")][return: MarshalAs(UnmanagedType.Bool)] internal static extern bool DeleteObject(nint obj);
    [DllImport("user32.dll")] internal static extern int SetWindowRgn(nint hwnd, nint region, [MarshalAs(UnmanagedType.Bool)] bool redraw);
    [DllImport("user32.dll")] internal static extern nint SendMessage(nint hwnd, uint message, nint wParam, nint lParam);
    internal static int WindowPid(nint hwnd) { GetWindowThreadProcessId(hwnd, out int pid); return pid; }
    internal static long GetStyle(nint hwnd) => GetWindowLong(hwnd, -16).ToInt64();
    internal static long GetExStyle(nint hwnd) => GetWindowLong(hwnd, -20).ToInt64();
    internal static void SetStyle(nint hwnd, long style) => SetWindowLong(hwnd, -16, (nint)style);
    internal static void SetExStyle(nint hwnd, long style) => SetWindowLong(hwnd, -20, (nint)style);
}
