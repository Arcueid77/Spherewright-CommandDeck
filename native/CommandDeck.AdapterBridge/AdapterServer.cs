using System.Diagnostics;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using CommandDeck.Windowing;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Newtonsoft.Json.Serialization;

namespace CommandDeck.AdapterBridge;

public sealed class WindowFacts
{
    public nint Hwnd { get; }
    public bool Windowed { get; }
    public string UnityVersion { get; }
    public long UpdateSequence { get; }
    public int RenderWidth { get; }
    public int RenderHeight { get; }
    public WindowFacts(nint hwnd, bool windowed, string unityVersion, long updateSequence = 0, int renderWidth = 0, int renderHeight = 0)
    { Hwnd = hwnd; Windowed = windowed; UnityVersion = unityVersion; UpdateSequence = updateSequence; RenderWidth = renderWidth; RenderHeight = renderHeight; }
}

// Opt-in window-only transport. It cannot call GameMain, Save/Load, input injection or process termination.
public sealed class AdapterServer
{
    public const string Version = "0.0.1";
    private static readonly JsonSerializerSettings Json = new()
    {
        ContractResolver = new CamelCasePropertyNamesContractResolver(), MaxDepth = 8,
        TypeNameHandling = TypeNameHandling.None, MetadataPropertyHandling = MetadataPropertyHandling.Ignore
    };
    private static readonly UTF8Encoding Utf8 = new(false, true);
    private readonly CancellationTokenSource lifetime = new();
    private readonly SemaphoreSlim operations = new(1);
    private readonly string pipeName = "Spherewright.CommandDeck." + Guid.NewGuid().ToString("N");
    private readonly string secret;
    private WindowFacts facts = new(0, false, "unavailable");
    private volatile GameWindowHost? host;
    private NamedPipeServerStream? pipe;
    private Task? listener;
    private string? descriptor;
    private volatile bool stopping, quarantined;
    private bool descriptorOwned;
    private string? adapterFault;
    private int displayStopQueued;
    private readonly string kind;
    public string? DescriptorPath => descriptor; // Private launch/test channel only; never public diagnostics.
    public string? Fault => Volatile.Read(ref adapterFault);
    internal object FixtureIdentity() => new { hostHwnd = ((long)(host?.HostHandle ?? 0)).ToString(), gameHwnd = ((long)Volatile.Read(ref facts).Hwnd).ToString() };

    public AdapterServer(string kind = "dsp")
    {
        if (kind != "dsp" && kind != "fixture") throw new InvalidOperationException("EXPLICIT_ADAPTER_KIND_REQUIRED");
        this.kind = kind;
        var bytes = new byte[32];
        using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(bytes);
        secret = Convert.ToBase64String(bytes);
    }

    public void UpdateWindowFacts(WindowFacts value)
    {
        Volatile.Write(ref facts, value);
        if (!quarantined && !value.Windowed && host?.Status().Active == true && Interlocked.Exchange(ref displayStopQueued, 1) == 0)
            _ = Task.Run(async () => { try { await TryDeactivate().ConfigureAwait(false); } finally { Interlocked.Exchange(ref displayStopQueued, 0); } });
    }

