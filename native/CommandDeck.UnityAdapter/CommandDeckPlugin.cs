using BepInEx;
using CommandDeck.AdapterBridge;
using CommandDeck.Windowing;
using UnityEngine;

namespace CommandDeck.UnityAdapter;

[BepInPlugin("dev.spherewright.commanddeck.window", "CommandDeck Window Adapter", AdapterServer.Version)]
[BepInProcess("DSPGAME.exe")]
public sealed class CommandDeckPlugin : BaseUnityPlugin
{
    private AdapterServer? server;
    private bool optedIn, failed;
    private nint unityWindow;
    private long updateSequence;
    private void Awake()
    {
        optedIn = Environment.GetCommandLineArgs().Contains("--commanddeck-host", StringComparer.Ordinal);
        Logger.LogInfo(optedIn ? "CommandDeck window adapter opted in; no game-world API enabled." : "CommandDeck window adapter inactive; launch opt-in is absent.");
    }
    private void Update()
    {
        if (!optedIn || failed) return;
        try
        {
            if (!GameWindowHost.IsCurrentProcessWindow(unityWindow)) unityWindow = GameWindowHost.FindCurrentUnityWindow();
            if (unityWindow == 0) return;
            bool start = server == null;
            if (start) server = new AdapterServer();
            // Unity API access stays on Unity's main thread. No display preferences are written.
            server!.UpdateWindowFacts(new WindowFacts(unityWindow, Screen.fullScreenMode == FullScreenMode.Windowed, Application.unityVersion,
                ++updateSequence, Screen.width, Screen.height));
            if (start)
            {
                server.Start();
                Logger.LogInfo("CommandDeck window endpoint ready; explicit desktop selection is required to create the host.");
            }
        }
        catch (Exception error)
        {
            failed = true;
            Logger.LogError("CommandDeck window adapter unavailable (" + error.GetType().Name + "); no game-world operation was requested.");
            if (server != null) _ = server.StopAsync();
        }
    }
    private void OnDestroy()
    {
        // Never synchronously wait here: native restoration may need the Unity message thread.
        if (server != null) _ = server.StopAsync();
    }
}
