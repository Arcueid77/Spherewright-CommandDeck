using System.Diagnostics;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

namespace CommandDeck.NativeHost;

// Console-only transport for the desktop. Authenticate the OS pipe peer before sending its secret.
internal static class AdapterPipeClient
{
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetNamedPipeServerProcessId(nint pipe, out uint pid);
    internal static object InspectProcess(int pid, string started, string kind)
    {
        try
        {
            using var process = Process.GetProcessById(pid);
            using var current = Process.GetCurrentProcess();
            bool exited = process.HasExited || process.StartTime.ToUniversalTime().Ticks.ToString(System.Globalization.CultureInfo.InvariantCulture) != started;
            bool same = !exited && process.SessionId == current.SessionId &&
                string.Equals(process.ProcessName, kind == "dsp" ? "DSPGAME" : "CommandDeck.NativeHost", StringComparison.OrdinalIgnoreCase);
            return new { exited, sameInstance = same };
        }
        catch (ArgumentException) { return new { exited = true, sameInstance = false }; }
        catch { return new { exited = false, sameInstance = false }; }
    }
    internal static async Task Run(string path, int expectedPid, string expectedStarted, string expectedKind, string expectedPipeName)
    {
        string directory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Spherewright", "CommandDeck", "hosts");
        string expectedPath = Path.Combine(directory, expectedPid + "-" + expectedStarted + ".json");
        if (!string.Equals(Path.GetFullPath(path), expectedPath, StringComparison.OrdinalIgnoreCase) ||
            !new FileInfo(path).Exists || new FileInfo(path).Length > 4096 ||
            (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
            throw new InvalidOperationException("ADAPTER_DESCRIPTOR_REJECTED");
        using var descriptor = JsonDocument.Parse(await File.ReadAllTextAsync(path), new JsonDocumentOptions { MaxDepth = 8 });
        var data = descriptor.RootElement;
        if (data.GetProperty("schemaVersion").GetInt32() != 1 || data.GetProperty("adapterVersion").GetString() != "0.0.1" ||
            data.GetProperty("gamePid").GetInt32() != expectedPid || data.GetProperty("gameStartedTicks").GetString() != expectedStarted ||
            data.GetProperty("kind").GetString() != expectedKind || expectedKind is not ("dsp" or "fixture"))
            throw new InvalidOperationException("ADAPTER_DESCRIPTOR_CHANGED");
        string pipeName = data.GetProperty("pipeName").GetString()!;
        if (pipeName != expectedPipeName || !System.Text.RegularExpressions.Regex.IsMatch(pipeName, "^Spherewright\\.CommandDeck\\.[a-f0-9]{32}$"))
            throw new InvalidOperationException("ADAPTER_PIPE_NAME_REJECTED");
        using var pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
        await pipe.ConnectAsync(5000);
        if (!GetNamedPipeServerProcessId(pipe.SafePipeHandle.DangerousGetHandle(), out uint peerPid) || peerPid != expectedPid)
            throw new InvalidOperationException("ADAPTER_PEER_MISMATCH");
        using (var peer = Process.GetProcessById(expectedPid))
        using (var current = Process.GetCurrentProcess())
        {
            if (peer.SessionId != current.SessionId || peer.StartTime.ToUniversalTime().Ticks.ToString(System.Globalization.CultureInfo.InvariantCulture) != expectedStarted ||
                !string.Equals(peer.ProcessName, expectedKind == "dsp" ? "DSPGAME" : "CommandDeck.NativeHost", StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("ADAPTER_PEER_MISMATCH");
        }
        var encoding = new UTF8Encoding(false, true);
        using var writer = new StreamWriter(pipe, encoding, 1024, true) { AutoFlush = true };
        using var reader = new StreamReader(pipe, encoding, false, 1024, true);
        await writer.WriteLineAsync(JsonSerializer.Serialize(new { method = "hello", clientPid = Environment.ProcessId, secret = data.GetProperty("secret").GetString() }));
        var authenticated = ReadBoundedLine(reader);
        if (await Task.WhenAny(authenticated, Task.Delay(6000)) != authenticated) throw new InvalidOperationException("ADAPTER_HELLO_TIMEOUT");
        string hello = await authenticated ?? throw new IOException("ADAPTER_EOF");
        await Console.Out.WriteLineAsync(hello);
        await Console.Out.FlushAsync();
        var outgoing = Task.Run(async () =>
        {
            while (await ReadBoundedLine(Console.In) is { } line)
            {
                using var command = JsonDocument.Parse(line, new JsonDocumentOptions { MaxDepth = 8 });
                string? method = command.RootElement.GetProperty("method").GetString();
                if (method is not ("status" or "activate" or "adopt" or "rect" or "detach" or "deactivate" or "focus-ui"))
                    throw new InvalidOperationException("WINDOW_METHOD_UNSUPPORTED");
                await writer.WriteLineAsync(line);
            }
        });
        var incoming = Task.Run(async () =>
        {
            while (await ReadBoundedLine(reader) is { } line)
            {
                await Console.Out.WriteLineAsync(line);
                await Console.Out.FlushAsync();
            }
        });
        await await Task.WhenAny(outgoing, incoming);
        // Closing our own pipe restores native windows on the server. Never terminate its process.
    }
    private static async Task<string?> ReadBoundedLine(TextReader reader)
    {
        var buffer = new StringBuilder();
        var character = new char[1];
        while (await reader.ReadAsync(character, 0, 1) != 0)
        {
            if (character[0] == '\n')
            {
                string line = buffer.ToString();
                if (Encoding.UTF8.GetByteCount(line) > 8192) throw new IOException("FRAME_LIMIT");
                return line;
            }
            if (buffer.Length >= 8192) throw new IOException("FRAME_LIMIT");
            buffer.Append(character[0]);
        }
        return null;
    }
}
