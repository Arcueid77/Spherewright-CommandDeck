export type RecordingMask = { x: number; y: number; width: number; height: number };
export const recordingProfiles: Readonly<Record<string, Readonly<{ maxWidth: number; maxHeight: number; frameRate: number; bitsPerSecond: number }>>>;
export function recordingMasks(value: unknown): RecordingMask[];
export function recordingSize(width: number, height: number, profile: string): { width: number; height: number; frameRate: number };
