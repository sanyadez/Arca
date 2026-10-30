/** Version from package.json; the release build injects the commit (`--define BUILD_COMMIT=…`). */
import pkg from "../package.json" with { type: "json" };

declare const BUILD_COMMIT: string | undefined;

export const VERSION: string = pkg.version;
export const COMMIT: string = typeof BUILD_COMMIT === "string" ? BUILD_COMMIT : "dev";
export const VERSION_STRING = `${VERSION} (${COMMIT})`;
