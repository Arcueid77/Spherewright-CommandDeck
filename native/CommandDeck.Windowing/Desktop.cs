using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace CommandDeck.Windowing;

internal static class Desktop
{
    internal const long Child = 0x40000000, Popup = 0x80000000, Caption = 0xC00000, ThickFrame = 0x40000;
    internal const uint FrameChanged = 0x20, NoActivate = 0x10, NoZOrder = 4, Show = 0x40;
    internal delegate nint WindowProc(nint hwnd, uint message, nint wParam, nint lParam);
    internal delegate bool EnumProc(nint hwnd, nint data);
    [StructLayout(LayoutKind.Sequential)] internal struct Rect { internal int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    internal struct WindowClass
    {
        internal uint Style;
        internal WindowProc Proc;
        internal int ClassExtra, WindowExtra;
        internal nint Instance, Icon, Cursor, Background;
        internal string? MenuName;
        internal string ClassName;
    }
    [StructLayout(LayoutKind.Sequential)] internal struct Point { internal int X, Y; }
    [StructLayout(LayoutKind.Sequential)] internal struct Message { internal nint Hwnd; internal uint Id; internal nuint WParam; internal nint LParam; internal uint Time; internal Point Point; }
    [StructLayout(LayoutKind.Sequential)] internal struct Placement { internal int Length, Flags, Show; internal Point Min, Max; internal Rect Normal; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] internal static extern nint GetModuleHandle(string? name);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool ProcessIdToSessionId(uint pid, out uint session);
    internal static bool InCurrentSession(int pid)
    {
        if (pid <= 0 || !ProcessIdToSessionId((uint)pid, out uint target) ||
            !ProcessIdToSessionId((uint)Process.GetCurrentProcess().Id, out uint current))
            throw new InvalidOperationException("PROCESS_SESSION_UNAVAILABLE");
        return target == current;
    }
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern ushort RegisterClass(ref WindowClass value);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern bool UnregisterClass(string name, nint instance);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern nint CreateWindowEx(uint exStyle, string className, string title, uint style, int x, int y, int width, int height, nint parent, nint menu, nint instance, nint data);
    [DllImport("user32.dll")] internal static extern nint DefWindowProc(nint hwnd, uint message, nint wParam, nint lParam);
    [DllImport("user32.dll")] internal static extern int GetMessage(out Message message, nint hwnd, uint minimum, uint maximum);
    [DllImport("user32.dll")] internal static extern bool TranslateMessage(ref Message message);
    [DllImport("user32.dll")] internal static extern nint DispatchMessage(ref Message message);
    [DllImport("user32.dll")] internal static extern void PostQuitMessage(int code);
    [DllImport("user32.dll")] internal static extern bool PostMessage(nint hwnd, uint message, nint wParam, nint lParam);
    [DllImport("user32.dll")] internal static extern bool PostThreadMessage(uint thread, uint message, nint wParam, nint lParam);
    [DllImport("user32.dll")] internal static extern bool DestroyWindow(nint hwnd);
    [DllImport("user32.dll")] internal static extern nuint SetTimer(nint hwnd, nuint id, uint milliseconds, nint callback);
    [DllImport("user32.dll")] internal static extern bool IsWindow(nint hwnd);
    [DllImport("user32.dll")] internal static extern bool IsWindowVisible(nint hwnd);
    [DllImport("user32.dll")] internal static extern bool ShowWindow(nint hwnd, int command);
    [DllImport("user32.dll")] internal static extern nint GetParent(nint hwnd);
    [DllImport("user32.dll", SetLastError = true)] internal static extern nint SetParent(nint hwnd, nint parent);
    [DllImport("user32.dll")] internal static extern bool GetClientRect(nint hwnd, out Rect rect);
    [DllImport("user32.dll")] internal static extern bool GetWindowRect(nint hwnd, out Rect rect);
    [DllImport("user32.dll")] internal static extern uint GetWindowThreadProcessId(nint hwnd, out int pid);
    [DllImport("user32.dll")] internal static extern uint GetDpiForWindow(nint hwnd);
    [DllImport("user32.dll")] internal static extern nint GetWindowDpiAwarenessContext(nint hwnd);
    [DllImport("user32.dll")] internal static extern nint SetThreadDpiAwarenessContext(nint context);
    [DllImport("user32.dll")] internal static extern bool AreDpiAwarenessContextsEqual(nint a, nint b);
    [DllImport("user32.dll")] internal static extern nint MonitorFromWindow(nint hwnd, uint flags);
    [DllImport("shcore.dll")] private static extern int GetScaleFactorForMonitor(nint monitor, out int scale);
    internal static bool IsScale100(nint monitor) => monitor != 0 && GetScaleFactorForMonitor(monitor, out int scale) == 0 && scale == 100;
    [DllImport("user32.dll")] internal static extern nint SetFocus(nint hwnd);
    [StructLayout(LayoutKind.Sequential)]
    internal struct GuiInfo { internal uint Size, Flags; internal nint Active, Focus, Capture, Menu, MoveSize, Caret; internal Rect CaretRect; }
    [DllImport("user32.dll")] internal static extern bool GetGUIThreadInfo(uint thread, ref GuiInfo info);
    [DllImport("user32.dll", SetLastError = true)] internal static extern bool SetWindowPos(nint hwnd, nint after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll", SetLastError = true)] internal static extern bool GetWindowPlacement(nint hwnd, ref Placement placement);
    [DllImport("user32.dll", SetLastError = true)] internal static extern bool SetWindowPlacement(nint hwnd, ref Placement placement);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] internal static extern nint GetLong(nint hwnd, int index);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW", SetLastError = true)] internal static extern nint SetLong(nint hwnd, int index, nint value);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern bool SetProp(nint hwnd, string name, nint value);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern nint GetProp(nint hwnd, string name);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern nint RemoveProp(nint hwnd, string name);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern int GetClassName(nint hwnd, StringBuilder name, int capacity);
    [DllImport("user32.dll")] internal static extern bool EnumWindows(EnumProc callback, nint data);
    [DllImport("gdi32.dll")] internal static extern nint CreateRectRgn(int left, int top, int right, int bottom);
    [DllImport("gdi32.dll")] internal static extern int CombineRgn(nint destination, nint a, nint b, int mode);
    [DllImport("gdi32.dll")] internal static extern bool DeleteObject(nint value);
    [DllImport("user32.dll")] internal static extern int SetWindowRgn(nint hwnd, nint region, bool redraw);
    [DllImport("user32.dll")] internal static extern int GetWindowRgn(nint hwnd, nint region);
    internal static int Pid(nint hwnd) { GetWindowThreadProcessId(hwnd, out int pid); return pid; }
    internal static bool UiHasFocus(nint hwnd, int pid)
    {
        uint thread = GetWindowThreadProcessId(hwnd, out _);
        var info = new GuiInfo { Size = (uint)Marshal.SizeOf(typeof(GuiInfo)) };
        return thread != 0 && GetGUIThreadInfo(thread, ref info) && info.Focus != 0 && Pid(info.Focus) == pid;
    }
    internal static void Require(bool condition, string code) { if (!condition) throw new InvalidOperationException(code); }
    internal static void SetStyle(nint hwnd, int index, long value)
    {
        SetLong(hwnd, index, (nint)value);
        Require((long)GetLong(hwnd, index) == value, "WINDOW_STYLE_NOT_APPLIED");
    }
    internal static void Position(nint hwnd, int x, int y, int width, int height, nint after, uint flags)
    {
        if (!SetWindowPos(hwnd, after, x, y, width, height, flags)) throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    internal static nint FindOwnUnityWindow()
    {
        var found = new List<nint>();
        int pid = Process.GetCurrentProcess().Id;
        EnumWindows((hwnd, _) =>
        {
            if (Pid(hwnd) != pid || GetParent(hwnd) != 0 || !IsWindowVisible(hwnd)) return true;
            var name = new StringBuilder(128);
            GetClassName(hwnd, name, name.Capacity);
            if (name.ToString() == "UnityWndClass") found.Add(hwnd);
            return true;
        }, 0);
        return found.Count == 1 ? found[0] : 0;
    }
}

internal sealed class WindowSnapshot
{
    internal readonly nint Hwnd, Parent;
    internal readonly int Pid;
    internal readonly long Started, Style, ExStyle;
    internal readonly Desktop.Rect Bounds;
    internal Desktop.Placement Placement;
    private readonly string marker = "Spherewright.CommandDeck." + Guid.NewGuid().ToString("N");
    private readonly nint markerValue = (nint)1;
    internal WindowSnapshot(nint hwnd, int pid)
    {
        Desktop.Require(pid > 0 && Desktop.IsWindow(hwnd) && Desktop.Pid(hwnd) == pid, "WINDOW_IDENTITY_MISMATCH");
        using (var process = Process.GetProcessById(pid))
        {
            Desktop.Require(Desktop.InCurrentSession(pid), "WINDOW_SESSION_MISMATCH");
            Started = process.StartTime.ToUniversalTime().Ticks;
        }
        Hwnd = hwnd; Pid = pid; Parent = Desktop.GetParent(hwnd);
        Style = (long)Desktop.GetLong(hwnd, -16); ExStyle = (long)Desktop.GetLong(hwnd, -20);
        Desktop.Require(Parent == 0 && (Style & Desktop.Child) == 0 && Desktop.IsWindowVisible(hwnd), "VISIBLE_TOP_LEVEL_REQUIRED");
        Desktop.Require(Desktop.GetWindowRect(hwnd, out Bounds), "WINDOW_BOUNDS_UNAVAILABLE");
        Placement = new Desktop.Placement { Length = Marshal.SizeOf(typeof(Desktop.Placement)) };
        Desktop.Require(Desktop.GetWindowPlacement(hwnd, ref Placement) && Placement.Show != 2, "WINDOW_PLACEMENT_UNAVAILABLE");
        var region = Desktop.CreateRectRgn(0, 0, 0, 0);
        Desktop.Require(region != 0, "REGION_CREATE_FAILED");
        try { Desktop.Require(Desktop.GetWindowRgn(hwnd, region) == 0, "EXISTING_WINDOW_REGION_UNSUPPORTED"); }
        finally { Desktop.DeleteObject(region); }
        Desktop.Require(Desktop.SetProp(hwnd, marker, markerValue), "WINDOW_LIFETIME_GUARD_FAILED");
    }
    internal bool SameLifetime()
    {
        if (!Desktop.IsWindow(Hwnd) || Desktop.Pid(Hwnd) != Pid || Desktop.GetProp(Hwnd, marker) != markerValue) return false;
        try { using (var process = Process.GetProcessById(Pid)) return process.StartTime.ToUniversalTime().Ticks == Started; }
        catch (ArgumentException) { return false; }
    }
    internal bool ProcessExited()
    {
        try { using (var process = Process.GetProcessById(Pid)) return process.HasExited || process.StartTime.ToUniversalTime().Ticks != Started; }
        catch (ArgumentException) { return true; }
    }
    internal void Adopt(nint parent)
    {
        Desktop.Require(SameLifetime(), "WINDOW_LIFETIME_LOST");
        Desktop.SetStyle(Hwnd, -16, (Style | Desktop.Child) & ~(Desktop.Popup | Desktop.Caption | Desktop.ThickFrame));
        Desktop.SetParent(Hwnd, parent);
        Desktop.Require(Desktop.GetParent(Hwnd) == parent && SameLifetime(), "WINDOW_PARENT_NOT_APPLIED");
    }
    internal void Restore()
    {
        if (ProcessExited()) return;
        Desktop.Require(SameLifetime(), "WINDOW_LIFETIME_LOST");
        Desktop.Require(Desktop.SetWindowRgn(Hwnd, 0, true) != 0, "WINDOW_REGION_NOT_RESTORED");
        Desktop.SetParent(Hwnd, Parent);
        Desktop.SetStyle(Hwnd, -16, Style); Desktop.SetStyle(Hwnd, -20, ExStyle);
        // SetParent preserves WS_CHILD; GetParent can report the desktop until the style is restored.
        Desktop.Require(Desktop.GetParent(Hwnd) == Parent, "WINDOW_PARENT_NOT_RESTORED");
        Desktop.Position(Hwnd, Bounds.Left, Bounds.Top, Bounds.Right - Bounds.Left, Bounds.Bottom - Bounds.Top,
            0, Desktop.NoZOrder | Desktop.NoActivate | Desktop.FrameChanged | Desktop.Show);
        Desktop.Require(Desktop.SetWindowPlacement(Hwnd, ref Placement), "WINDOW_PLACEMENT_NOT_RESTORED");
        Desktop.Require(Desktop.GetWindowRect(Hwnd, out var actual) && actual.Equals(Bounds) &&
            (long)Desktop.GetLong(Hwnd, -16) == Style && (long)Desktop.GetLong(Hwnd, -20) == ExStyle &&
            Desktop.GetParent(Hwnd) == Parent, "WINDOW_RESTORATION_NOT_PROVEN");
        Desktop.RemoveProp(Hwnd, marker);
    }
}
