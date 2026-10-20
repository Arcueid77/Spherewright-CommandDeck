using CommandDeck.Windowing;

namespace CommandDeck.NativeHost;

internal static class LayoutProof
{
    internal static async Task Run()
    {
        var before = new LayoutRevisions();
        if (!before.Request()) throw new InvalidOperationException("FIRST_LAYOUT_NOT_SCHEDULED");
        long first = before.Requested;
        // A request arrives while the old pump is still marked running, before its completion decision.
        bool scheduled = await Task.Run(before.Request);
        if (scheduled || !before.Complete(first) || !before.Running) throw new InvalidOperationException("LAYOUT_REQUEST_BEFORE_FINISH_LOST");
        if (before.Complete(before.Requested) || before.Running || before.Applied != before.Requested)
            throw new InvalidOperationException("LATEST_LAYOUT_NOT_APPLIED");
        var after = new LayoutRevisions();
        if (!after.Request() || after.Complete(after.Requested)) throw new InvalidOperationException("INITIAL_LAYOUT_NOT_FINISHED");
        // The alternative order: old completion wins first, so the next request must create a new pump.
        if (!await Task.Run(after.Request) || !after.Running) throw new InvalidOperationException("LAYOUT_REQUEST_AFTER_FINISH_LOST");
        if (after.Complete(after.Requested) || after.Applied != after.Requested || after.Running)
            throw new InvalidOperationException("NEW_LAYOUT_NOT_APPLIED");
        Console.WriteLine("{\"layoutCoalescing\":\"passed\",\"requestBeforeCompletion\":true,\"requestAfterCompletion\":true,\"gameCalls\":0}");
    }
}
