import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const metadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

export const PACKAGE_NAME = metadata.name;
export const PACKAGE_VERSION = metadata.version;

export function packageInfo() {
  return {
    name: PACKAGE_NAME,
    version: PACKAGE_VERSION,
    root: PACKAGE_ROOT,
  };
}
