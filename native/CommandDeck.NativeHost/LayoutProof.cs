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

        var request = new ViewportRect { X = 200, Y = 40, Width = 900, Height = 600, Visible = true };
        var normal = GameWindowHost.ResolveViewport(1366, 768, true, request);
        if (normal is null || !normal.Visible || normal.X != 200 || normal.Y != 40 || normal.Width != 900 || normal.Height != 600)
            throw new InvalidOperationException("NORMAL_VIEWPORT_CHANGED");
        if (GameWindowHost.ResolveViewport(0, 0, true, request) is not null ||
            GameWindowHost.ResolveViewport(800, 0, true, request) is not null ||
            GameWindowHost.ResolveViewport(63, 600, true, request) is not null ||
            GameWindowHost.ResolveViewport(400, 1000, true, request) is not null)
            throw new InvalidOperationException("UNSAFE_HOST_MUST_RETAIN_GAME_SIZE");
        foreach (var tiny in new[] {
            new ViewportRect { X = 0, Y = 0, Width = 1, Height = 600, Visible = true },
            new ViewportRect { X = 1300, Y = 0, Width = 900, Height = 768, Visible = true },
            new ViewportRect { X = 0, Y = 0, Width = 300, Height = 768, Visible = true },
        })
        {
            var fallback = GameWindowHost.ResolveViewport(1366, 768, true, tiny);
            if (fallback is null || fallback.Visible || fallback.Width != 1366 || fallback.Height != 768)
                throw new InvalidOperationException("UNSAFE_VIEWPORT_FALLBACK_FAILED");
        }
        Console.WriteLine("{\"layoutCoalescing\":\"passed\",\"requestBeforeCompletion\":true,\"requestAfterCompletion\":true,\"renderTargetGuard\":true,\"gameCalls\":0}");
    }
}
