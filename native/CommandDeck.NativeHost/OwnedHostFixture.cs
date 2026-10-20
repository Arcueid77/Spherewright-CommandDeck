using System.Text;
using System.Text.Json.Nodes;

namespace CommandDeck.NativeHost;

// A simulated game process owns BOTH the stable top-level host and its viewport.
// Deck is the disposable foreign child, never the owner of the game window.
internal sealed class OwnedHostFixture : Form
{
    private readonly InputViewport viewport = new() { BackColor = Color.FromArgb(17, 35, 45) };
    private readonly System.Windows.Forms.Timer timer = new() { Interval = 200 };
    private readonly ForeignUi foreign = new();
    private ForeignUi.Binding? ui;
    private Task<object>? adoption, detachment;
    private Task layout = Task.CompletedTask;
    private bool adopting, detaching, closing, allowClose, restoreFailed;
    private long layoutRequested, layoutApplied;
    private string? layoutError;
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
        Resize += (_, _) => { if (!adopting && !detaching) _ = ObserveLayout(); };
        FormClosing += (_, e) => { if (allowClose) return; e.Cancel = true; _ = CloseNormally(); };
        Shown += (_, _) => BeginInvoke(() =>
        {
            Win.ShowWindow(Handle, 5);
            if (!Win.IsWindowVisible(Handle)) throw new InvalidOperationException("FIXTURE_HOST_NOT_VISIBLE");
            Program.Send(new { type = "ready", pid = Environment.ProcessId, hwnd = Handle.ToInt64().ToString(), gameHwnd = viewport.Handle.ToInt64().ToString(), visible = true, mode = "game-owned-host-fixture" });
            _ = Task.Run(ReadRequests);
        });
        timer.Tick += (_, _) =>
        {
            if (ui != null && !ForeignUi.Alive(ui) && !adopting && !detaching && !restoreFailed) _ = RestoreAfterDisconnect("Deck exit");
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
        finally { try { BeginInvoke(() => { connected = false; _ = RestoreAfterDisconnect("bridge disconnect"); }); } catch (InvalidOperationException) { } }
    }
    private static string? ReadLine()
    {
        var text = new StringBuilder();
        while (true) { int value = Console.Read(); if (value < 0) return null; if (value == '\n') return text.ToString(); if (text.Length >= 32768) throw new IOException("FRAME_LIMIT"); if (value != '\r') text.Append((char)value); }
    }
    private async void Request(JsonObject message)
    {
        string id = message["id"] is JsonValue value && value.TryGetValue<string>(out var text) ? text : "";
        try
        {
            if (message["method"]?.GetValue<string>() == "close")
            {
                if (closing) throw new InvalidOperationException("HOST_CLOSE_PENDING");
                closing = true;
                try
                {
                    await DetachUi();
                    if (await Program.FlushReply(new { id, ok = true, result = new { closed = true } }))
                    {
                        allowClose = true; Close();
                    }
                    else closing = false;
                }
                catch { closing = false; throw; }
                return;
            }
            object result = message["method"]?.GetValue<string>() switch
            {
                "adopt" => await AdoptUi(message),
                "rect" => await SetViewport(message),
                "detach" => await DetachUi(),
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
    private async Task CloseNormally()
    {
        if (closing) return;
        closing = true;
        try { await DetachUi(); allowClose = true; Close(); }
        catch { closing = false; Text = "CommandDeck fixture — UI restoration unproven, host retained"; }
    }
    private async Task RestoreAfterDisconnect(string reason)
    {
        try { await DetachUi(); Text = "CommandDeck fixture — game survived " + reason; }
        catch { restoreFailed = true; Text = "CommandDeck fixture — UI restoration unproven, host retained"; }
    }
    private Task<object> AdoptUi(JsonObject message)
    {
        if (ui != null || adopting || detaching || closing || !connected) throw new InvalidOperationException("UI_ADOPTION_BUSY");
        adopting = true;
        return adoption = AdoptCore(message);
    }
    private async Task<object> AdoptCore(JsonObject message)
    {
        try
        {
            nint hwnd = (nint)long.Parse(message["hwnd"]!.GetValue<string>());
            int pid = message["pid"]!.GetValue<int>();
            ui = await foreign.Capture(hwnd, pid);
            if (!connected || closing || detaching) throw new InvalidOperationException("UI_ADOPTION_INTERRUPTED");
            await foreign.Adopt(ui, Handle);
            if (!connected || closing || detaching) throw new InvalidOperationException("UI_ADOPTION_INTERRUPTED");
            viewport.Dock = DockStyle.None;
            await QueueLayout();
            if (!connected || closing || detaching) throw new InvalidOperationException("UI_ADOPTION_INTERRUPTED");
            return Status();
        }
        catch
        {
            if (ui != null)
            {
                try { await foreign.Restore(ui); ClearUi(); }
                catch { layoutError = "UI_RESTORE_UNPROVEN"; throw new InvalidOperationException(layoutError); }
            }
            throw;
        }
        finally { adopting = false; }
    }
    private async Task ObserveLayout()
    {
        try { await QueueLayout(); }
        catch { /* The failed layout stays visible in status; no automatic replay. */ }
    }
    private Task QueueLayout()
    {
        if (ui == null || detaching) return Task.CompletedTask;
        if (layoutError != null) return Task.FromException(new InvalidOperationException(layoutError));
        layoutRequested++;
        // Coalesce resize bursts into the latest desired layout, while retaining the in-flight call.
        if (!layout.IsCompleted) return layout;
        return layout = ApplyLayouts();
    }
    private async Task ApplyLayouts()
    {
        try
        {
            while (ui != null && !detaching && layoutApplied < layoutRequested)
            {
                var binding = ui;
                long revision = layoutRequested;
                var size = ClientSize;
                var hole = Rectangle.Intersect(new Rectangle(Point.Empty, size), requestedViewport);
                bool visible = viewport.Visible;
                await foreign.Layout(binding, Handle, size, hole, visible);
                if (!ReferenceEquals(ui, binding)) return;
                layoutApplied = revision;
            }
        }
        catch (Exception error)
        {
            layoutError = error is InvalidOperationException ? error.Message : "UI_LAYOUT_FAILED";
            throw;
        }
    }
    private async Task<object> SetViewport(JsonObject message)
    {
        double x = message["x"]!.GetValue<double>(), y = message["y"]!.GetValue<double>(), w = message["width"]!.GetValue<double>(), h = message["height"]!.GetValue<double>();
        if (new[] { x, y, w, h }.Any(v => !double.IsFinite(v)) || x < 0 || y < 0 || x > 8192 || y > 8192 || w < 1 || h < 1 || w > 8192 || h > 8192) throw new InvalidOperationException("INVALID_VIEWPORT_RECT");
        if (adopting || detaching || closing) throw new InvalidOperationException("UI_TRANSITION_PENDING");
        if (ui == null) return Status();
        double scale = Win.GetDpiForWindow(Handle) / 96.0;
        requestedViewport = Rectangle.Intersect(new Rectangle(0, 0, ClientSize.Width, ClientSize.Height), new Rectangle((int)Math.Round(x * scale), (int)Math.Round(y * scale), (int)Math.Round(w * scale), (int)Math.Round(h * scale)));
        viewport.Visible = message["visible"]?.GetValue<bool>() == true && requestedViewport.Width > 0 && requestedViewport.Height > 0;
        viewport.Bounds = requestedViewport;
        await QueueLayout();
        return Status();
    }
    private Task<object> DetachUi()
    {
        if (detaching) return detachment!;
        detaching = true;
        return detachment = DetachCore();
    }
    private async Task<object> DetachCore()
    {
        try
        {
            if (adoption != null && !adoption.IsCompleted) { try { await adoption; } catch { } }
            // Drain the old layout before restoring. Late geometry must not touch the detached UI.
            try { await layout; } catch { }
            if (ui != null) await foreign.Restore(ui);
            ClearUi();
            return Status();
        }
        finally { detaching = false; }
    }
    private void ClearUi()
    {
        ui = null;
        layoutRequested = layoutApplied = 0;
        layoutError = null;
        restoreFailed = false;
        viewport.Visible = true; viewport.Dock = DockStyle.Fill; viewport.Invalidate();
    }
    private object Status()
    {
        bool alive = ui != null && ForeignUi.Alive(ui);
        return new
        {
            attached = alive && Win.GetParent(ui!.Hwnd) == Handle,
            nativeParentMatches = alive && Win.GetParent(ui!.Hwnd) == Handle,
            uiChildStyle = alive && (Win.GetStyle(ui!.Hwnd) & Win.Child) != 0 && (Win.GetStyle(ui.Hwnd) & Win.Popup) == 0,
            uiVisible = alive && Win.IsWindowVisible(ui!.Hwnd),
            hostVisible = Win.IsWindowVisible(Handle),
            gameParentMatches = Win.GetParent(viewport.Handle) == Handle,
            gameOwnerPid = Win.WindowPid(viewport.Handle),
            hostOwnerPid = Win.WindowPid(Handle),
            gameAlive = !IsDisposed,
            connected,
            viewportFull = viewport.Dock == DockStyle.Fill,
            uiOperationPending = adopting || detaching || !layout.IsCompleted,
            layoutPending = ui != null && layoutApplied < layoutRequested,
            layoutRequested,
            layoutApplied,
            layoutError,
            restoreFailed,
            clicks,
            keys,
            wheel,
            gameCalls = 0,
            mode = "game-owned-host-fixture",
            kind = "fixture",
            targetPid = Environment.ProcessId
        };
    }
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
    private sealed class InputViewport : Panel
    {
        internal InputViewport() { SetStyle(ControlStyles.Selectable | ControlStyles.OptimizedDoubleBuffer, true); TabStop = true; }
        protected override bool IsInputKey(Keys keyData) => true;
    }
}
