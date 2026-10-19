import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
export default defineConfig({
	root: fileURLToPath(new URL("./apps/renderer", import.meta.url)),
	base: "./",
	build: {
		outDir: "../../dist/renderer",
		emptyOutDir: true,
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
