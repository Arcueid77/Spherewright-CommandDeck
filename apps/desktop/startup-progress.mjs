export const startupBlockedStages = Object.freeze(["creating-window", "window-created", "loading-document", "document-loaded", "window-shown", "inspecting-page", "page-inspected", "proof-written", "exit-requested"]);
export const startupStagePrefix = "COMMANDDECK_STARTUP_STAGE:";
export function startupProgress(stage) { if (process.argv.includes("--portable-smoke") && startupBlockedStages.includes(stage)) console.log(startupStagePrefix + stage); }
