import { readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, sep } from "node:path";

export const rendererScheme = "deck-ui";
export const rendererUrl = "deck-ui://app/index.html";
export const popoutUrl = "deck-ui://app/popout.html";
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" };

// Only the built UI's entry points and flat Vite assets are served. This is not
// a filesystem URL resolver, and neither query strings nor encoded paths count.
export function rendererAsset(url, method = "GET") {
	if (!["GET", "HEAD"].includes(method) || typeof url !== "string") return null;
	const match = /^deck-ui:\/\/app\/(index\.html|popout\.html|assets\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:js|css|svg|png|woff2))$/.exec(url);
	return match?.[1] ?? null;
}
export function createRendererProtocol(directory) {
	return async request => {
		const asset = rendererAsset(request.url, request.method);
		if (!asset) return new Response(null, { status: 404 });
		try {
			const root = await realpath(directory), file = await realpath(join(root, asset));
			const inside = relative(root, file);
			if (!inside || isAbsolute(inside) || inside === ".." || inside.startsWith(".." + sep)) return new Response(null, { status: 404 });
			const info = await stat(file);
			if (!info.isFile() || info.size > 16 * 1024 * 1024) return new Response(null, { status: 404 });
			return new Response(request.method === "HEAD" ? null : await readFile(file), { headers: { "Content-Type": types[extname(asset)], "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" } });
		} catch { return new Response(null, { status: 404 }); }
	};
}
