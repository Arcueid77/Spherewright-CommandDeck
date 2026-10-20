using System.Diagnostics;
using System.Runtime.InteropServices;

namespace CommandDeck.Windowing;

public sealed class ViewportRect
{
    public int X { get; set; }
    public int Y { get; set; }
    public int Width { get; set; }
    public int Height { get; set; }
    public bool Visible { get; set; }
}

public sealed class WindowHostState
{
    public bool Active { get; set; }
    public bool Attached { get; set; }
    public bool GameAlive { get; set; }
    public bool GameParentMatches { get; set; }
    public bool NativeParentMatches { get; set; }
    public bool HostVisible { get; set; }
    public bool UiVisible { get; set; }
    public bool UiThreadHasFocus { get; set; }
    public bool UiOperationPending { get; set; }
    public int TargetPid { get; set; }
    public int Dpi { get; set; }
    public int ClientWidth { get; set; }
    public int ClientHeight { get; set; }
    public long LayoutRequested { get; set; }
    public long LayoutApplied { get; set; }
    public string? Fault { get; set; }
    public string DisplayProfile => "same-monitor-100-percent";
    public int GameCalls => 0;
}

// No Unity/game-world APIs, forms runtime, hooks, process termination or synthetic input.
// The stable parent and game viewport both belong to this process; foreign UI stays replaceable.
public sealed class GameWindowHost
{
    private readonly SemaphoreSlim gate = new(1);
    private readonly object sync = new();
    private readonly Desktop.WindowProc wndProc;
    private readonly TaskCompletionSource<bool> ended = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private WindowSnapshot? game, ui;
    private nint host;
    private nint monitor;
    private Thread? thread;
    private volatile bool closing;
    private readonly LayoutRevisions revisions = new();
    private ViewportRect? desired;
    private string? fault;
    private const uint FinishClose = 0x8001;
    private const uint FocusUi = 0x8002;
    private TaskCompletionSource<WindowHostState>? focusPending;
    private int loopRecoveryQueued;
    private int uiExitQueued, displayStopQueued;
    private bool destroyAuthorized;

    public GameWindowHost() { wndProc = WindowMessage; }
    public static nint FindCurrentUnityWindow() => Desktop.FindOwnUnityWindow();
    public static bool IsCurrentProcessWindow(nint hwnd) => hwnd != 0 && Desktop.IsWindow(hwnd) && Desktop.Pid(hwnd) == Process.GetCurrentProcess().Id;
    public nint HostHandle => host;
    public nint GameHandle => game?.Hwnd ?? 0;
    public Task Completion => ended.Task;
    public void RequestHostClose()
    {
        Desktop.Require(host != 0 && Desktop.PostMessage(host, 0x10, 0, 0), "HOST_CLOSE_NOT_QUEUED");
    }

    public async Task StartAsync(nint gameWindow)
    {
        await gate.WaitAsync().ConfigureAwait(false);
        try
        {
            Desktop.Require(game == null && host == 0 && !closing, "HOST_ALREADY_STARTED");
            monitor = Desktop.MonitorFromWindow(gameWindow, 2);
            Desktop.Require(Desktop.GetDpiForWindow(gameWindow) == 96 && Desktop.IsScale100(monitor), "SCALE_ONE_HUNDRED_REQUIRED");
            game = new WindowSnapshot(gameWindow, Process.GetCurrentProcess().Id);
            var ready = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            thread = new Thread(() => MessageLoop(ready)) { IsBackground = true, Name = "CommandDeck native host" };
            thread.SetApartmentState(ApartmentState.STA);
            thread.Start();
            await ready.Task.ConfigureAwait(false);
            game.Adopt(host);
            LayoutNow();
            Desktop.ShowWindow(host, 5);
            Desktop.Require(Desktop.IsWindowVisible(host), "HOST_NOT_VISIBLE");
        }
        catch
        {
            fault = "HOST_START_FAILED";
            // Keep a live parent on failed restoration; never destroy a parent with the game below it.
            if (game != null && game.SameLifetime())
            {
                game.Restore();
                game = null;
                if (host != 0) Desktop.PostMessage(host, FinishClose, 0, 0);
                else ended.TrySetResult(true); // Startup failed before a parent existed; the game is restored.
            }
            throw;
        }
        finally { gate.Release(); }
    }

