import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createReport, diagnosePluginInventory } from "../../src/doctor.js";
import { pluginEntry, writeHealthyPayload } from "../helpers.js";

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-plugin-doctor-unit-"));
  const codexHome = path.join(root, ".codex");
  const sourcePath = path.join(root, "marketplace", "plugins", "healthy");
  mkdirSync(sourcePath, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const plugin = pluginEntry({ source: { source: "local", path: sourcePath } });
  return { root, codexHome, sourcePath, plugin };
}

test("healthy installed plugin passes all integrity checks", (t) => {
  const { codexHome, plugin } = fixture(t);
  writeHealthyPayload(codexHome, plugin);

  const result = diagnosePluginInventory({
    inventory: { installed: [plugin], available: [] },
    codexHome,
  });

  assert.equal(result.overallStatus, "ok");
  assert.deepEqual(
    Object.values(result.checks).map((item) => item.status),
    ["ok", "ok", "ok", "ok", "ok", "ok"],
  );
});

test("enabled plugin with a missing materialized payload fails", (t) => {
  const { codexHome, plugin } = fixture(t);

  const result = diagnosePluginInventory({
    inventory: { installed: [plugin], available: [] },
    codexHome,
  });

  assert.equal(result.overallStatus, "fail");
  assert.equal(result.checks["plugins.payloads"].status, "fail");
  assert.match(result.checks["plugins.payloads"].details.missing, /healthy@fixture/);
});

test("malformed cached manifest fails with actionable detail", (t) => {
  const { codexHome, plugin } = fixture(t);
  const payloadRoot = writeHealthyPayload(codexHome, plugin);
  writeFileSync(path.join(payloadRoot, ".codex-plugin", "plugin.json"), "{broken");

  const result = diagnosePluginInventory({
    inventory: { installed: [plugin], available: [] },
    codexHome,
  });

  assert.equal(result.checks["plugins.manifests"].status, "fail");
  assert.match(result.checks["plugins.manifests"].details.invalid, /healthy@fixture/);
  assert.match(result.checks["plugins.manifests"].remediation, /reinstall/);
});

test("declared skill folder without SKILL.md fails", (t) => {
  const { codexHome, plugin } = fixture(t);
  const payloadRoot = writeHealthyPayload(codexHome, plugin);
  rmSync(path.join(payloadRoot, "skills", "health-check", "SKILL.md"));

  const result = diagnosePluginInventory({
    inventory: { installed: [plugin], available: [] },
    codexHome,
  });

  assert.equal(result.checks["plugins.skills"].status, "fail");
  assert.match(result.checks["plugins.skills"].details.missing, /no SKILL\.md/);
});

test("manifest references cannot escape the plugin payload", (t) => {
  const { codexHome, plugin } = fixture(t);
  writeHealthyPayload(codexHome, plugin, { apps: "../../outside.app.json" });

  const result = diagnosePluginInventory({
    inventory: { installed: [plugin], available: [] },
    codexHome,
  });

  assert.equal(result.checks["plugins.dependencies"].status, "fail");
  assert.match(result.checks["plugins.dependencies"].details.invalid, /escapes/);
});

test("safe in-payload skill symlinks are accepted", (t) => {
  const { codexHome, plugin } = fixture(t);
  const payloadRoot = writeHealthyPayload(codexHome, plugin, {
    skills: "./linked-skills",
  });
  symlinkSync("./skills", path.join(payloadRoot, "linked-skills"));

  const result = diagnosePluginInventory({
    inventory: { installed: [plugin], available: [] },
    codexHome,
  });

  assert.equal(result.checks["plugins.skills"].status, "ok");
});

test("valid app and MCP dependency files pass", (t) => {
  const { codexHome, plugin } = fixture(t);
  const payloadRoot = writeHealthyPayload(codexHome, plugin, {
    apps: "./.app.json",
    mcpServers: "./.mcp.json",
  });
  writeFileSync(
    path.join(payloadRoot, ".app.json"),
    JSON.stringify({ apps: { fixture: { id: "plugin_asdk_app_fixture" } } }),
  );
  writeFileSync(
    path.join(payloadRoot, ".mcp.json"),
    JSON.stringify({ mcpServers: { fixture: { command: "node" } } }),
  );

  const result = diagnosePluginInventory({
    inventory: { installed: [plugin], available: [] },
    codexHome,
  });

  assert.equal(result.checks["plugins.dependencies"].status, "ok");
  assert.equal(
    result.checks["plugins.dependencies"].details["dependency files checked"],
    "2",
  );
});

test("missing local source is a warning when cached payload is healthy", (t) => {
  const { codexHome, sourcePath, plugin } = fixture(t);
  writeHealthyPayload(codexHome, plugin);
  rmSync(sourcePath, { recursive: true });

  const result = diagnosePluginInventory({
    inventory: { installed: [plugin], available: [] },
    codexHome,
  });

  assert.equal(result.overallStatus, "warning");
  assert.equal(result.checks["plugins.sources"].status, "warning");
});

test("report JSON follows codex doctor check-key conventions", (t) => {
  const { codexHome, plugin } = fixture(t);
  writeHealthyPayload(codexHome, plugin);

  const report = createReport({
    inventory: { installed: [plugin], available: [] },
    codexHome,
    codexVersion: "0.test",
  });

  assert.equal(report.schemaVersion, 1);
  assert.equal(report.codexVersion, "0.test");
  assert.equal(report.checks["plugins.payloads"].id, "plugins.payloads");
  assert.equal(report.checks["plugins.payloads"].durationMs, 0);
});
