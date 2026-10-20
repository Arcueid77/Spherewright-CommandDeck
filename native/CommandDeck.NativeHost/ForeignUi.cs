using System.Diagnostics;

namespace CommandDeck.NativeHost;

// Calls that can wait on a foreign window always run away from the host UI thread.
// The single gate preserves ordering; an in-flight native call is never cancelled or replayed.
internal sealed class ForeignUi
{
    private readonly SemaphoreSlim gate = new(1, 1);

    private async Task<T> Run<T>(Func<T> action)
    {
        await gate.WaitAsync();
        try { return await Task.Run(action); }
        finally { gate.Release(); }
    }

    internal Task<Binding> Capture(nint hwnd, int pid) => Run(() =>
    {
        using var process = Process.GetProcessById(pid);
        using var current = Process.GetCurrentProcess();
        if (!Win.IsWindow(hwnd) || !Win.IsWindowVisible(hwnd) || Win.WindowPid(hwnd) != pid || process.SessionId != current.SessionId || Win.GetParent(hwnd) != 0)
            throw new InvalidOperationException("INVALID_UI_WINDOW");
        if (!Win.GetWindowRect(hwnd, out var rect)) throw new InvalidOperationException("UI_RECT_UNAVAILABLE");
        var binding = new Binding(hwnd, pid, process.StartTime.ToUniversalTime().Ticks, Win.GetStyle(hwnd), Win.GetExStyle(hwnd), rect,
            "Spherewright.CommandDeck.M0." + Guid.NewGuid().ToString("N"));
        if (!Win.SetProp(hwnd, binding.Property, (nint)1)) throw new InvalidOperationException("UI_IDENTITY_MARK_FAILED");
        return binding;
    });

    private static bool SameProcessWindow(Binding binding)
    {
        try
        {
            using var process = Process.GetProcessById(binding.Pid);
            return Win.IsWindow(binding.Hwnd) && Win.WindowPid(binding.Hwnd) == binding.Pid
                && process.StartTime.ToUniversalTime().Ticks == binding.Started;
        }
        catch { return false; }
    }
    internal static bool Alive(Binding binding) => SameProcessWindow(binding) && Win.GetProp(binding.Hwnd, binding.Property) == (nint)1;

    private static void Require(Binding binding)
    {
        if (!Alive(binding)) throw new InvalidOperationException("UI_WINDOW_IDENTITY_LOST");
    }

    internal Task<bool> Adopt(Binding binding, nint host) => Run(() =>
    {
        Require(binding);
        if (Win.GetParent(binding.Hwnd) != 0 || Win.GetStyle(binding.Hwnd) != binding.Style || Win.GetExStyle(binding.Hwnd) != binding.ExStyle)
            throw new InvalidOperationException("UI_CHANGED_BEFORE_ADOPTION");
        Win.SetStyle(binding.Hwnd, (binding.Style & ~Win.Popup & ~Win.Caption & ~Win.ThickFrame) | Win.Child | Win.Visible);
        _ = Win.SetParent(binding.Hwnd, host);
        Require(binding);
        if (Win.GetParent(binding.Hwnd) != host || (Win.GetStyle(binding.Hwnd) & Win.Child) == 0 || (Win.GetStyle(binding.Hwnd) & Win.Popup) != 0)
            throw new InvalidOperationException("UI_ADOPTION_NOT_PROVEN");
        return true;
    });

    internal Task<bool> Layout(Binding binding, nint host, Size size, Rectangle hole, bool visible) => Run(() =>
    {
        Require(binding);
        if (Win.GetParent(binding.Hwnd) != host) throw new InvalidOperationException("UI_PARENT_CHANGED");
        // Keep this synchronous on the worker: successful submission is not proof of an applied layout.
        if (!Win.SetWindowPos(binding.Hwnd, 0, 0, 0, size.Width, size.Height, Win.NoZOrder | Win.NoActivate | Win.FrameChanged | Win.Show))
            throw new InvalidOperationException("UI_POSITION_FAILED");
        Require(binding);
        if (Win.GetParent(binding.Hwnd) != host || !Win.GetWindowRect(binding.Hwnd, out var rect)
            || rect.Right - rect.Left != size.Width || rect.Bottom - rect.Top != size.Height)
            throw new InvalidOperationException("UI_SIZE_NOT_PROVEN");
        nint outer = Win.CreateRectRgn(0, 0, size.Width, size.Height);
        if (outer == 0) throw new InvalidOperationException("UI_REGION_FAILED");
        if (visible && hole.Width > 0 && hole.Height > 0)
        {
            nint inner = Win.CreateRectRgn(hole.Left, hole.Top, hole.Right, hole.Bottom);
            int combined = Win.CombineRgn(outer, outer, inner, 4);
            if (inner != 0) Win.DeleteObject(inner);
            if (combined == 0) { Win.DeleteObject(outer); throw new InvalidOperationException("VIEWPORT_REGION_FAILED"); }
        }
        if (Win.SetWindowRgn(binding.Hwnd, outer, true) == 0)
        {
            Win.DeleteObject(outer);
            throw new InvalidOperationException("UI_REGION_FAILED");
        }
        Require(binding);
        return true;
    });

    internal Task<bool> Restore(Binding binding) => Run(() =>
    {
        if (!SameProcessWindow(binding)) return false; // The original process/window no longer exists.
        Require(binding); // Missing lifetime marker is not proof of a safe detach.
        if (Win.SetWindowRgn(binding.Hwnd, 0, true) == 0) throw new InvalidOperationException("UI_REGION_RESTORE_FAILED");
        _ = Win.SetParent(binding.Hwnd, 0);
        Win.SetStyle(binding.Hwnd, binding.Style);
        Win.SetExStyle(binding.Hwnd, binding.ExStyle);
        var old = binding.Rect;
        if (!Win.SetWindowPos(binding.Hwnd, 0, old.Left, old.Top, old.Right - old.Left, old.Bottom - old.Top,
            Win.NoActivate | Win.NoZOrder | Win.FrameChanged | ((binding.Style & Win.Visible) != 0 ? Win.Show : 0))) throw new InvalidOperationException("UI_POSITION_RESTORE_FAILED");
        Require(binding);
        if (Win.GetParent(binding.Hwnd) != 0) throw new InvalidOperationException("UI_DETACH_PARENT_NOT_PROVEN");
        if (Win.GetStyle(binding.Hwnd) != binding.Style) throw new InvalidOperationException("UI_DETACH_STYLE_NOT_PROVEN");
        if (Win.GetExStyle(binding.Hwnd) != binding.ExStyle) throw new InvalidOperationException("UI_DETACH_EXSTYLE_NOT_PROVEN");
        if (!Win.GetWindowRect(binding.Hwnd, out var actual) || !actual.Equals(old)) throw new InvalidOperationException("UI_DETACH_RECT_NOT_PROVEN");
        Win.RemoveProp(binding.Hwnd, binding.Property);
        return true;
    });

    internal sealed record Binding(nint Hwnd, int Pid, long Started, long Style, long ExStyle, Win.Rect Rect, string Property);
}