    public async Task AdoptUiAsync(nint hwnd, int pid)
    {
        await gate.WaitAsync().ConfigureAwait(false);
        try
        {
            Desktop.Require(!closing && fault == null && host != 0 && game?.SameLifetime() == true, "HOST_NOT_READY");
            Desktop.Require(ui == null && pid != Process.GetCurrentProcess().Id, "FOREIGN_UI_REQUIRED");
            Desktop.Require(Desktop.GetDpiForWindow(hwnd) == Desktop.GetDpiForWindow(host), "MATCHING_DPI_REQUIRED");
            Desktop.Require(Desktop.GetDpiForWindow(host) == 96 && Desktop.MonitorFromWindow(hwnd, 2) == monitor && Desktop.IsScale100(monitor), "SAME_MONITOR_SCALE_ONE_HUNDRED_REQUIRED");
            ui = new WindowSnapshot(hwnd, pid);
            ui.Adopt(host);
            LayoutNow();
            Interlocked.Exchange(ref uiExitQueued, 0);
        }
        catch { fault = "UI_ADOPTION_FAILED"; throw; }
        finally { gate.Release(); }
    }

    public void SetViewport(ViewportRect rect)
    {
        Desktop.Require(rect.Width >= 0 && rect.Height >= 0 && rect.Width <= 16384 && rect.Height <= 16384 &&
            Math.Abs((long)rect.X) <= 16384 && Math.Abs((long)rect.Y) <= 16384, "INVALID_VIEWPORT");
        lock (sync)
        {
            if (closing) return;
            desired = new ViewportRect { X = rect.X, Y = rect.Y, Width = rect.Width, Height = rect.Height, Visible = rect.Visible };
        }
        ScheduleLayout();
    }

    private void ScheduleLayout()
    {
        lock (sync)
        {
            if (closing || fault != null || host == 0 || !revisions.Request()) return;
        }
        _ = Task.Run(async () =>
        {
            await gate.WaitAsync().ConfigureAwait(false);
            try
            {
                while (!closing && fault == null)
                {
                    long revision = revisions.Requested;
                    LayoutNow();
                    if (!revisions.Complete(revision)) return;
                }
                revisions.Fail();
            }
            catch { fault = "LAYOUT_NOT_PROVEN"; revisions.Fail(); }
            finally
            {
                gate.Release();
            }
        });
    }

    private void LayoutNow()
    {
        var currentGame = game;
        Desktop.Require(currentGame?.SameLifetime() == true && Desktop.GetParent(currentGame.Hwnd) == host, "GAME_WINDOW_LIFETIME_LOST");
        Desktop.Require(Desktop.GetClientRect(host, out var client), "HOST_BOUNDS_UNAVAILABLE");
        ViewportRect? rect;
        lock (sync) rect = desired;
        bool hasUi = ui?.SameLifetime() == true;
        int width = client.Right, height = client.Bottom;
        int x = 0, y = 0, w = width, h = height;
        bool cutout = hasUi && rect?.Visible == true && rect.Width > 0 && rect.Height > 0;
        if (cutout)
        {
            x = Math.Max(0, Math.Min(width, rect!.X)); y = Math.Max(0, Math.Min(height, rect.Y));
            w = Math.Min(rect.Width, width - x); h = Math.Min(rect.Height, height - y);
            cutout = w > 0 && h > 0;
        }
        if (hasUi)
        {
            Desktop.Require(Desktop.GetParent(ui!.Hwnd) == host, "UI_PARENT_CHANGED");
            Desktop.Position(ui.Hwnd, 0, 0, width, height, 0, Desktop.FrameChanged | Desktop.NoActivate | Desktop.Show);
            var region = Desktop.CreateRectRgn(0, 0, width, height);
            Desktop.Require(region != 0, "REGION_CREATE_FAILED");
            try
            {
                if (cutout)
                {
                    var hole = Desktop.CreateRectRgn(x, y, x + w, y + h);
                    Desktop.Require(hole != 0, "REGION_CREATE_FAILED");
                    try { Desktop.Require(Desktop.CombineRgn(region, region, hole, 4) != 0, "REGION_SUBTRACT_FAILED"); }
                    finally { Desktop.DeleteObject(hole); }
                }
                Desktop.Require(Desktop.SetWindowRgn(ui.Hwnd, region, true) != 0, "UI_REGION_NOT_APPLIED");
                region = 0; // Windows owns the successful region.
            }
            finally { if (region != 0) Desktop.DeleteObject(region); }
        }
        if (!cutout) { x = y = 0; w = width; h = height; }
        Desktop.Position(currentGame!.Hwnd, x, y, Math.Max(1, w), Math.Max(1, h), (nint)1,
            Desktop.FrameChanged | Desktop.NoActivate | Desktop.Show);
        Desktop.Require(Desktop.GetParent(currentGame.Hwnd) == host, "GAME_PARENT_CHANGED");
    }

    public async Task DetachUiAsync()
    {
        await gate.WaitAsync().ConfigureAwait(false);
        try
        {
            if (ui != null) { ui.Restore(); ui = null; }
            lock (sync) desired = null;
            if (game != null && host != 0) LayoutNow();
            fault = null;
        }
        catch { fault = "UI_RESTORATION_NOT_PROVEN"; throw; }
        finally { gate.Release(); }
    }

