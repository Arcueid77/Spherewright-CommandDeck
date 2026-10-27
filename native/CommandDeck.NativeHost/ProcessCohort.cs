using System.Diagnostics;
using System.Text.Json;

namespace CommandDeck.NativeHost;

// Read-only OS inspection: no WMI/PowerShell startup, window messages, process
// termination or game APIs. Unknown identities never become an empty result.
internal static class ProcessCohort
{
    private sealed record Member(int Pid, string StartedUtcTicks, int RootIndex, string RelativeImage);

    internal static int Inspect(string[] arguments, bool includeNode = false)
    {
        try
        {
            if (arguments.Length is < 1 or > 2 || arguments.Any(path =>
                !Path.IsPathFullyQualified(path) || !Directory.Exists(path) || path.Length > 4096))
                throw new InvalidOperationException("PROCESS_COHORT_ROOT_INVALID");
            string[] roots = arguments.Select(path => Path.TrimEndingDirectorySeparator(Path.GetFullPath(path))).ToArray();
            string[] prefixes = roots.Select(path => Path.EndsInDirectorySeparator(path) ? path : path + Path.DirectorySeparatorChar).ToArray();
            var members = new List<Member>();
            int inspected = 0;
            string[] names = includeNode
                ? new[] { "Spherewright-CommandDeck", "CommandDeck.NativeHost", "CommandDeck.CommandHost", "node" }
                : new[] { "Spherewright-CommandDeck", "CommandDeck.NativeHost", "CommandDeck.CommandHost" };
            foreach (string name in names)
            {
                foreach (Process process in Process.GetProcessesByName(name))
                {
                    using (process)
                    {
                        if (++inspected > 256) throw new InvalidOperationException("PROCESS_COHORT_LIMIT");
                        if (process.Id == Environment.ProcessId) continue;
                        try
                        {
                            string? image = process.MainModule?.FileName;
                            if (string.IsNullOrEmpty(image)) throw new InvalidOperationException("PROCESS_COHORT_IDENTITY_UNKNOWN");
                            long birth = process.StartTime.ToUniversalTime().Ticks;
                            int rootIndex = Array.FindIndex(prefixes, prefix => image.StartsWith(prefix, StringComparison.OrdinalIgnoreCase));
                            if (rootIndex >= 0) members.Add(new(process.Id, birth.ToString(System.Globalization.CultureInfo.InvariantCulture), rootIndex, Path.GetRelativePath(roots[rootIndex], image).Replace('\\', '/')));
                        }
                        catch
                        {
                            // A process that exited during inspection is absent. A still
                            // live process with unreadable identity is an unknown result.
                            bool exited;
                            try { exited = process.HasExited; } catch { exited = false; }
                            if (!exited) throw;
                        }
                    }
                }
            }
            Console.WriteLine(JsonSerializer.Serialize(new { version = 1, observerPid = Environment.ProcessId, roots, nodeImagesIncluded = includeNode, count = members.Count, members }, Program.Json));
            return 0;
        }
        catch
        {
            Console.Error.WriteLine("PROCESS_COHORT_OBSERVATION_FAILED");
            return 1;
        }
    }
}
