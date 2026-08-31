import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { runInstallBenchmark } from "../../src/benchmark.js";
import { createReport } from "../../src/doctor.js";

const codexBin = process.env.CODEX_BIN || "codex";

function runCodex(args, codexHome) {
  return spawnSync(codexBin, args, {
    encoding: "utf8",
    env: { ...process.env, CODEX_HOME: codexHome },
  });
}

function requireCodex(t) {
  const version = spawnSync(codexBin, ["--version"], { encoding: "utf8" });
  if (version.status !== 0) {
    t.skip("Codex CLI is not installed");
    return false;
  }
  return true;
}

function writeMarketplace(root) {
  const pluginRoot = path.join(root, "plugins", "healthy");
  mkdirSync(path.join(root, ".agents", "plugins"), { recursive: true });
  mkdirSync(path.join(pluginRoot, ".codex-plugin"), { recursive: true });
  mkdirSync(path.join(pluginRoot, "skills", "health-check"), { recursive: true });
  writeFileSync(
    path.join(root, ".agents", "plugins", "marketplace.json"),
    JSON.stringify({
      name: "doctor-fixture",
      interface: { displayName: "Doctor Fixture" },
      plugins: [
        {
          name: "healthy",
          source: { source: "local", path: "./plugins/healthy" },
          policy: { installation: "AVAILABLE", authentication: "ON_USE" },
          category: "Developer Tools",
        },
      ],
    }),
  );
  writeFileSync(
    path.join(pluginRoot, ".codex-plugin", "plugin.json"),
    JSON.stringify({
      name: "healthy",
      version: "0.1.0",
      description: "Plugin doctor end-to-end fixture.",
      skills: "./skills/",
      interface: {
        displayName: "Healthy Fixture",
        shortDescription: "Exercise plugin cache integrity checks.",
        developerName: "Plugin Doctor",
        category: "Developer Tools",
      },
    }),
  );
  writeFileSync(
    path.join(pluginRoot, "skills", "health-check", "SKILL.md"),
    "---\nname: health-check\ndescription: Exercise the plugin doctor fixture.\n---\n\n# Fixture\n",
  );
}

test("detects the real Codex enabled-vs-missing-skills regression", (t) => {
  if (!requireCodex(t)) return;

  const root = mkdtempSync(path.join(os.tmpdir(), "codex-plugin-doctor-e2e-"));
  const codexHome = path.join(root, "codex-home");
  const marketplaceRoot = path.join(root, "marketplace");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(codexHome, { recursive: true });
  writeMarketplace(marketplaceRoot);

  const addMarketplace = runCodex(
    ["plugin", "marketplace", "add", marketplaceRoot, "--json"],
    codexHome,
  );
  assert.equal(addMarketplace.status, 0, addMarketplace.stderr || addMarketplace.stdout);

  const addPlugin = runCodex(
    ["plugin", "add", "healthy@doctor-fixture", "--json"],
    codexHome,
  );
  assert.equal(addPlugin.status, 0, addPlugin.stderr || addPlugin.stdout);

  const beforeList = runCodex(["plugin", "list", "--json"], codexHome);
  assert.equal(beforeList.status, 0, beforeList.stderr || beforeList.stdout);
  const beforeInventory = JSON.parse(beforeList.stdout);
  const installed = beforeInventory.installed.find(
    (plugin) => plugin.pluginId === "healthy@doctor-fixture",
  );
  assert.ok(installed, "fixture plugin should be installed");

  const healthyReport = createReport({
    inventory: beforeInventory,
    codexHome,
    codexVersion: "e2e",
    onlyPlugin: installed.pluginId,
  });
  assert.equal(healthyReport.overallStatus, "ok");

  const payloadPath = path.join(
    codexHome,
    "plugins",
    "cache",
    installed.marketplaceName,
    installed.name,
    installed.version,
  );
  assert.equal(existsSync(payloadPath), true, "Codex should materialize the cache payload");
  const skillsPath = path.join(payloadPath, "skills");
  const heldSkillsPath = path.join(payloadPath, "skills.held-by-test");
  assert.equal(existsSync(skillsPath), true, "Codex should materialize declared skills");
  renameSync(skillsPath, heldSkillsPath);

  const corruptedList = runCodex(["plugin", "list", "--json"], codexHome);
  assert.equal(corruptedList.status, 0, corruptedList.stderr || corruptedList.stdout);
  const corruptedInventory = JSON.parse(corruptedList.stdout);
  assert.ok(
    corruptedInventory.installed.some(
      (plugin) => plugin.pluginId === "healthy@doctor-fixture" && plugin.enabled,
    ),
    "regression precondition: Codex still reports the missing-skills plugin as enabled",
  );

  const corruptedReport = createReport({
    inventory: corruptedInventory,
    codexHome,
    codexVersion: "e2e",
    onlyPlugin: installed.pluginId,
  });
  assert.equal(corruptedReport.overallStatus, "fail");
  assert.equal(corruptedReport.checks["plugins.payloads"].status, "ok");
  assert.equal(corruptedReport.checks["plugins.skills"].status, "fail");
  assert.match(
    corruptedReport.checks["plugins.skills"].details.missing,
    /healthy@doctor-fixture/,
  );

  renameSync(heldSkillsPath, skillsPath);
  const repairedReport = createReport({
    inventory: corruptedInventory,
    codexHome,
    codexVersion: "e2e",
    onlyPlugin: installed.pluginId,
  });
  assert.equal(repairedReport.overallStatus, "ok");
});

test("measures a real Codex plugin installation in an isolated home", (t) => {
  if (!requireCodex(t)) return;

  const root = mkdtempSync(path.join(os.tmpdir(), "codex-plugin-benchmark-e2e-"));
  const marketplaceRoot = path.join(root, "marketplace");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeMarketplace(marketplaceRoot);

  const report = runInstallBenchmark({
    pluginId: "healthy@doctor-fixture",
    marketplaceSource: marketplaceRoot,
    runs: 1,
    codexBin,
  });

  assert.equal(report.overallStatus, "ok");
  assert.equal(report.runsSucceeded, 1);
  assert.equal(report.results[0].doctorStatus, "ok");
  assert.ok(report.results[0].installCommandMs >= 0);
  assert.ok(report.results[0].timeToReadyMs >= report.results[0].installCommandMs);
  assert.equal(report.temporaryHomesRetained, false);
});
