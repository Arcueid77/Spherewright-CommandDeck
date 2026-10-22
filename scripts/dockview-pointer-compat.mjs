import { createHash } from "node:crypto";

// Dockview 8.6.0's pointer controller starts on the threshold-crossing move,
// but only hit-tests a later move. A release immediately after promotion can
// therefore miss its target. Keep this one-line correction tied to exact
// upstream bytes; dependency upgrades must deliberately revalidate it.
const sourceSha256 = "BDCBA92DB8DDBBBDE0379D4DDBB634CD0BD9299BD551BFFD1A9A9F7D01B1CFC1";
const anchor = "\t\t\tthis._handleEnd(e, false);\n\t\t});\n\t}\n\tcancel() {";
const corrected = "\t\t\tthis._handleEnd(e, false);\n\t\t});\n\t\tthis._handleMove(pointerEvent);\n\t}\n\tcancel() {";

export function correctDockviewPointerStart(source) {
	if (createHash("sha256").update(source).digest("hex").toUpperCase() !== sourceSha256 || source.indexOf(anchor) < 0 || source.indexOf(anchor) !== source.lastIndexOf(anchor))
		throw new Error("DOCKVIEW_POINTER_SOURCE_CHANGED: revalidate the pinned dependency before building.");
	return source.replace(anchor, corrected);
}

export function dockviewPointerCompatibility() {
	let applied = false;
	return {
		name: "commanddeck-dockview-pointer-compatibility",
		enforce: "pre",
		buildStart() { applied = false; },
		transform(source, id) {
			if (!id.replaceAll("\\", "/").endsWith("/dockview-core/dist/package/main.esm.mjs")) return;
			const code = correctDockviewPointerStart(source);
			applied = true;
			return { code, map: null };
		},
		buildEnd(error) { if (!error && !applied) throw new Error("DOCKVIEW_POINTER_FIX_NOT_APPLIED"); },
	};
}
