import test from "node:test";
import assert from "node:assert/strict";
import {
  DIGEST_NOTIFY_DEPRECATION, NO_NETWORK_DEPRECATION, NS_DEPRECATION,
  parseAddArgs, parseCleanupArgs, parseDigestArgs, parseJobIdArg, parseNoArgs, parseSetupPrArgs,
} from "../lib/command-args.mjs";
import { captureRuntime } from "../lib/runtime.mjs";

test("digest arguments are strict and accept only documented flags", () => {
  assert.deepEqual(parseDigestArgs(""), { hours: 24, markdown: false, notify: false, deprecatedNotify: false });
  assert.deepEqual(parseDigestArgs("--notify --hours 2.5 --markdown"), { hours: 2.5, markdown: true, notify: true, deprecatedNotify: true });
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

test("add arguments parse policies and preserve prompt after the option terminator", () => {
  const defaults = { budgetUsd: 2, timeoutMin: 30, maxTurns: 200, tools: ["read", "bash", "edit", "write"] };
  assert.deepEqual(parseAddArgs("fix tests --budget 1.5 --timeout 4 --max-turns 20 --tools read,edit,bash --delivery pr", defaults), {
    prompt: "fix tests", budgetUsd: 1.5, timeoutMin: 4, maxTurns: 20,
    tools: ["read", "edit", "bash"], noNetwork: false, deprecatedNoNetwork: false, delivery: "pr",
  });
  const offline = parseAddArgs("--no-network audit files", defaults);
  assert.equal(offline.noNetwork, true);
  assert.equal(offline.deprecatedNoNetwork, true);
  assert.deepEqual(offline.tools, ["read", "edit", "write"]);
  const recommended = parseAddArgs("--local-tools-only audit files", defaults);
  assert.equal(recommended.noNetwork, true);
  assert.equal(recommended.deprecatedNoNetwork, false);
  assert.deepEqual(recommended.tools, ["read", "edit", "write"]);
  assert.equal(parseAddArgs("--delivery branch -- explain --tools literally", defaults).prompt, "explain --tools literally");
});

test("add arguments reject unsafe or ambiguous policies", () => {
  const defaults = { budgetUsd: 2, timeoutMin: 30, maxTurns: 200 };
  for (const invalid of [
    "task --max-turns 0", "task --max-turns 1001", "task --max-turns 1.5",
    "task --tools read,unknown", "task --tools read,bash --no-network", "task --tools read,bash --local-tools-only",
    "task --no-network --local-tools-only", "task --local-tools-only --local-tools-only",
    "task --delivery issue", "task --budget 1 --budget 2", "task --unknown x", "--tools read",
  ]) assert.throws(() => parseAddArgs(invalid, defaults), /usage: \/job add/);
});

test("setup-pr and queue command arguments are strict", () => {
  assert.deepEqual(parseSetupPrArgs("--remote origin --base main"), { remote: "origin", base: "main" });
  assert.deepEqual(parseSetupPrArgs("--remote upstream"), { remote: "upstream", base: null });
  for (const invalid of ["", "origin", "--remote", "--remote origin extra", "--remote origin --remote fork"]) {
    assert.throws(() => parseSetupPrArgs(invalid), /usage: \/job setup-pr/);
  }
  assert.doesNotThrow(() => parseNoArgs("", "usage"));
  assert.throws(() => parseNoArgs("typo", "usage: /job pause"), /usage: \/job pause/);
  assert.equal(parseJobIdArg("job-1", "usage"), "job-1");
  assert.throws(() => parseJobIdArg("job-1 extra", "usage: /job prioritize <id>"), /usage: \/job prioritize/);
});

test("deprecated interfaces name their v2.0.0 removal and replacements", () => {
  assert.match(NO_NETWORK_DEPRECATION, /v2\.0\.0.*--local-tools-only/);
  assert.match(DIGEST_NOTIFY_DEPRECATION, /v2\.0\.0.*--markdown/);
  assert.match(NS_DEPRECATION, /v2\.0\.0/);
});
