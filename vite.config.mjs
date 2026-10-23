import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { dockviewPointerCompatibility } from "./scripts/dockview-pointer-compat.mjs";
export default defineConfig({
	plugins: [dockviewPointerCompatibility()],
	root: fileURLToPath(new URL("./apps/renderer", import.meta.url)),
	base: "./",
	build: {
		outDir: "../../dist/renderer",
		emptyOutDir: true,
		license: { fileName: "THIRD-PARTY-LICENSES.md" },
		rolldownOptions: {
			output: {
				codeSplitting: {
					groups: [
						{ name: "react", test: /node_modules[\\/]react/ },
						{ name: "dockview", test: /node_modules[\\/]dockview/ },
					],
				},
			},
		},
	},
});