    public void Start()
    {
        if (listener != null || Volatile.Read(ref facts).Hwnd == 0) throw new InvalidOperationException("WINDOW_FACTS_REQUIRED");
        {
            string directory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Spherewright", "CommandDeck", "hosts");
            WindowsCurrentUserSecurity.EnsureSecureDirectory(directory);
            using (var process = Process.GetCurrentProcess())
            {
                if (kind == "dsp" && !string.Equals(process.ProcessName, "DSPGAME", StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException("DSP_PROCESS_REQUIRED");
                string started = process.StartTime.ToUniversalTime().Ticks.ToString(System.Globalization.CultureInfo.InvariantCulture);
                pipe = CreatePipe(); // Publish the descriptor only after its protected pipe exists.
                string path = Path.Combine(directory, process.Id + "-" + started + ".json");
                using (var file = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                {
                    descriptor = path; descriptorOwned = true;
                    using (var writer = new StreamWriter(file, Utf8))
                        writer.Write(JsonConvert.SerializeObject(new
                        {
                            schemaVersion = 1, adapterVersion = Version, gamePid = process.Id, gameStartedTicks = started,
                            pipeName, secret, kind, unityVersion = Volatile.Read(ref facts).UnityVersion
                        }, Json));
                }
            }
        }
        listener = Task.Run(Listen);
    }

    private NamedPipeServerStream CreatePipe()
    {
        return WindowsCurrentUserSecurity.CreateSecurePipe(pipeName, 8192, 8192);
    }

    private async Task Listen()
    {
        try
        {
            while (!lifetime.IsCancellationRequested)
            {
                using (var connection = pipe ?? CreatePipe())
                {
                    pipe = connection;
                    using (lifetime.Token.Register(() => connection.Dispose()))
                        await connection.WaitForConnectionAsync().ConfigureAwait(false);
                    try { await Serve(connection).ConfigureAwait(false); }
                    catch (Exception) { } // A malformed/expired client ends only this connection.
                    finally
                    {
                        // EOF restores both windows. It never exits or restarts the game.
                        if (!quarantined) await TryDeactivate().ConfigureAwait(false);
                        pipe = null;
                    }
                }
            }
        }
        catch (Exception)
        {
            if (!lifetime.IsCancellationRequested) adapterFault = "ADAPTER_LISTENER_FAILED";
        }
        finally { if (stopping && host == null) DeleteOwnDescriptor(); }
    }

    private async Task Serve(NamedPipeServerStream connection)
    {
        if (!GetNamedPipeClientProcessId(connection.SafePipeHandle.DangerousGetHandle(), out uint clientPid) || clientPid == 0)
            throw new InvalidOperationException("LOCAL_CLIENT_REQUIRED");
        if (!GameWindowHost.IsCurrentSessionProcess(checked((int)clientPid)))
            throw new InvalidOperationException("SAME_SESSION_REQUIRED");
        JObject hello;
        using (var timeout = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token))
        {
            timeout.CancelAfter(5000);
            using (timeout.Token.Register(() => connection.Dispose()))
                hello = Parse(await ReadFrame(connection, timeout.Token).ConfigureAwait(false));
        }
        if ((string?)hello["method"] != "hello" || (long?)hello["clientPid"] != clientPid || !SameSecret((string?)hello["secret"]))
            throw new InvalidOperationException("ADAPTER_AUTHENTICATION_FAILED");
        await Reply(connection, new { id = "hello", ok = true, result = Status() }).ConfigureAwait(false);
        while (!lifetime.IsCancellationRequested && connection.IsConnected)
        {
            string line = await ReadFrame(connection, lifetime.Token).ConfigureAwait(false);
            var request = Parse(line);
            string? id = (string?)request["id"];
            if (id == null || id.Length > 40) throw new InvalidOperationException("INVALID_REQUEST_ID");
            try
            {
                object result = await Request((string?)request["method"], request).ConfigureAwait(false);
                await Reply(connection, new { id, ok = true, result }).ConfigureAwait(false);
            }
            catch (Exception exception)
            {
                string code = exception is InvalidOperationException && exception.Message.All(c => c == '_' || c >= 'A' && c <= 'Z') ? exception.Message : "WINDOW_OPERATION_FAILED";
                await Reply(connection, new { id, ok = false, code }).ConfigureAwait(false);
            }
        }
    }

    private bool SameSecret(string? candidate)
    {
        if (candidate == null || candidate.Length != secret.Length) return false;
        int different = 0;
        for (int i = 0; i < secret.Length; i++) different |= secret[i] ^ candidate[i];
        return different == 0;
    }
    private static JObject Parse(string text)
    {
        using (var reader = new JsonTextReader(new StringReader(text)) { MaxDepth = 8 })
            return JObject.Load(reader);
    }
    private static async Task<string> ReadFrame(Stream stream, CancellationToken token)
    {
        var buffer = new byte[8192];
        int length = 0;
        while (length < buffer.Length)
        {
            int read = await stream.ReadAsync(buffer, length, 1, token).ConfigureAwait(false);
            if (read == 0) throw new IOException("ADAPTER_EOF");
            if (buffer[length] == 10) return Utf8.GetString(buffer, 0, length);
            length++;
        }
        throw new IOException("FRAME_LIMIT");
    }
    private static async Task Reply(Stream stream, object message)
    {
        byte[] bytes = Utf8.GetBytes(JsonConvert.SerializeObject(message, Json) + "\n");
        if (bytes.Length > 8192) throw new IOException("FRAME_LIMIT");
        await stream.WriteAsync(bytes, 0, bytes.Length).ConfigureAwait(false);
        await stream.FlushAsync().ConfigureAwait(false);
    }
    private object Status()
    {
        using (var process = Process.GetCurrentProcess())
            return new
            {
                ready = !stopping && !quarantined && adapterFault == null && Volatile.Read(ref facts).Hwnd != 0 && Volatile.Read(ref facts).Windowed,
                windowed = Volatile.Read(ref facts).Windowed, adapterVersion = Version,
                unityVersion = Volatile.Read(ref facts).UnityVersion,
                unityUpdateSequence = Volatile.Read(ref facts).UpdateSequence,
                renderWidth = Volatile.Read(ref facts).RenderWidth, renderHeight = Volatile.Read(ref facts).RenderHeight,
                gamePid = process.Id, gameStartedTicks = process.StartTime.ToUniversalTime().Ticks.ToString(System.Globalization.CultureInfo.InvariantCulture),
                window = host?.Status() ?? new WindowHostState(),
                kind, quarantined, fault = adapterFault, gameCalls = 0, mode = "unity-game-owned-host",
                restorationProven = host == null && !quarantined && adapterFault == null
            };
    }
    private async Task<object> Request(string? method, JObject request)
    {
        if (method == "status") return Status();
        if (method == "deactivate") { await Deactivate().ConfigureAwait(false); return Status(); }
        if (stopping) throw new InvalidOperationException("ADAPTER_STOPPING");
        if (quarantined) throw new InvalidOperationException("WINDOW_RESTORATION_REQUIRED");
        await operations.WaitAsync().ConfigureAwait(false);
        try
        {
            if (method == "activate")
            {
                var current = Volatile.Read(ref facts);
                if (!current.Windowed || current.Hwnd == 0) throw new InvalidOperationException("WINDOWED_GAME_REQUIRED");
                if (host == null)
                {
                    host = new GameWindowHost();
                    await host.StartAsync(current.Hwnd).ConfigureAwait(false);
                }
            }
            else if (host == null) throw new InvalidOperationException("ACTIVATE_HOST_FIRST");
            else if (method == "adopt")
            {
                string handle = (string?)request["hwnd"] ?? "";
                if (!long.TryParse(handle, out long hwnd) || hwnd <= 0) throw new InvalidOperationException("INVALID_UI_WINDOW");
                int pid = (int?)request["pid"] ?? 0;
                await host.AdoptUiAsync((nint)hwnd, pid).ConfigureAwait(false);
            }
            else if (method == "rect")
                host.SetViewport(new ViewportRect
                {
                    X = (int?)request["x"] ?? throw new InvalidOperationException("INVALID_VIEWPORT"),
                    Y = (int?)request["y"] ?? throw new InvalidOperationException("INVALID_VIEWPORT"),
                    Width = (int?)request["width"] ?? throw new InvalidOperationException("INVALID_VIEWPORT"),
                    Height = (int?)request["height"] ?? throw new InvalidOperationException("INVALID_VIEWPORT"),
                    Visible = (bool?)request["visible"] ?? throw new InvalidOperationException("INVALID_VIEWPORT")
                });
            else if (method == "detach") await host.DetachUiAsync().ConfigureAwait(false);
            else if (method == "focus-ui") await host.FocusUiAsync().ConfigureAwait(false);
            else throw new InvalidOperationException("WINDOW_METHOD_UNSUPPORTED");
            return Status();
        }
        finally { operations.Release(); }
    }
    private async Task Deactivate()
    {
        await operations.WaitAsync().ConfigureAwait(false);
        try
        {
            if (host != null) { await host.StopAsync().ConfigureAwait(false); host = null; }
            quarantined = false; adapterFault = null;
        }
        catch { quarantined = true; adapterFault = "WINDOW_RESTORATION_NOT_PROVEN"; throw; }
        finally { operations.Release(); }
    }
    private async Task TryDeactivate()
    {
        try { await Deactivate().ConfigureAwait(false); }
        catch { /* Retain this host and diagnostic endpoint. New activation stays blocked. */ }
    }
    public async Task StopAsync()
    {
        stopping = true;
        try { await Deactivate().ConfigureAwait(false); }
        catch { stopping = false; throw; } // Keep the listener and exact descriptor for diagnosis.
        lifetime.Cancel();
        pipe?.Dispose();
        if (listener != null) await listener.ConfigureAwait(false);
        DeleteOwnDescriptor();
    }
    private void DeleteOwnDescriptor()
    {
        if (descriptorOwned && descriptor != null)
        {
            try { File.Delete(descriptor); descriptorOwned = false; }
            catch (IOException) { }
        }
    }
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetNamedPipeClientProcessId(nint pipeHandle, out uint clientPid);
}
