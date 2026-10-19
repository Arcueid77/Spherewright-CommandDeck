using System.Diagnostics;
using System.Text;
using System.Text.Json.Nodes;

namespace CommandDeck.NativeHost;

// A simulated game process owns BOTH the stable top-level host and its viewport.
// Deck is the disposable foreign child, never the owner of the game window.
internal sealed class OwnedHostFixture : Form
{
    private readonly InputViewport viewport = new() { BackColor = Color.FromArgb(17, 35, 45) };
    private readonly System.Windows.Forms.Timer timer = new() { Interval = 200 };
    private UiBinding? ui;
    private bool connected = true;
    private int clicks, keys, wheel;
    private Point lastMouse;
    private Point pan;
    private bool dragging;
    private Rectangle requestedViewport;
    internal OwnedHostFixture()
    {
        Text = "CommandDeck game-owned host fixture — NO DSP"; Width = 1440; Height = 940;
        Controls.Add(viewport); viewport.Dock = DockStyle.Fill;
        viewport.Paint += PaintGame;
        viewport.MouseDown += (_, e) => { clicks++; lastMouse = e.Location; viewport.Focus(); dragging = true; viewport.Capture = true; viewport.Invalidate(); };
        viewport.MouseUp += (_, _) => { dragging = false; viewport.Capture = false; };
        viewport.MouseCaptureChanged += (_, _) => { if (!viewport.Capture) dragging = false; };
        viewport.MouseMove += (_, e) => { if (dragging) { pan.Offset(e.X - lastMouse.X, e.Y - lastMouse.Y); lastMouse = e.Location; viewport.Invalidate(); } };
        viewport.MouseWheel += (_, e) => { wheel += e.Delta / 120; viewport.Invalidate(); };
        viewport.KeyDown += (_, _) => { keys++; viewport.Invalidate(); };
        Resize += (_, _) => FitUi();
        FormClosing += (_, e) => { try { DetachUi(); } catch { e.Cancel = true; } };
        Shown += (_, _) => { Program.Send(new { type = "ready", pid = Environment.ProcessId, hwnd = Handle.ToInt64().ToString(), gameHwnd = viewport.Handle.ToInt64().ToString(), mode = "game-owned-host-fixture" }); _ = Task.Run(ReadRequests); };
        timer.Tick += (_, _) =>
        {
            if (ui != null && !UiAlive()) { DetachUi(); Text = "CommandDeck fixture — game survived Deck exit"; }
            Program.Send(new { type = "fixture", state = Status() });
        };
        timer.Start();
        FormClosed += (_, _) => timer.Dispose();
    }
    private void PaintGame(object? sender, PaintEventArgs e)
    {
        e.Graphics.Clear(viewport.BackColor);
        using var grid = new Pen(Color.FromArgb(35, 65, 75));
        for (int x = pan.X % 40; x < viewport.Width; x += 40) e.Graphics.DrawLine(grid, x, 0, x, viewport.Height);
        for (int y = pan.Y % 40; y < viewport.Height; y += 40) e.Graphics.DrawLine(grid, 0, y, viewport.Width, y);
        using var title = new Font("Segoe UI", 21);
        using var details = new Font("Segoe UI", 12);
        e.Graphics.DrawString("GAME-OWNED NATIVE VIEWPORT", title, Brushes.Wheat, 24, 28);
        e.Graphics.DrawString($"Fixture only — no DSP / no video capture\n\nClicks {clicks}     Keys {keys}     Wheel {wheel}\nDrag to move the native grid.\nGame process PID: {Environment.ProcessId}", details, Brushes.LightSteelBlue, 26, 80);
    }
    private void ReadRequests()
    {
        try
        {
            while (ReadLine() is { } line)
            {
                JsonObject message;
                try { message = JsonNode.Parse(line) as JsonObject ?? throw new InvalidDataException(); }
                catch { break; }
                BeginInvoke(() => Request(message));
            }
        }
        catch (IOException) { }
        finally { try { BeginInvoke(() => { connected = false; DetachUi(); Text = "CommandDeck fixture — game survived bridge disconnect"; }); } catch (InvalidOperationException) { } }
    }
    private static string? ReadLine()
    {
        var text = new StringBuilder();
        while (true) { int value = Console.Read(); if (value < 0) return null; if (value == '\n') return text.ToString(); if (text.Length >= 32768) throw new IOException("FRAME_LIMIT"); if (value != '\r') text.Append((char)value); }
    }
    private void Request(JsonObject message)
    {
        string id = message["id"]?.GetValue<string>() ?? "";
        try
        {
            if (message["method"]?.GetValue<string>() == "close")
            {
                DetachUi(); _ = CloseAfterReply(id); return;
            }
            object result = message["method"]?.GetValue<string>() switch
            {
                "adopt" => AdoptUi(message),
                "rect" => SetViewport(message),
                "detach" => DetachUi(),
                "status" => Status(),
                "exercise-input" => ExerciseFixtureInput(),
                "exercise-backpressure" => ExerciseFixtureBackpressure(),
                "exercise-host-resize" => ExerciseHostResize(),
                _ => throw new InvalidOperationException("UNKNOWN_FIXTURE_METHOD")
            };
            Program.Send(new { id, ok = true, result });
        }
        catch (Exception error) { Program.Send(new { id, ok = false, code = error is InvalidOperationException ? error.Message : "FIXTURE_OPERATION_FAILED" }); }
    }
    private async Task CloseAfterReply(string id)
    {
        if (await Program.FlushReply(new { id, ok = true, result = new { closed = true } }))
        {
            try { BeginInvoke(Close); } catch (InvalidOperationException) { }
        }
    }
    private object AdoptUi(JsonObject message)
    {
        if (ui != null) throw new InvalidOperationException("UI_ALREADY_ADOPTED");
        nint hwnd = (nint)long.Parse(message["hwnd"]!.GetValue<string>()); int pid = message["pid"]!.GetValue<int>();
        using var process = Process.GetProcessById(pid);
        if (!Win.IsWindow(hwnd) || Win.WindowPid(hwnd) != pid || process.SessionId != Process.GetCurrentProcess().SessionId || Win.GetParent(hwnd) != 0) throw new InvalidOperationException("INVALID_UI_WINDOW");
        Win.GetWindowRect(hwnd, out var rect);
        ui = new UiBinding(hwnd, pid, process.StartTime.ToUniversalTime().Ticks, Win.GetStyle(hwnd), Win.GetExStyle(hwnd), rect);
        Win.SetStyle(hwnd, (ui.Style & ~Win.Popup & ~Win.Caption & ~Win.ThickFrame) | Win.Child | Win.Visible);
        _ = Win.SetParent(hwnd, Handle);
        if (Win.GetParent(hwnd) != Handle || (Win.GetStyle(hwnd) & Win.Child) == 0 || (Win.GetStyle(hwnd) & Win.Popup) != 0) { DetachUi(); throw new InvalidOperationException("UI_ADOPTION_NOT_PROVEN"); }
        viewport.Dock = DockStyle.None; FitUi(); Activate();
        return Status();
    }
    private bool UiAlive()
    {
        try { using var process = Process.GetProcessById(ui!.Pid); return Win.IsWindow(ui.Hwnd) && Win.WindowPid(ui.Hwnd) == ui.Pid && process.StartTime.ToUniversalTime().Ticks == ui.Started; }
        catch { return false; }
    }
    private void FitUi()
    {
        if (ui == null || !UiAlive()) return;
        Win.SetWindowPos(ui.Hwnd, 0, 0, 0, ClientSize.Width, ClientSize.Height, Win.NoZOrder | Win.NoActivate | Win.FrameChanged | Win.Show);
        ApplyHole();
    }
    private object SetViewport(JsonObject message)
    {
        double x = message["x"]!.GetValue<double>(), y = message["y"]!.GetValue<double>(), w = message["width"]!.GetValue<double>(), h = message["height"]!.GetValue<double>();
        if (new[] { x, y, w, h }.Any(v => !double.IsFinite(v)) || x < 0 || y < 0 || w < 1 || h < 1 || w > 8192 || h > 8192) throw new InvalidOperationException("INVALID_VIEWPORT_RECT");
        if (ui == null) return Status();
        double scale = Win.GetDpiForWindow(Handle) / 96.0;
        requestedViewport = Rectangle.Intersect(new Rectangle(0, 0, ClientSize.Width, ClientSize.Height), new Rectangle((int)Math.Round(x * scale), (int)Math.Round(y * scale), (int)Math.Round(w * scale), (int)Math.Round(h * scale)));
        viewport.Visible = message["visible"]?.GetValue<bool>() == true && requestedViewport.Width > 0 && requestedViewport.Height > 0;
        viewport.Bounds = requestedViewport; ApplyHole(); return Status();
    }
    private void ApplyHole()
    {
        if (ui == null || !UiAlive()) return;
        nint outer = Win.CreateRectRgn(0, 0, ClientSize.Width, ClientSize.Height);
        if (viewport.Visible && requestedViewport.Width > 0 && requestedViewport.Height > 0)
        {
            nint hole = Win.CreateRectRgn(requestedViewport.Left, requestedViewport.Top, requestedViewport.Right, requestedViewport.Bottom);
            int combined = Win.CombineRgn(outer, outer, hole, 4); Win.DeleteObject(hole);
            if (combined == 0) { Win.DeleteObject(outer); throw new InvalidOperationException("VIEWPORT_REGION_FAILED"); }
        }
        if (Win.SetWindowRgn(ui.Hwnd, outer, true) == 0) { Win.DeleteObject(outer); throw new InvalidOperationException("UI_REGION_FAILED"); }
    }
    private object DetachUi()
    {
        var saved = ui;
        if (saved != null && UiAlive())
        {
            Win.SetWindowRgn(saved.Hwnd, 0, true); _ = Win.SetParent(saved.Hwnd, 0);
            Win.SetStyle(saved.Hwnd, saved.Style); Win.SetExStyle(saved.Hwnd, saved.ExStyle);
            if (Win.GetParent(saved.Hwnd) != 0) throw new InvalidOperationException("UI_DETACH_NOT_PROVEN");
            Win.SetWindowPos(saved.Hwnd, 0, saved.Rect.Left, saved.Rect.Top, saved.Rect.Right - saved.Rect.Left, saved.Rect.Bottom - saved.Rect.Top, Win.NoActivate | Win.NoZOrder | Win.FrameChanged | Win.Show);
        }
        ui = null; viewport.Visible = true; viewport.Dock = DockStyle.Fill; viewport.Invalidate(); return Status();
    }
    private object Status() => new { attached = ui != null && UiAlive(), nativeParentMatches = ui != null && Win.GetParent(ui.Hwnd) == Handle, uiChildStyle = ui != null && (Win.GetStyle(ui.Hwnd) & Win.Child) != 0 && (Win.GetStyle(ui.Hwnd) & Win.Popup) == 0, gameParentMatches = Win.GetParent(viewport.Handle) == Handle, gameOwnerPid = Win.WindowPid(viewport.Handle), hostOwnerPid = Win.WindowPid(Handle), gameAlive = !IsDisposed, connected, viewportFull = viewport.Dock == DockStyle.Fill, clicks, keys, wheel, gameCalls = 0, mode = "game-owned-host-fixture", kind = "fixture", targetPid = Environment.ProcessId };
    private object ExerciseFixtureInput()
    {
        // Test-only messages to this simulator's own control. Never target DSP or a foreign HWND.
        if (Win.WindowPid(viewport.Handle) != Environment.ProcessId) throw new InvalidOperationException("FIXTURE_INPUT_OWNERSHIP_FAILED");
        static nint At(int x, int y) => (nint)((y << 16) | x);
        Win.SendMessage(viewport.Handle, 0x0201, 1, At(50, 50));
        Win.SendMessage(viewport.Handle, 0x0200, 1, At(80, 70));
        Win.SendMessage(viewport.Handle, 0x0202, 0, At(80, 70));
        Win.SendMessage(viewport.Handle, 0x020A, (nint)(120 << 16), At(80, 70));
        Win.SendMessage(viewport.Handle, 0x0100, (nint)Keys.A, 0);
        Win.SendMessage(viewport.Handle, 0x0101, (nint)Keys.A, 0);
        return new { clicks, keys, wheel, panX = pan.X, panY = pan.Y, syntheticInput = true, gameCalls = 0 };
    }
    private object ExerciseFixtureBackpressure()
    {
        // Only our simulator emits this bounded burst. It carries no game-action receipts.
        string padding = new('x', 8192);
        for (int i = 0; i < 512; i++) Program.Send(new { type = "synthetic-telemetry", padding });
        return new { processedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), fixtureOnly = true };
    }
    private object ExerciseHostResize()
    {
        ClientSize = new Size(ClientSize.Width - 1, ClientSize.Height - 1);
        return new { fixtureOnly = true };
    }
    private sealed record UiBinding(nint Hwnd, int Pid, long Started, long Style, long ExStyle, Win.Rect Rect);
    private sealed class InputViewport : Panel
    {
        internal InputViewport() { SetStyle(ControlStyles.Selectable | ControlStyles.OptimizedDoubleBuffer, true); TabStop = true; }
        protected override bool IsInputKey(Keys keyData) => true;
    }
}
