import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseArgs, runCli } from "../../src/cli.js";
import { pluginEntry, writeHealthyPayload } from "../helpers.js";

function cliFixture(t, { materialize = true } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-plugin-doctor-cli-"));
  const codexHome = path.join(root, ".codex");
  const sourcePath = path.join(root, "source");
  const listFile = path.join(root, "plugins.json");
  mkdirSync(sourcePath, { recursive: true });
  const plugin = pluginEntry({ source: { source: "local", path: sourcePath } });
  if (materialize) writeHealthyPayload(codexHome, plugin);
  writeFileSync(listFile, JSON.stringify({ installed: [plugin], available: [] }));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { codexHome, listFile };
}

function captureIo() {
  const output = { logs: [], errors: [] };
  return {
    output,
    io: {
      log: (value) => output.logs.push(value),
      error: (value) => output.errors.push(value),
    },
  };
}

test("argument parser requires option values", () => {
  assert.throws(() => parseArgs(["--plugin"]), /requires a value/);
  assert.throws(() => parseArgs(["--unknown"]), /unknown option/);
});

test("CLI emits JSON and exits zero for a healthy fixture", async (t) => {
  const { codexHome, listFile } = cliFixture(t);
  const { io, output } = captureIo();

  const exitCode = await runCli(
    ["--codex-home", codexHome, "--list-file", listFile, "--json"],
    io,
  );

  assert.equal(exitCode, 0);
  assert.equal(output.errors.length, 0);
  const report = JSON.parse(output.logs[0]);
  assert.equal(report.overallStatus, "ok");
});

test("CLI exits one when integrity checks fail", async (t) => {
  const { codexHome, listFile } = cliFixture(t, { materialize: false });
  const { io, output } = captureIo();

  const exitCode = await runCli(
    ["--codex-home", codexHome, "--list-file", listFile, "--json"],
    io,
  );

  assert.equal(exitCode, 1);
  const report = JSON.parse(output.logs[0]);
  assert.equal(report.checks["plugins.payloads"].status, "fail");
});

test("top-level CLI dispatches benchmark help", async () => {
  const { io, output } = captureIo();
  const exitCode = await runCli(["benchmark-install", "--help"], io);

  assert.equal(exitCode, 0);
  assert.equal(output.errors.length, 0);
  assert.match(output.logs[0], /Measure cold plugin installation latency/);
});
