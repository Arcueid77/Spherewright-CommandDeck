import { lstat, readdir, realpath, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// npm's installed tree contains a built-in .npmrc. Do not read or copy any
// such configuration: the fixture supplies its own empty config and cache.
// This copier is only for an explicit developer toolchain, never a bundle.
export async function copyCommandToolchain(source, target) {
	let entries = 0, bytes = 0;
	async function copy(from, to) {
		if (++entries > 8192) throw new Error("COMMAND_TOOLCHAIN_TOO_LARGE");
		const info = await lstat(from);
		if (info.isSymbolicLink() || (await realpath(from)).toLowerCase() !== from.toLowerCase() || !info.isDirectory() && (!info.isFile() || info.nlink !== 1)) throw new Error("COMMAND_TOOLCHAIN_REDIRECTED");
		if (info.isDirectory()) {
			await mkdir(to);
			for (const name of await readdir(from)) {
				if (name.toLowerCase() === ".npmrc") continue;
				if (/^(?:\.git|\.local|\.pi|\.env(?:\..*)?)$/i.test(name)) throw new Error("COMMAND_TOOLCHAIN_PRIVATE_CONFIG");
				await copy(join(from, name), join(to, name));
			}
		} else {
			bytes += info.size;
			if (info.size > 268435456 || bytes > 402653184) throw new Error("COMMAND_TOOLCHAIN_TOO_LARGE");
			await writeFile(to, await readFile(from), { flag: "wx" });
		}
	}
	await copy(source, target);
	return { entries, bytes, npmConfigurationExcluded: true };
}
