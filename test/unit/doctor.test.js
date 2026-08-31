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
    ["ok", "ok", "ok", "ok", "ok", "ok", "ok", "ok", "ok", "ok"],
  );
});

test("same-version source changes are detected as stale cached payloads", (t) => {
  const { codexHome, sourcePath, plugin } = fixture(t);
  writeHealthyPayload(codexHome, plugin);
  writeFileSync(
    path.join(sourcePath, "skills", "health-check", "SKILL.md"),
    "---\nname: health-check\ndescription: Updated without a version bump.\n---\n",
  );

  const result = diagnosePluginInventory({
    inventory: { installed: [plugin], available: [] },
    codexHome,
  });

  assert.equal(result.checks["plugins.provenance"].status, "fail");
  assert.match(result.checks["plugins.provenance"].details.drift, /SKILL\.md/);
});

test("missing marketplace roots are reported separately from plugin cache state", (t) => {
  const { root, codexHome, plugin } = fixture(t);
  writeHealthyPayload(codexHome, plugin);

  const result = diagnosePluginInventory({
    inventory: { installed: [plugin], available: [] },
    marketplaceInventory: {
      marketplaces: [
        { name: plugin.marketplaceName, root: path.join(root, "missing-marketplace") },
      ],
    },
    codexHome,
  });

  assert.equal(result.checks["plugins.marketplaces"].status, "fail");
  assert.match(result.checks["plugins.marketplaces"].details.missing, /fixture/);
});

test("latest cache pointers must resolve to the installed version", (t) => {
  const { codexHome, plugin } = fixture(t);
  const payloadRoot = writeHealthyPayload(codexHome, plugin);
  const pluginCacheRoot = path.dirname(payloadRoot);
  mkdirSync(path.join(pluginCacheRoot, "0.0.9"), { recursive: true });
  symlinkSync("0.0.9", path.join(pluginCacheRoot, "latest"));

  const result = diagnosePluginInventory({
    inventory: { installed: [plugin], available: [] },
    codexHome,
  });

  assert.equal(result.checks["plugins.cache_pointers"].status, "fail");
  assert.match(result.checks["plugins.cache_pointers"].details.stale, /0\.0\.9/);
});

test("recent sessions fail when injected skills reference superseded cache versions", (t) => {
  const { codexHome, plugin } = fixture(t);
  writeHealthyPayload(codexHome, plugin);
  const obsoleteRoot = path.join(
    codexHome,
    "plugins",
    "cache",
    plugin.marketplaceName,
    plugin.name,
    "0.0.9",
  );
  mkdirSync(path.join(obsoleteRoot, "skills", "health-check"), { recursive: true });
  const sessionsRoot = path.join(codexHome, "sessions", "2026", "08", "31");
  mkdirSync(sessionsRoot, { recursive: true });
  const sessionPath = path.join(sessionsRoot, "rollout-stale.jsonl");
  writeFileSync(
    sessionPath,
    `${JSON.stringify({
      type: "world_state",
      payload: {
        state: {
          host_skills: {
            body: `skill location: ${path.join(obsoleteRoot, "skills", "health-check", "SKILL.md")}`,
          },
        },
      },
    })}\n`,
  );

  const result = diagnosePluginInventory({
    inventory: { installed: [plugin], available: [] },
    codexHome,
    nowMs: Date.now(),
  });

  assert.equal(result.checks["plugins.sessions"].status, "fail");
  assert.match(result.checks["plugins.sessions"].details.stale, /installed version is 0\.1\.0/);
});

test("ordinary conversation text containing an old cache path is ignored", (t) => {
  const { codexHome, plugin } = fixture(t);
  writeHealthyPayload(codexHome, plugin);
  const sessionsRoot = path.join(codexHome, "sessions");
  mkdirSync(sessionsRoot, { recursive: true });
  writeFileSync(
    path.join(sessionsRoot, "rollout-message-only.jsonl"),
    `${JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: path.join(
          codexHome,
          "plugins",
          "cache",
          plugin.marketplaceName,
          plugin.name,
          "0.0.9",
          "SKILL.md",
        ),
      },
    })}\n`,
  );

  const result = diagnosePluginInventory({
    inventory: { installed: [plugin], available: [] },
    codexHome,
  });

  assert.equal(result.checks["plugins.sessions"].status, "ok");
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
