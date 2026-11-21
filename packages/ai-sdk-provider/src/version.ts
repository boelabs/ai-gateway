declare const __PACKAGE_VERSION__: string | undefined;

/** The package version, inlined by the build; `0.0.0-dev` when running from source. */
export const VERSION: string =
	typeof __PACKAGE_VERSION__ === "string" ? __PACKAGE_VERSION__ : "0.0.0-dev";
