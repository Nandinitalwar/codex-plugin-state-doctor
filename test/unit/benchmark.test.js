import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  renderInstallBenchmark,
  runInstallBenchmark,
  summarizeLatency,
} from "../../src/benchmark.js";
import { parseBenchmarkArgs, runBenchmarkCli } from "../../src/benchmark-cli.js";
import { pluginEntry, writeHealthyPayload } from "../helpers.js";

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

test("benchmark argument parser requires an exact plugin and marketplace source", () => {
  assert.throws(
    () => parseBenchmarkArgs(["healthy@fixture"]),
    /marketplace-source is required/,
  );
  assert.throws(
    () => parseBenchmarkArgs([
      "healthy@fixture",
      "--marketplace-source",
      "/tmp/fixture",
      "--runs",
      "0",
    ]),
    /runs must be an integer/,
  );
  const parsed = parseBenchmarkArgs([
    "healthy@fixture",
    "--marketplace-source",
    "/tmp/fixture",
    "--runs",
    "5",
    "--json",
  ]);
  assert.equal(parsed.pluginId, "healthy@fixture");
  assert.equal(parsed.runs, 5);
  assert.equal(parsed.json, true);
});

test("latency summaries calculate median, p95, range, and mean", () => {
  assert.deepEqual(summarizeLatency([40, 10, 20, 30]), {
    min: 10,
    median: 25,
    p95: 40,
    max: 40,
    mean: 25,
  });
  assert.equal(summarizeLatency([]), null);
});

test("benchmark measures cold installs in isolated homes and cleans them up", (t) => {
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "doctor-benchmark-unit-"));
  const marketplaceSource = path.join(fixtureRoot, "marketplace");
  mkdirSync(marketplaceSource, { recursive: true });
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

  const tempRoots = [];
  const codexHomes = new Set();
  const plugin = pluginEntry({
    source: { source: "local", path: marketplaceSource },
  });
  const runCodex = ({ args, codexHome }) => {
    if (args[0] === "--version") return "codex-cli 1.2.3\n";
    codexHomes.add(codexHome);
    if (args[0] === "plugin" && args[1] === "marketplace") return "{}";
    if (args[0] === "plugin" && args[1] === "add") {
      writeHealthyPayload(codexHome, plugin);
      return "{}";
    }
    if (args[0] === "plugin" && args[1] === "list") {
      return JSON.stringify({ installed: [plugin], available: [] });
    }
    throw new Error(`unexpected command: ${args.join(" ")}`);
  };
  let clock = 0;
  const report = runInstallBenchmark(
    {
      pluginId: "healthy@fixture",
      marketplaceSource,
      runs: 2,
    },
    {
      runCodex,
      now: () => {
        const value = clock;
        clock += 5;
        return value;
      },
      makeTempRoot: () => {
        const root = mkdtempSync(path.join(fixtureRoot, "run-"));
        tempRoots.push(root);
        return root;
      },
    },
  );

  assert.equal(report.overallStatus, "ok");
  assert.equal(report.runsSucceeded, 2);
  assert.equal(report.summary.installCommandMs.median, 5);
  assert.equal(report.summary.timeToReadyMs.median, 10);
  assert.equal(codexHomes.size, 2);
  assert.ok(report.results.every((result) => result.doctorStatus === "ok"));
  assert.ok(tempRoots.every((root) => !existsSync(root)), "temporary homes are removed");
  assert.match(renderInstallBenchmark(report), /Time-to-ready: median 10\.00 ms/);
});

test("benchmark reports install failures without mutating the real Codex home", (t) => {
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "doctor-benchmark-fail-"));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  let clock = 0;
  const report = runInstallBenchmark(
    {
      pluginId: "healthy@fixture",
      marketplaceSource: "https://user:secret@example.com/marketplace.git",
      runs: 1,
    },
    {
      now: () => clock++,
      makeTempRoot: () => mkdtempSync(path.join(fixtureRoot, "run-")),
      runCodex: ({ args }) => {
        if (args[0] === "--version") return "codex-cli test";
        if (args[1] === "marketplace") return "{}";
        if (args[1] === "add") throw new Error("fixture install failed");
        throw new Error("unexpected command");
      },
    },
  );

  assert.equal(report.overallStatus, "fail");
  assert.equal(report.runsSucceeded, 0);
  assert.equal(
    report.marketplaceSource,
    "https://[credentials]@example.com/marketplace.git",
  );
  assert.equal(report.results[0].failedPhase, "installCommand");
  assert.match(report.results[0].error, /fixture install failed/);
});

test("benchmark CLI emits structured failures with exit code one", async () => {
  const { io, output } = captureIo();
  let clock = 0;
  const exitCode = await runBenchmarkCli(
    [
      "healthy@fixture",
      "--marketplace-source",
      "/tmp/fixture",
      "--runs",
      "1",
      "--json",
    ],
    io,
    {
      now: () => clock++,
      makeTempRoot: () => mkdtempSync(path.join(os.tmpdir(), "doctor-cli-fail-")),
      runCodex: ({ args }) => {
        if (args[0] === "--version") return "codex-cli test";
        throw new Error("fixture setup failed");
      },
    },
  );

  assert.equal(exitCode, 1);
  assert.equal(output.errors.length, 0);
  const report = JSON.parse(output.logs[0]);
  assert.equal(report.results[0].failedPhase, "marketplaceSetup");
});
