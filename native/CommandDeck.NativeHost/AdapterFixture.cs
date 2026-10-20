using System.Text.Json.Nodes;
using CommandDeck.Windowing;
using CommandDeck.AdapterBridge;
using System.Runtime.InteropServices;
using System.Text;

namespace CommandDeck.NativeHost;

// Uses the same raw Win32 host compiled for the Unity adapter, with a form replacing Unity only.
internal sealed class AdapterFixture : Form
{
    private readonly GameWindowHost host = new();
    private readonly System.Windows.Forms.Timer timer = new() { Interval = 200 };
    private long originalStyle, originalExStyle, frames;
    private Win.Rect originalBounds;
    private nint gameHwnd;
    private bool allowClose;
    private readonly AdapterServer? server;
    private string? brokenMarker;
    private nint brokenValue;
    private delegate int PropertyCallback(nint hwnd, nint name, nint value, nint data);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int EnumPropsEx(nint hwnd, PropertyCallback callback, nint data);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(nint hwnd, StringBuilder text, int capacity);

    internal AdapterFixture(bool pipeMode = false)
    {
        if (pipeMode) server = new AdapterServer("fixture");
        Text = "CommandDeck Unity-adapter fixture — NO DSP";
        Width = 1100; Height = 760; BackColor = Color.FromArgb(17, 35, 45);
        Paint += (_, e) => e.Graphics.DrawString("RAW WIN32 GAME HOST\nUnity-adapter fixture only — NO DSP", Font, Brushes.Wheat, 30, 30);
        Shown += async (_, _) =>
        {
            try
            {
                Win.ShowWindow(Handle, 5);
                gameHwnd = Handle;
                // Exercise the style bit that otherwise suppresses real child-pointer notifications.
                Win.SetExStyle(gameHwnd, Win.GetExStyle(gameHwnd) | 4);
                originalStyle = Win.GetStyle(Handle); originalExStyle = Win.GetExStyle(Handle);
                Win.GetWindowRect(Handle, out originalBounds);
                if (server != null)
                {
                    server.UpdateWindowFacts(new WindowFacts(gameHwnd, true, "fixture-no-unity"));
                    server.Start();
                }
                else await Task.Run(() => host.StartAsync(gameHwnd));
                Program.Send(new { type = "ready", pid = Environment.ProcessId, hwnd = ((long)host.HostHandle).ToString(), gameHwnd = ((long)gameHwnd).ToString(), visible = server != null || host.Status().HostVisible, mode = "unity-adapter-fixture", descriptor = server?.DescriptorPath });
                _ = Task.Run(ReadRequests);
            }
            catch (Exception exception)
            {
                string detail = exception.Message.All(c => c == '_' || c >= 'A' && c <= 'Z') ? "_" + exception.Message : "";
                Console.Error.WriteLine("ADAPTER_FIXTURE_START_FAILED_" + exception.GetType().Name + detail);
                allowClose = true; Close();
            }
        };
        timer.Tick += (_, _) =>
        {
            frames++;
            Program.Send(new { type = "fixture", state = host.Status() });
        };
        timer.Start();
        FormClosing += (_, e) =>
        {
            if (allowClose) return;
            e.Cancel = true;
            _ = Task.Run(CloseNormally);
        };
        FormClosed += (_, _) => timer.Dispose();
    }