    public async Task StopAsync()
    {
        lock (sync) closing = true; // Reject new layouts before waiting for the old one.
        await gate.WaitAsync().ConfigureAwait(false);
        try
        {
            if (ui != null) { ui.Restore(); ui = null; }
            if (game != null)
            {
                var oldGame = game;
                oldGame.Restore();
                Desktop.Require(host == 0 || Desktop.GetParent(oldGame.Hwnd) != host, "GAME_STILL_PARENTED");
                game = null;
            }
            if (host != 0) Desktop.Require(Desktop.PostMessage(host, FinishClose, 0, 0), "HOST_CLOSE_NOT_QUEUED");
            else ended.TrySetResult(true);
        }
        catch { fault = "HOST_RESTORATION_NOT_PROVEN"; throw; }
        finally { gate.Release(); }
        await ended.Task.ConfigureAwait(false);
    }

    public WindowHostState Status()
    {
        var currentGame = game; var currentUi = ui;
        bool gameAlive = currentGame?.SameLifetime() == true;
        bool uiAlive = currentUi?.SameLifetime() == true;
        Desktop.GetClientRect(host, out var client);
        return new WindowHostState
        {
            Active = host != 0 && Desktop.IsWindow(host), GameAlive = gameAlive,
            Attached = uiAlive && Desktop.GetParent(currentUi!.Hwnd) == host,
            GameParentMatches = gameAlive && Desktop.GetParent(currentGame!.Hwnd) == host,
            NativeParentMatches = uiAlive && Desktop.GetParent(currentUi!.Hwnd) == host,
            HostVisible = host != 0 && Desktop.IsWindowVisible(host), UiVisible = uiAlive && Desktop.IsWindowVisible(currentUi!.Hwnd),
            UiThreadHasFocus = uiAlive && Desktop.UiHasFocus(currentUi!.Hwnd, currentUi.Pid),
            UiOperationPending = gate.CurrentCount == 0 || revisions.Running || (currentUi != null && currentUi.ProcessExited()),
            TargetPid = Process.GetCurrentProcess().Id, Dpi = (int)Desktop.GetDpiForWindow(host),
            ClientWidth = client.Right, ClientHeight = client.Bottom,
            LayoutRequested = revisions.Requested, LayoutApplied = revisions.Applied, Fault = fault
        };
    }
    public Task<WindowHostState> FocusUiAsync()
    {
        lock (sync)
        {
            if (closing || host == 0 || ui == null) return Task.FromResult(Status());
            if (focusPending != null) return focusPending.Task;
            focusPending = new TaskCompletionSource<WindowHostState>(TaskCreationOptions.RunContinuationsAsynchronously);
            if (!Desktop.PostMessage(host, FocusUi, 0, 0))
            {
                focusPending.TrySetException(new InvalidOperationException("UI_FOCUS_NOT_QUEUED"));
                var failed = focusPending.Task; focusPending = null; return failed;
            }
            return focusPending.Task;
        }
    }
    internal void RequestQuitForFixture()
    {
        uint owner = Desktop.GetWindowThreadProcessId(host, out int pid);
        Desktop.Require(owner != 0 && pid == Process.GetCurrentProcess().Id && Desktop.PostThreadMessage(owner, 0x12, 0, 0), "FIXTURE_QUIT_NOT_QUEUED");
    }
    private void RecoverMessageLoop(string code)
    {
        fault = code;
        if (Interlocked.Exchange(ref loopRecoveryQueued, 1) != 0) return;
        _ = Task.Run(async () =>
        {
            try { await StopAsync().ConfigureAwait(false); }
            catch { fault = "MESSAGE_LOOP_RESTORATION_NOT_PROVEN"; }
        });
    }

