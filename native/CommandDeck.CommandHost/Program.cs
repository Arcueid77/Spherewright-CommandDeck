using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;

namespace CommandDeck.CommandHost;

internal static class Program
{
    private static readonly object OutputLock = new();
    private static int outputCharacters;
    private static bool outputTruncated;
    private static void Emit(object value) { lock (OutputLock) Console.WriteLine(JsonSerializer.Serialize(value)); }
    private sealed record Specification(string Executable, string[] Arguments, string Directory, int TimeoutMs);

    private static async Task<int> Main(string[] args)
    {
        if (args.Length > 0 && !args.SequenceEqual(["--fixture-hold-before-resume"])) return Fail("INVALID_COMMAND_HOST_ARGUMENTS");
        Console.InputEncoding = Encoding.UTF8;
        Console.OutputEncoding = new UTF8Encoding(false);
        using var job = Native.CreateJobObjectW(IntPtr.Zero, null);
        if (job.IsInvalid) return Fail("COMMAND_JOB_UNAVAILABLE");
        var limits = new Native.ExtendedLimitInformation();
        limits.BasicLimitInformation.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if (!Native.SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits))) return Fail("COMMAND_JOB_CONFIGURATION_FAILED");
        using var cancellation = new CancellationTokenSource();
        Native.ProcessInformation process = default;
        var assigned = false;
        try
        {
            var line = await Console.In.ReadLineAsync();
            if (line is null || line.Length > 65536) throw new InvalidOperationException("INVALID_COMMAND_SPECIFICATION");
            var spec = JsonSerializer.Deserialize<Specification>(line, new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
            if (spec is null || !Path.IsPathFullyQualified(spec.Executable) || !File.Exists(spec.Executable) ||
                !Path.IsPathFullyQualified(spec.Directory) || !Directory.Exists(spec.Directory) ||
                spec.Arguments is null || spec.Arguments.Length > 128 || spec.Arguments.Any(a => a is null || a.Length > 8192 || a.Contains('\0')) ||
                spec.TimeoutMs is < 100 or > 300000) throw new InvalidOperationException("INVALID_COMMAND_SPECIFICATION");
            var commandLine = new StringBuilder(string.Join(" ", new[] { spec.Executable }.Concat(spec.Arguments).Select(Quote)));
            if (commandLine.Length > 30000) throw new InvalidOperationException("COMMAND_LINE_TOO_LARGE");
            var security = new Native.SecurityAttributes { Length = Marshal.SizeOf<Native.SecurityAttributes>(), InheritHandle = true };
            if (!Native.CreatePipe(out var outRead, out var outWrite, ref security, 0)) throw new Win32Exception();
            using (outRead) using (outWrite)
            {
                if (!Native.CreatePipe(out var errRead, out var errWrite, ref security, 0)) throw new Win32Exception();
                using (errRead) using (errWrite)
                using (var input = Native.CreateFileW("NUL", 0x80000000, 3, ref security, 3, 0, IntPtr.Zero))
                {
                    if (input.IsInvalid || !Native.SetHandleInformation(outRead, 1, 0) || !Native.SetHandleInformation(errRead, 1, 0)) throw new Win32Exception();
                    using var attributes = new HandleAttributes([input.DangerousGetHandle(), outWrite.DangerousGetHandle(), errWrite.DangerousGetHandle()], job.DangerousGetHandle());
                    var start = new Native.StartupInformationEx
                    {
                        StartupInfo = new Native.StartupInformation
                        {
                            Size = Marshal.SizeOf<Native.StartupInformationEx>(), Flags = 0x100,
                            StandardInput = input.DangerousGetHandle(), StandardOutput = outWrite.DangerousGetHandle(), StandardError = errWrite.DangerousGetHandle()
                        },
                        AttributeList = attributes.Pointer
                    };
                    // Only the three explicit child std handles are inherited; never the control channel or job handle.
                    if (!Native.CreateProcessW(spec.Executable, commandLine, IntPtr.Zero, IntPtr.Zero, true,
                        0x00000004 | 0x08000000 | 0x00080000, IntPtr.Zero, spec.Directory, ref start, out process)) throw new Win32Exception();
                    assigned = true;
                    if (!Native.IsProcessInJob(process.Process, job, out var inJob) || !inJob) throw new Win32Exception();
                    Emit(new { type = "created", pid = process.ProcessId, inJob });
                    if (args.Length == 1) { await Task.Delay(10000); throw new InvalidOperationException("FIXTURE_BARRIER_TIMED_OUT"); } // Never resumes; workbench supplies no argument.
                    outWrite.Dispose(); errWrite.Dispose();
                    var control = Task.Run(async () => { try { while (await Console.In.ReadLineAsync() is { } command) { if (command == "cancel") break; } } finally { cancellation.Cancel(); } });
                    if (Native.ResumeThread(process.Thread) == uint.MaxValue) throw new Win32Exception();
                    Native.CloseHandle(process.Thread); process.Thread = IntPtr.Zero;
                    Emit(new { type = "started", pid = process.ProcessId });
                    using var output = new FileStream(outRead, FileAccess.Read);
                    using var error = new FileStream(errRead, FileAccess.Read);
                    var drains = Task.WhenAll(Drain(output, "stdout"), Drain(error, "stderr"));
                    // Zero-time waits never outlive the creation handle, including unknown/error paths.
                    var clock = Stopwatch.StartNew();
                    string reason;
                    while (true)
                    {
                        var wait = Native.WaitForSingleObject(process.Process, 0);
                        if (wait == 0) { reason = "exited"; break; }
                        if (wait != 258) throw new Win32Exception();
                        if (cancellation.IsCancellationRequested) { reason = "cancelled"; break; }
                        if (clock.ElapsedMilliseconds >= spec.TimeoutMs) { reason = "timeout"; break; }
                        await Task.Delay(20);
                    }
                    uint exitCode = 125;
                    if (reason == "exited" && !Native.GetExitCodeProcess(process.Process, out exitCode)) throw new Win32Exception();
                    // Normal descendants are also ended when their root exits; no background build/test daemon is retained.
                    var terminated = Native.TerminateJobObject(job, 125);
                    var treeConfirmed = await ConfirmEmpty(job);
                    if (!await ConfirmProcessExit(process.Process)) treeConfirmed = false;
                    var streamsDrained = await Task.WhenAny(drains, Task.Delay(3000)) == drains;
                    if (streamsDrained) { try { await drains; } catch { streamsDrained = false; } }
                    Emit(new { type = "result", exitCode, reason, treeConfirmed, streamsDrained, outputTruncated, terminationSubmitted = terminated });
                    GC.KeepAlive(control);
                    return treeConfirmed && streamsDrained ? 0 : 2;
                }
            }
        }
        catch (Exception exception)
        {
            // Only this invocation's original creation handle and job are ever terminated.
            if (process.Process != IntPtr.Zero) Native.TerminateProcess(process.Process, 125);
            if (assigned) Native.TerminateJobObject(job, 125);
            var empty = assigned ? await ConfirmEmpty(job) : process.Process == IntPtr.Zero || Native.WaitForSingleObject(process.Process, 5000) == 0;
            var code = exception is InvalidOperationException ? exception.Message : "COMMAND_HOST_FAILED";
            Emit(new { type = "error", code, treeConfirmed = empty });
            return 1;
        }
        finally
        {
            if (process.Thread != IntPtr.Zero) Native.CloseHandle(process.Thread);
            if (process.Process != IntPtr.Zero) Native.CloseHandle(process.Process);
        }
    }

    private static int Fail(string code) { Emit(new { type = "error", code, treeConfirmed = true }); return 1; }
    private static async Task Drain(Stream stream, string source)
    {
        using var reader = new StreamReader(stream, Encoding.UTF8, true, 4096, true);
        var buffer = new char[4096];
        int count;
        while ((count = await reader.ReadAsync(buffer)) > 0)
        {
            lock (OutputLock)
            {
                var permitted = Math.Min(count, Math.Max(0, 262144 - outputCharacters));
                if (permitted > 0) { outputCharacters += permitted; Emit(new { type = "output", stream = source, text = new string(buffer, 0, permitted) }); }
                if (permitted < count) outputTruncated = true; // Keep draining after the retained-output cap.
            }
        }
    }
    private static async Task<bool> ConfirmEmpty(SafeFileHandle job)
    {
        var clock = Stopwatch.StartNew();
        do
        {
            if (!Native.QueryInformationJobObject(job, 1, out var information, (uint)Marshal.SizeOf<Native.BasicAccountingInformation>(), IntPtr.Zero)) return false;
            if (information.ActiveProcesses == 0) return true;
            await Task.Delay(20);
        } while (clock.ElapsedMilliseconds < 5000);
        return false;
    }
    private static async Task<bool> ConfirmProcessExit(IntPtr process)
    {
        var clock = Stopwatch.StartNew();
        do
        {
            var wait = Native.WaitForSingleObject(process, 0);
            if (wait == 0) return true;
            if (wait != 258) return false;
            await Task.Delay(20);
        } while (clock.ElapsedMilliseconds < 1000);
        return false;
    }
    private static string Quote(string value)
    {
        var text = new StringBuilder("\""); var backslashes = 0;
        foreach (var character in value)
        {
            if (character == '\\') { backslashes++; continue; }
            text.Append('\\', character == '"' ? backslashes * 2 + 1 : backslashes);
            text.Append(character); backslashes = 0;
        }
        return text.Append('\\', backslashes * 2).Append('"').ToString();
    }
    private sealed class HandleAttributes : IDisposable
    {
        public IntPtr Pointer { get; private set; }
        private IntPtr values;
        private IntPtr jobs;
        public HandleAttributes(IntPtr[] handles, IntPtr job)
        {
            nuint size = 0; Native.InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
            Pointer = Marshal.AllocHGlobal(checked((int)size));
            try
            {
                if (!Native.InitializeProcThreadAttributeList(Pointer, 2, 0, ref size)) throw new Win32Exception();
                values = Marshal.AllocHGlobal(IntPtr.Size * handles.Length);
                Marshal.Copy(handles, 0, values, handles.Length);
                if (!Native.UpdateProcThreadAttribute(Pointer, 0, (IntPtr)0x20002, values, (nuint)(IntPtr.Size * handles.Length), IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception();
                jobs = Marshal.AllocHGlobal(IntPtr.Size);
                Marshal.WriteIntPtr(jobs, job);
                // Windows 10+: atomic job assignment at creation closes the create/assign crash window.
                if (!Native.UpdateProcThreadAttribute(Pointer, 0, (IntPtr)0x2000D, jobs, (nuint)IntPtr.Size, IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception();
            }
            catch { Dispose(); throw; }
        }
        public void Dispose() { if (Pointer != IntPtr.Zero) { Native.DeleteProcThreadAttributeList(Pointer); Marshal.FreeHGlobal(Pointer); Pointer = IntPtr.Zero; } if (values != IntPtr.Zero) { Marshal.FreeHGlobal(values); values = IntPtr.Zero; } if (jobs != IntPtr.Zero) { Marshal.FreeHGlobal(jobs); jobs = IntPtr.Zero; } }
    }
}

internal static class Native
{
    [StructLayout(LayoutKind.Sequential)] internal struct SecurityAttributes { public int Length; public IntPtr Descriptor; [MarshalAs(UnmanagedType.Bool)] public bool InheritHandle; }
    [StructLayout(LayoutKind.Sequential)] internal struct BasicLimitInformation { public long ProcessUserTimeLimit, JobUserTimeLimit; public uint LimitFlags; public nuint MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit; public nuint Affinity; public uint PriorityClass, SchedulingClass; }
    [StructLayout(LayoutKind.Sequential)] internal struct IoCounters { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
    [StructLayout(LayoutKind.Sequential)] internal struct ExtendedLimitInformation { public BasicLimitInformation BasicLimitInformation; public IoCounters IoInfo; public nuint ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
    [StructLayout(LayoutKind.Sequential)] internal struct BasicAccountingInformation { public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime; public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] internal struct StartupInformation { public int Size; public string? Reserved, Desktop, Title; public uint X, Y, XSize, YSize, XCountChars, YCountChars, FillAttribute, Flags; public ushort ShowWindow, Reserved2Size; public IntPtr Reserved2, StandardInput, StandardOutput, StandardError; }
    [StructLayout(LayoutKind.Sequential)] internal struct StartupInformationEx { public StartupInformation StartupInfo; public IntPtr AttributeList; }
    [StructLayout(LayoutKind.Sequential)] internal struct ProcessInformation { public IntPtr Process, Thread; public uint ProcessId, ThreadId; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern SafeFileHandle CreateJobObjectW(IntPtr attributes, string? name);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool SetInformationJobObject(SafeFileHandle job, int informationClass, ref ExtendedLimitInformation information, uint length);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool QueryInformationJobObject(SafeFileHandle job, int informationClass, out BasicAccountingInformation information, uint length, IntPtr returnedLength);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool IsProcessInJob(IntPtr process, SafeFileHandle job, [MarshalAs(UnmanagedType.Bool)] out bool inJob);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool TerminateJobObject(SafeFileHandle job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool CreatePipe(out SafeFileHandle read, out SafeFileHandle write, ref SecurityAttributes attributes, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool SetHandleInformation(SafeFileHandle handle, uint mask, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern SafeFileHandle CreateFileW(string name, uint access, uint share, ref SecurityAttributes attributes, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, [MarshalAs(UnmanagedType.Bool)] bool inheritHandles, uint flags, IntPtr environment, string directory, ref StartupInformationEx startup, out ProcessInformation information);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll")] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref nuint size);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, nuint size, IntPtr previous, IntPtr returnedSize);
    [DllImport("kernel32.dll")] internal static extern void DeleteProcThreadAttributeList(IntPtr list);
}