    private object Identity() => server?.FixtureIdentity() ?? new { hostHwnd = ((long)host.HostHandle).ToString(), gameHwnd = ((long)gameHwnd).ToString() };
    private object Restored()
    {
        Win.GetWindowRect(gameHwnd, out var bounds);
        return new
        {
            gameAlive = Win.IsWindow(gameHwnd), gameVisible = Win.IsWindowVisible(gameHwnd),
            topLevel = Win.GetParent(gameHwnd) == 0,
            styleRestored = Win.GetStyle(gameHwnd) == originalStyle,
            exStyleRestored = Win.GetExStyle(gameHwnd) == originalExStyle,
            boundsRestored = bounds.Equals(originalBounds),
            gameWidth = bounds.Right - bounds.Left, gameHeight = bounds.Bottom - bounds.Top, frames
        };
    }
    private async Task CloseNormally()
    {
        try { if (server != null) await server.StopAsync(); else await host.StopAsync(); }
        catch { return; } // Keep the parent alive if restoration cannot be proved.
        BeginInvoke(() => { allowClose = true; Close(); });
    }
    private async Task ReadRequests()
    {
        try
        {
            while (await Console.In.ReadLineAsync() is { } line)
            {
                if (line.Length > 32768) break;
                var request = JsonNode.Parse(line)!.AsObject();
                _ = Request(request);
            }
        }
        finally
        {
            try { if (server != null) await server.StopAsync(); else await host.StopAsync(); } catch { }
        }
    }
    private async Task Request(JsonObject request)
    {
        string id = request["id"]?.GetValue<string>() ?? "";
        try
        {
            object result;
            switch (request["method"]?.GetValue<string>())
            {
                case "status": result = host.Status(); break;
                case "focus-ui": result = await host.FocusUiAsync(); break;
                case "fixture-identity": result = Identity(); break;
                case "fixture-host-title":
                    var title = new StringBuilder(256);
                    if (host.HostHandle == 0 || GetWindowText(host.HostHandle, title, title.Capacity) <= 0) throw new InvalidOperationException("FIXTURE_HOST_TITLE_UNAVAILABLE");
                    result = new { title = title.ToString() }; break;
                case "restored": result = Restored(); break;
                case "fixture-windowed":
                    if (server == null) throw new InvalidOperationException("PIPE_FIXTURE_REQUIRED");
                    server.UpdateWindowFacts(new WindowFacts(gameHwnd, request["windowed"]!.GetValue<bool>(), "fixture-no-unity"));
                    result = new { updated = true }; break;
                case "fixture-descriptor-collision":
                    if (server == null) throw new InvalidOperationException("PIPE_FIXTURE_REQUIRED");
                    var collision = new AdapterServer("fixture");
                    collision.UpdateWindowFacts(new WindowFacts(gameHwnd, true, "fixture-no-unity"));
                    bool rejected = false;
                    try { collision.Start(); } catch (IOException) { rejected = true; }
                    await collision.StopAsync();
                    result = new { rejected, originalPreserved = File.Exists(server.DescriptorPath) }; break;
                case "fixture-break-marker":
                    if (server == null || brokenMarker != null) throw new InvalidOperationException("PIPE_FIXTURE_REQUIRED");
                    // Fault injection only in this executable's own fake game window, never Unity/DSP.
                    EnumPropsEx(gameHwnd, (_, name, value, _) =>
                    {
                        if ((long)name <= 65535) return 1;
                        string? key = Marshal.PtrToStringUni(name);
                        if (key?.StartsWith("Spherewright.CommandDeck.", StringComparison.Ordinal) == true)
                        { brokenMarker = key; brokenValue = value; return 0; }
                        return 1;
                    }, 0);
                    if (brokenMarker == null || Win.RemoveProp(gameHwnd, brokenMarker) != brokenValue) throw new InvalidOperationException("FIXTURE_MARKER_NOT_REMOVED");
                    result = new { broken = true }; break;
                case "fixture-restore-marker":
                    if (brokenMarker == null || !Win.IsWindow(gameHwnd) || Win.WindowPid(gameHwnd) != Environment.ProcessId ||
                        Win.GetProp(gameHwnd, brokenMarker) != 0 || !Win.SetProp(gameHwnd, brokenMarker, brokenValue))
                        throw new InvalidOperationException("FIXTURE_MARKER_NOT_RESTORED");
                    brokenMarker = null;
                    result = new { restored = true }; break;
                case "adopt":
                    await host.AdoptUiAsync((nint)long.Parse(request["hwnd"]!.GetValue<string>()), request["pid"]!.GetValue<int>());
                    result = host.Status(); break;
                case "rect":
                    host.SetViewport(new ViewportRect { X = request["x"]!.GetValue<int>(), Y = request["y"]!.GetValue<int>(), Width = request["width"]!.GetValue<int>(), Height = request["height"]!.GetValue<int>(), Visible = request["visible"]!.GetValue<bool>() });
                    result = host.Status(); break;
                case "detach": await host.DetachUiAsync(); result = host.Status(); break;
                case "stop-host": await host.StopAsync(); result = Restored(); break;
                case "host-close": host.RequestHostClose(); result = new { requested = true }; break;
                case "fixture-host-quit": host.RequestQuitForFixture(); result = new { requested = true }; break;
                case "close":
                    if (server != null) await server.StopAsync(); else await host.StopAsync();
                    if (await Program.FlushReply(new { id, ok = true, result = new { closed = true } }))
                        BeginInvoke(() => { allowClose = true; Close(); });
                    return;
                default: throw new InvalidOperationException("FIXTURE_METHOD_UNSUPPORTED");
            }
            Program.Send(new { id, ok = true, result });
        }
        catch (Exception exception)
        {
            Program.Send(new { id, ok = false, code = exception is InvalidOperationException ? exception.Message : "ADAPTER_FIXTURE_FAILED" });
        }
    }
}
