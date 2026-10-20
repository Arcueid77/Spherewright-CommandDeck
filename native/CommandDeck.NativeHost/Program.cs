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
        if (args.Length == 4 && args[0] == "--inspect-adapter-process")
        {
            Console.WriteLine(JsonSerializer.Serialize(AdapterPipeClient.InspectProcess(int.Parse(args[1]), args[2], args[3]), Json));
            return;
        }
        if (args.Length == 1 && args[0] == "--test-layout-queue")
        {
            LayoutProof.Run().GetAwaiter().GetResult();
            return;
        }
        if (args.Length == 6 && args[0] == "--adapter-client")
        {
            try { AdapterPipeClient.Run(args[1], int.Parse(args[2]), args[3], args[4], args[5]).GetAwaiter().GetResult(); }
            catch (Exception error)
            {
                string code = error is InvalidOperationException && error.Message.All(c => c == '_' || c >= 'A' && c <= 'Z') ? "_" + error.Message : "";
                Console.Error.WriteLine("ADAPTER_TRANSPORT_FAILED" + code); Environment.ExitCode = 1;
            }
            return;
        }
        if (args.Length == 3 && args[0] is "--inspect-ui" or "--probe-ui")
        {
            if (!long.TryParse(args[1], out long handle) || handle <= 0 ||
                !int.TryParse(args[2], out int pid) || pid <= 0)
            {
                Environment.ExitCode = 1;
                return;
            }
            bool sameSession;
            try { using var target = System.Diagnostics.Process.GetProcessById(pid); using var self = System.Diagnostics.Process.GetCurrentProcess(); sameSession = target.SessionId == self.SessionId; }
            catch (Exception error) when (error is ArgumentException or InvalidOperationException or System.ComponentModel.Win32Exception) { sameSession = false; }
            var hwnd = (nint)handle;
            bool exists = sameSession && Win.IsWindow(hwnd);
            bool pidMatches = exists && Win.WindowPid(hwnd) == pid;
            bool? responding = null;
            string probeStatus = "not_probed";
            long probeElapsedMs = 0;
            if (args[0] == "--probe-ui" && pidMatches)
            {
                // Independent inspector thread/queue, exact owned HWND, no broadcast or unbounded wait flag.
                uint thread = Win.GetWindowThreadProcessId(hwnd, out _);
                var clock = System.Diagnostics.Stopwatch.StartNew();
                Marshal.SetLastPInvokeError(0);
                nint delivered = Win.SendMessageTimeout(hwnd, 0, 0, 0, 0x1 | 0x2 | 0x20, 120, out _);
                int error = Marshal.GetLastPInvokeError();
                probeElapsedMs = clock.ElapsedMilliseconds;
                bool identityStable = Win.IsWindow(hwnd) && Win.GetWindowThreadProcessId(hwnd, out int afterPid) == thread && afterPid == pid;
                probeStatus = !identityStable ? "identity_changed" : delivered != 0 ? "responsive" : error == 1460 ? "timeout" : "unknown";
                responding = probeStatus == "responsive" ? true : probeStatus == "timeout" ? false : null;
            }
            else if (args[0] == "--probe-ui") probeStatus = sameSession ? "identity_changed" : "identity_unavailable";
            // Read only the exact registered UI window. This mode never creates or mutates a window.
            Console.WriteLine(JsonSerializer.Serialize(new
            {
                exists,
                pidMatches,
                responding,
                probeStatus,
                probeElapsedMs,
                visible = pidMatches && Win.IsWindowVisible(hwnd),
                childStyle = pidMatches && (Win.GetStyle(hwnd) & Win.Child) != 0,
                parentPresent = pidMatches && Win.GetParent(hwnd) != 0
            }, Json));
            return;
        }
        Console.WriteLine("{\"type\":\"fixture-startup\",\"phase\":\"main-entered\"}");
        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
        Application.EnableVisualStyles();
        Console.WriteLine("{\"type\":\"fixture-startup\",\"phase\":\"forms-initialized\"}");
        if (args.Contains("--adapter-pipe-fixture")) Application.Run(new AdapterFixture(true));
        else if (args.Contains("--unity-adapter-fixture")) Application.Run(new AdapterFixture());
        else if (args.Contains("--owned-host-fixture")) Application.Run(new OwnedHostFixture());
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
    private long originalStyle, originalExStyle;
    private Win.Rect originalRect;
    private long frameSequence;

    internal Fixture()
    {
        Text = "CommandDeck fixture — no game";
        Width = 800; Height = 500; KeyPreview = true;
        BackColor = Color.FromArgb(25, 38, 48);
        MouseDown += (_, _) => { clicks++; Invalidate(); };
        KeyDown += (_, _) => { keys++; Invalidate(); };
        Paint += (_, e) => e.Graphics.DrawString($"DECK UI FIXTURE\nClicks {clicks} / Keys {keys}", Font, Brushes.White, 24, 24);
        Shown += (_, _) => BeginInvoke(() =>
        {
            // Explicitly show the fixture GUI before readiness, even after a hidden launch.
            Win.ShowWindow(Handle, 5);
            if (!Win.IsWindowVisible(Handle)) throw new InvalidOperationException("FIXTURE_UI_NOT_VISIBLE");
            originalStyle = Win.GetStyle(Handle); originalExStyle = Win.GetExStyle(Handle);
            Win.GetWindowRect(Handle, out originalRect);
            Program.Send(new { type = "ready", pid = Environment.ProcessId, hwnd = Handle.ToInt64().ToString(), visible = true });
            _ = Task.Run(() =>
            {
                while (Console.ReadLine() is { } line)
                {
                    if (line == "close") BeginInvoke(Close);
                    else if (line is "hang-ui" or "focus-and-hang-ui" or "focus-and-hang-ui-long") BeginInvoke(() =>
                    {
                        bool requireFocus = line != "hang-ui";
                        int durationMs = line == "focus-and-hang-ui-long" ? 5000 : 2000;
                        if (requireFocus) Win.SetFocus(Handle); // Only this fixture's own HWND/thread.
                        Program.Send(new
                        {
                            type = "fixture-diagnostic",
                            phase = "ui-hang-start",
                            focused = Win.GetFocus() == Handle,
                            durationMs,
                            clockFrequency = System.Diagnostics.Stopwatch.Frequency,
                            ticks = System.Diagnostics.Stopwatch.GetTimestamp().ToString()
                        });
                        Thread.Sleep(durationMs); // Bounded hang injection only in our disposable UI fixture.
                        Program.Send(new { type = "fixture-diagnostic", phase = "ui-hang-end", ticks = System.Diagnostics.Stopwatch.GetTimestamp().ToString() });
                    });
                    else if (line == "pump-ui") BeginInvoke(() =>
                    {
                        Program.Send(new { type = "fixture-diagnostic", phase = "native-pump-start" });
                        var clock = System.Diagnostics.Stopwatch.StartNew();
                        while (clock.ElapsedMilliseconds < 2500) { Application.DoEvents(); Thread.Sleep(5); }
                        Program.Send(new { type = "fixture-diagnostic", phase = "native-pump-end" });
                    });
                }
            });
        });
        timer.Tick += (_, _) =>
        {
            frameSequence++;
            Win.GetWindowRect(Handle, out var currentRect);
            Program.Send(new
            {
                type = "fixture",
                frameSequence,
                clicks,
                keys,
                parent = Win.GetParent(Handle).ToInt64().ToString(),
                visible = Win.IsWindowVisible(Handle),
                styleRestored = Win.GetStyle(Handle) == originalStyle,
                exStyleRestored = Win.GetExStyle(Handle) == originalExStyle,
                boundsRestored = currentRect.Equals(originalRect)
                ,
                windowWidth = currentRect.Right - currentRect.Left,
                windowHeight = currentRect.Bottom - currentRect.Top
            });
        };
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
    [DllImport("user32.dll")] internal static extern nint GetFocus();
    [DllImport("user32.dll")] internal static extern nint SetFocus(nint hwnd);
    [StructLayout(LayoutKind.Sequential)]
    private struct GuiThreadInfo { internal uint Size, Flags; internal nint Active, Focus, Capture, MenuOwner, MoveSize, Caret; internal Rect CaretRect; }
    [DllImport("user32.dll")][return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetGUIThreadInfo(uint threadId, ref GuiThreadInfo info);
    [DllImport("user32.dll")][return: MarshalAs(UnmanagedType.Bool)] private static extern bool IsChild(nint parent, nint child);
    internal static object FocusSnapshot(nint hwnd)
    {
        uint threadId = GetWindowThreadProcessId(hwnd, out int pid);
        var info = new GuiThreadInfo { Size = (uint)Marshal.SizeOf<GuiThreadInfo>() };
        bool available = GetGUIThreadInfo(threadId, ref info);
        return new { available, focusPresent = info.Focus != 0, focusIsUi = info.Focus == hwnd,
            focusIsUiDescendant = info.Focus != 0 && IsChild(hwnd, info.Focus), focusOwnerIsUi = info.Focus != 0 && WindowPid(info.Focus) == pid,
            activeIsUi = info.Active == hwnd };
    }
    internal static bool ThreadFocusInProcess(nint hwnd, int pid)
    {
        uint threadId = GetWindowThreadProcessId(hwnd, out _);
        var info = new GuiThreadInfo { Size = (uint)Marshal.SizeOf<GuiThreadInfo>() };
        return threadId != 0 && GetGUIThreadInfo(threadId, ref info) && info.Focus != 0 && WindowPid(info.Focus) == pid;
    }
    [DllImport("user32.dll")][return: MarshalAs(UnmanagedType.Bool)] internal static extern bool ShowWindow(nint hwnd, int command);
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
    [DllImport("user32.dll", EntryPoint = "SendMessageTimeoutW", SetLastError = true)] internal static extern nint SendMessageTimeout(nint hwnd, uint message, nint wParam, nint lParam, uint flags, uint timeout, out nuint result);
    [DllImport("user32.dll", EntryPoint = "SetPropW", CharSet = CharSet.Unicode, SetLastError = true)][return: MarshalAs(UnmanagedType.Bool)] internal static extern bool SetProp(nint hwnd, string name, nint value);
    [DllImport("user32.dll", EntryPoint = "GetPropW", CharSet = CharSet.Unicode)] internal static extern nint GetProp(nint hwnd, string name);
    [DllImport("user32.dll", EntryPoint = "RemovePropW", CharSet = CharSet.Unicode)] internal static extern nint RemoveProp(nint hwnd, string name);
    internal static int WindowPid(nint hwnd) { GetWindowThreadProcessId(hwnd, out int pid); return pid; }
    internal static long GetStyle(nint hwnd) => GetWindowLong(hwnd, -16).ToInt64();
    internal static long GetExStyle(nint hwnd) => GetWindowLong(hwnd, -20).ToInt64();
    internal static void SetStyle(nint hwnd, long style) => SetWindowLong(hwnd, -16, (nint)style);
    internal static void SetExStyle(nint hwnd, long style) => SetWindowLong(hwnd, -20, (nint)style);
}
