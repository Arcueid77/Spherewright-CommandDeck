import { spawnSync } from "node:child_process";
import {
	existsSync,
	readFileSync,
	realpathSync,
	mkdirSync,
	writeFileSync,
} from "node:fs";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const pi = join(root, "vendor/pi");
const expected = "71023aec1546d6d677a65669c5665c0927ce0dd0";
function run(cmd, args, cwd) {
	const result = spawnSync(cmd, args, {
		cwd,
		stdio: "inherit",
		windowsHide: true,
	});
	if (result.error || result.status !== 0)
		throw new Error(`Pi source command failed: ${cmd}`);
}
const head = spawnSync("git", ["rev-parse", "HEAD"], {
	cwd: pi,
	encoding: "utf8",
	windowsHide: true,
});
if (head.status !== 0 || head.stdout.trim() !== expected)
	throw new Error(
		"Unexpected Pi source pin. Review the integration baseline first.",
	);
const operation = process.argv[2];
if (operation === "hydrate") {
	const cache = join(root, ".local/pi-model-data");
	mkdirSync(cache, { recursive: true });
	const npm =
		process.env.npm_execpath ??
		join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
	const packed = spawnSync(
		process.execPath,
		[
			npm,
			"pack",
			"@earendil-works/pi-ai@1.3.0",
			"--ignore-scripts",
			"--json",
			"--pack-destination",
			cache,
		],
		{ cwd: root, encoding: "utf8", windowsHide: true },
	);
	if (packed.status !== 0)
		throw new Error(
			"Could not obtain the versioned public model-data artifact.",
		);
	const metadata = JSON.parse(packed.stdout)[0];
	const archive = readFileSync(join(cache, metadata.filename));
	const integrity =
		"sha512-" + createHash("sha512").update(archive).digest("base64");
	if (metadata.integrity !== integrity)
		throw new Error("Model-data artifact integrity mismatch.");
	const lockPath = join(root, "pi-model-data-lock.json");
	if (
		existsSync(lockPath) &&
		JSON.parse(readFileSync(lockPath, "utf8")).integrity !== integrity
	)
		throw new Error("The pinned model-data artifact changed.");
	const tar = gunzipSync(archive, { maxOutputLength: 80 * 1024 * 1024 });
	const prefix = "package/dist/providers/data/";
	let count = 0;
	const target = join(pi, "packages/ai/src/providers/data");
	mkdirSync(target, { recursive: true });
	for (let offset = 0; offset + 512 <= tar.length; ) {
		const name = tar
			.subarray(offset, offset + 100)
			.toString()
			.split("\0")[0];
		if (!name) break;
		const size = parseInt(
			tar
				.subarray(offset + 124, offset + 136)
				.toString()
				.replaceAll("\0", "")
				.trim() || "0",
			8,
		);
		if (
			!Number.isSafeInteger(size) ||
			size < 0 ||
			offset + 512 + size > tar.length
		)
			throw new Error("Invalid model-data archive.");
		if (name.startsWith(prefix) && name.endsWith(".json")) {
			const file = name.slice(prefix.length);
			if (
				!/^(?:\.manifest|[a-z0-9-]+)\.json$/.test(file) ||
				![0, 48].includes(tar[offset + 156])
			)
				throw new Error("Unexpected model-data member.");
			const data = tar.subarray(offset + 512, offset + 512 + size);
			JSON.parse(data.toString("utf8"));
			writeFileSync(join(target, file), data);
			count++;
		}
		offset += 512 + Math.ceil(size / 512) * 512;
	}
	if (count < 2)
		throw new Error("Versioned package has no complete model-data catalog.");
	writeFileSync(
		lockPath,
		JSON.stringify(
			{
				package: "@earendil-works/pi-ai",
				version: "1.3.0",
				integrity,
				dataFiles: count,
				sourceCommit: expected,
			},
			null,
			2,
		) + "\n",
	);
	console.log(
		`Hydrated ${count} JSON metadata files; no registry source modules are used.`,
	);
} else if (operation === "install" || operation === "build") {
	const npm =
		process.env.npm_execpath ??
		join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
	if (!existsSync(npm))
		throw new Error("Run through the documented npm script.");
	const workspaces = [
		"chord",
		"tui",
		"telemetry",
		"codemode",
		"mcp",
		"ai",
		"durable",
		"env",
		"agent",
		"coding-agent",
	].map((name) => `--workspace=packages/${name}`);
	run(
		process.execPath,
		[
			npm,
			...(operation === "install"
				? ["ci", "--ignore-scripts", "--include-workspace-root", ...workspaces]
				: ["run", "build:offline"]),
		],
		pi,
	);
} else if (operation === "verify") {
	const packages = ["coding-agent", "agent", "ai", "codemode", "mcp", "tui"];
	const proof = packages.map((name) => {
		const directory = join(pi, "packages", name);
		const manifest = JSON.parse(
			readFileSync(join(directory, "package.json"), "utf8"),
		);
		if (
			realpathSync(join(pi, "node_modules", manifest.name)) !==
			realpathSync(directory)
		)
			throw new Error(
				"An internal Pi dependency did not resolve to the fork workspace.",
			);
		const sourceEntry = realpathSync(
			join(directory, manifest.main ?? "dist/index.js"),
		);
		if (!sourceEntry.startsWith(realpathSync(pi)))
			throw new Error("Pi entry escaped the source fork.");
		return {
			package: manifest.name,
			version: manifest.version,
			entry: relative(root, sourceEntry).replaceAll("\\", "/"),
		};
	});
	console.log(
		JSON.stringify({ sourceCommit: expected, packages: proof }, null, 2),
	);
} else throw new Error("Choose install, hydrate, build or verify.");
