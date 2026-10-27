// DOM-only function shared with the encoded-media fixture. Raw frames stay in
// Chromium. Masks round outwards so even partial boundary
// pixels are covered before a canvas track reaches the encoder.
export function paintMaskedVideo(context, source, width, height, masks) {
	if (![width, height].every(value => Number.isInteger(value) && value >= 2) || width > 1920 || height > 1080 || !Array.isArray(masks) || masks.length > 8) throw new Error("VIDEO_FRAME_INVALID");
	for (const mask of masks) if (!mask || ![mask.x, mask.y, mask.width, mask.height].every(Number.isSafeInteger) || mask.x < 0 || mask.y < 0 || mask.width < 1 || mask.height < 1 || mask.x + mask.width > 10000 || mask.y + mask.height > 10000) throw new Error("VIDEO_MASKS_INVALID");
	context.save();
	try {
		context.resetTransform(); context.globalAlpha = 1; context.globalCompositeOperation = "source-over"; context.filter = "none"; context.shadowColor = "transparent";
		context.fillStyle = "#000"; context.fillRect(0, 0, width, height); context.drawImage(source, 0, 0, width, height);
		context.fillStyle = "#000";
		for (const mask of masks) { const x = Math.floor(mask.x * width / 10000), y = Math.floor(mask.y * height / 10000); context.fillRect(x, y, Math.ceil((mask.x + mask.width) * width / 10000) - x, Math.ceil((mask.y + mask.height) * height / 10000) - y); }
	} finally { context.restore(); }
}
