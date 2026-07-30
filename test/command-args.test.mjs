import test from "node:test";
import assert from "node:assert/strict";
import { parseCleanupArgs, parseDigestArgs } from "../lib/command-args.mjs";
import { captureRuntime } from "../lib/runtime.mjs";

test("digest arguments are strict and accept only documented flags", () => {
  assert.deepEqual(parseDigestArgs(""), { hours: 24, markdown: false, notify: false });
  assert.deepEqual(parseDigestArgs("--notify --hours 2.5 --markdown"), { hours: 2.5, markdown: true, notify: true });
  for (const invalid of ["--hours", "--hours 0", "--hours -1", "--hours nope", "--hours=2", "extra", "--markdown extra"]) {
    assert.throws(() => parseDigestArgs(invalid), /usage: \/job digest/);
  }
});

test("cleanup arguments reject typos instead of applying cleanup", () => {
  assert.deepEqual(parseCleanupArgs(""), { dryRun: false });
  assert.deepEqual(parseCleanupArgs("--dry-run"), { dryRun: true });
  for (const invalid of ["--dryrun", "typo", "--dry-run extra", "--dry-run --dry-run"]) {
    assert.throws(() => parseCleanupArgs(invalid), /usage: \/job cleanup/);
  }
});

test("runtime provider and model resolve job then config then Pi defaults", () => {
  const defaults = { provider: "settings-provider", model: "settings-model" };
  const fromDefaults = captureRuntime({}, { piPath: null }, { piDefaults: defaults, piVersion: "1.2.3" });
  assert.equal(fromDefaults.provider, "settings-provider");
  assert.equal(fromDefaults.model, "settings-model");

  const fromConfig = captureRuntime({}, { provider: "config-provider", model: "config-model", piPath: null }, { piDefaults: defaults, piVersion: "1.2.3" });
  assert.equal(fromConfig.provider, "config-provider");
  assert.equal(fromConfig.model, "config-model");

  const fromJob = captureRuntime(
    { provider: "job-provider", model: "job-model" },
    { provider: "config-provider", model: "config-model", piPath: null },
    { piDefaults: defaults, piVersion: "1.2.3" },
  );
  assert.equal(fromJob.provider, "job-provider");
  assert.equal(fromJob.model, "job-model");
});
