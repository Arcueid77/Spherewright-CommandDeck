export const recordingProfiles = Object.freeze({ "720p15": Object.freeze({ maxWidth: 1280, maxHeight: 720, frameRate: 15, bitsPerSecond: 1500000 }), "1080p30": Object.freeze({ maxWidth: 1920, maxHeight: 1080, frameRate: 30, bitsPerSecond: 4000000 }) });
export function recordingMasks(value) {
	if (!Array.isArray(value) || value.length > 8) throw new Error("VIDEO_MASKS_INVALID");
	return value.map(row => {
		if (!row || typeof row !== "object" || Array.isArray(row) || Object.keys(row).sort().join(",") !== "height,width,x,y" || ![row.x, row.y, row.width, row.height].every(Number.isSafeInteger) || row.x < 0 || row.y < 0 || row.width < 1 || row.height < 1 || row.x + row.width > 10000 || row.y + row.height > 10000) throw new Error("VIDEO_MASKS_INVALID");
		return Object.freeze({ x: row.x, y: row.y, width: row.width, height: row.height });
	});
}
export function recordingSize(width, height, profile) {
	if (![width, height].every(value => Number.isInteger(value) && value >= 2 && value <= 32768) || !Object.hasOwn(recordingProfiles, profile)) throw new Error("VIDEO_TRACK_INVALID");
	const limit = recordingProfiles[profile], scale = Math.min(1, limit.maxWidth / width, limit.maxHeight / height);
	return { width: Math.max(2, Math.floor(width * scale / 2) * 2), height: Math.max(2, Math.floor(height * scale / 2) * 2), frameRate: limit.frameRate };
}
