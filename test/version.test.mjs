import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PACKAGE_NAME, PACKAGE_ROOT, PACKAGE_VERSION, packageInfo } from "../lib/version.mjs";

test("runtime version metadata matches package.json", () => {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(PACKAGE_NAME, manifest.name);
  assert.equal(PACKAGE_VERSION, manifest.version);
  assert.equal(PACKAGE_ROOT, root);
  assert.deepEqual(packageInfo(), { name: manifest.name, version: manifest.version, root });
});
