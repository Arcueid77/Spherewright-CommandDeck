using System.Runtime.CompilerServices;

[assembly: InternalsVisibleTo("CommandDeck.NativeHost")]

namespace CommandDeck.Windowing;

// The decision to stop a pump and accept a new request shares one lock.
internal sealed class LayoutRevisions
{
    private readonly object sync = new();
    private long requested, applied;
    private bool running;
    internal long Requested { get { lock (sync) return requested; } }
    internal long Applied { get { lock (sync) return applied; } }
    internal bool Running { get { lock (sync) return running; } }
    internal bool Request()
    {
        lock (sync)
        {
            requested++;
            if (running) return false;
            running = true;
            return true;
        }
    }
    internal bool Complete(long revision)
    {
        lock (sync)
        {
            applied = revision;
            if (requested != revision) return true;
            running = false;
            return false;
        }
    }
    internal void Fail() { lock (sync) running = false; }
}