    private void MessageLoop(TaskCompletionSource<bool> ready)
    {
        string name = "Spherewright.CommandDeck.Host." + Guid.NewGuid().ToString("N");
        nint module = Desktop.GetModuleHandle(null);
        nint originalContext = Desktop.SetThreadDpiAwarenessContext(Desktop.GetWindowDpiAwarenessContext(game!.Hwnd));
        var cls = new Desktop.WindowClass { Instance = module, ClassName = name, Proc = wndProc, Background = (nint)5 };
        try
        {
            Desktop.Require(Desktop.RegisterClass(ref cls) != 0, "HOST_CLASS_NOT_REGISTERED");
            var bounds = game!.Bounds;
            host = Desktop.CreateWindowEx(0, name, "Spherewright CommandDeck — native host (close restores game)",
                0x02CF0000, bounds.Left, bounds.Top, bounds.Right - bounds.Left, bounds.Bottom - bounds.Top, 0, 0, module, 0);
            Desktop.Require(host != 0, "HOST_WINDOW_NOT_CREATED");
            Desktop.Require(Desktop.AreDpiAwarenessContextsEqual(Desktop.GetWindowDpiAwarenessContext(host), Desktop.GetWindowDpiAwarenessContext(game.Hwnd)), "GAME_HOST_DPI_CONTEXT_MISMATCH");
            Desktop.Require(Desktop.SetTimer(host, (nuint)1, 250, 0) != 0, "HOST_MONITOR_NOT_CREATED");
        }
        catch
        {
            fault = "HOST_CREATION_FAILED";
            ready.TrySetException(new InvalidOperationException(fault));
            if (host == 0)
            {
                Desktop.UnregisterClass(name, module);
                if (originalContext != 0) Desktop.SetThreadDpiAwarenessContext(originalContext);
                return; // StartAsync restores its still-top-level game and confirms completion.
            }
            RecoverMessageLoop(fault);
        }
        ready.TrySetResult(true);
        // WM_QUIT or a message error cannot end the thread while it still owns either child.
        while (true)
        {
            if (host == 0 && game == null && ui == null) break;
            try
            {
                int code = Desktop.GetMessage(out var message, 0, 0, 0);
                if (code <= 0)
                {
                    if (host == 0 && game == null && ui == null) break;
                    RecoverMessageLoop(code == 0 ? "HOST_UNEXPECTED_QUIT" : "HOST_MESSAGE_READ_FAILED");
                    if (code < 0) Thread.Sleep(10);
                    continue;
                }
                Desktop.TranslateMessage(ref message);
                Desktop.DispatchMessage(ref message);
            }
            catch { RecoverMessageLoop("HOST_MESSAGE_DISPATCH_FAILED"); }
        }
        Desktop.UnregisterClass(name, module);
        if (originalContext != 0) Desktop.SetThreadDpiAwarenessContext(originalContext);
        lock (sync) { focusPending?.TrySetException(new InvalidOperationException("HOST_CLOSED")); focusPending = null; }
        ended.TrySetResult(true); // Both windows restored and the parent actually destroyed.
        GC.KeepAlive(wndProc);
    }

    private nint WindowMessage(nint hwnd, uint message, nint wParam, nint lParam)
    {
        try { return WindowMessageCore(hwnd, message, wParam, lParam); }
        catch
        {
            RecoverMessageLoop("HOST_WINDOW_CALLBACK_FAILED");
            return message == 0x10 || message == FinishClose || message == FocusUi ? 0 : Desktop.DefWindowProc(hwnd, message, wParam, lParam);
        }
    }
    private nint WindowMessageCore(nint hwnd, uint message, nint wParam, nint lParam)
    {
        if (message == 0x10) // WM_CLOSE never reaches DefWindowProc while it owns the game.
        {
            _ = Task.Run(async () => { try { await StopAsync().ConfigureAwait(false); } catch { fault = "HOST_CLOSE_REJECTED"; } });
            return 0;
        }
        if (message == FinishClose)
        {
            if (game == null && ui == null)
            {
                destroyAuthorized = true;
                if (!Desktop.DestroyWindow(hwnd)) { destroyAuthorized = false; fault = "HOST_DESTROY_FAILED"; }
            }
            return 0;
        }
        if (message == FocusUi)
        {
            TaskCompletionSource<WindowHostState>? pending;
            lock (sync) pending = focusPending;
            if (ui?.SameLifetime() == true && Desktop.GetParent(ui.Hwnd) == hwnd) Desktop.SetFocus(ui.Hwnd);
            pending?.TrySetResult(Status());
            lock (sync) { if (ReferenceEquals(focusPending, pending)) focusPending = null; }
            return 0;
        }
        if (message == 0x82 && destroyAuthorized && game == null && ui == null)
        {
            host = 0; Desktop.PostQuitMessage(0);
            return Desktop.DefWindowProc(hwnd, message, wParam, lParam);
        }
        if (message == 5) ScheduleLayout(); // WM_SIZE: queue native work; never wait on another window.
        if (message == 0x113 && !closing && fault == null && ui?.ProcessExited() == true && Interlocked.Exchange(ref uiExitQueued, 1) == 0)
            _ = Task.Run(async () => { try { await DetachUiAsync().ConfigureAwait(false); } catch { fault = "UI_EXIT_RECOVERY_FAILED"; } });
        if (message == 0x2E0 || ((message == 3 || message == 0x47 || message == 0x113) && host != 0 &&
            (Desktop.MonitorFromWindow(host, 2) != monitor || !Desktop.IsScale100(monitor))))
        {
            if (!closing && Interlocked.Exchange(ref displayStopQueued, 1) == 0)
                _ = Task.Run(async () => { try { await StopAsync().ConfigureAwait(false); } catch { fault = "DPI_DETACH_FAILED"; } });
            return 0;
        }
        return Desktop.DefWindowProc(hwnd, message, wParam, lParam);
    }
}
