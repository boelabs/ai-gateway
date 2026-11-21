import pkg from "./package.json" with { type: "json" };
import { defineConfig } from "tsdown";

export default defineConfig({
	entry: ["src/index.ts"],
	define: { __PACKAGE_VERSION__: JSON.stringify(pkg.version) },
	format: ["esm"],
	platform: "neutral",
	dts: { tsconfig: "tsconfig.build.json" },
	sourcemap: true,
	clean: true,
});
