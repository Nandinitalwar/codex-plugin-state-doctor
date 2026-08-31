import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";

import { createReport } from "./doctor.js";

const MAX_RUNS = 20;

function roundMs(value) {
  return Math.round(value * 100) / 100;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function safeMarketplaceSource(source) {
  return source.replace(/\/\/[^/@\s]+@/, "//[credentials]@");
}

function defaultRunCodex({ codexBin, args, codexHome = null }) {
  const result = spawnSync(codexBin, args, {
    encoding: "utf8",
    env: codexHome
      ? { ...process.env, CODEX_HOME: codexHome }
      : { ...process.env },
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) {
    throw new Error(`could not run ${codexBin}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const reason = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    throw new Error(reason);
  }
  return result.stdout;
}

function measure(action, now) {
  const startedAt = now();
  try {
    return {
      ok: true,
      value: action(),
      durationMs: roundMs(now() - startedAt),
    };
  } catch (error) {
    return {
      ok: false,
      error: errorMessage(error),
      durationMs: roundMs(now() - startedAt),
    };
  }
}

export function summarizeLatency(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
  const p95Index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
  const mean = sorted.reduce((total, value) => total + value, 0) / sorted.length;
  return {
    min: roundMs(sorted[0]),
    median: roundMs(median),
    p95: roundMs(sorted[p95Index]),
    max: roundMs(sorted.at(-1)),
    mean: roundMs(mean),
  };
}

function validateOptions({ pluginId, marketplaceSource, runs }) {
  const separator = pluginId.lastIndexOf("@");
  if (separator <= 0 || separator === pluginId.length - 1) {
    throw new Error("plugin must use the exact PLUGIN@MARKETPLACE selector");
  }
  if (typeof marketplaceSource !== "string" || marketplaceSource.length === 0) {
    throw new Error("marketplaceSource is required");
  }
  if (!Number.isInteger(runs) || runs < 1 || runs > MAX_RUNS) {
    throw new Error(`runs must be an integer from 1 to ${MAX_RUNS}`);
  }
}

function failureResult(run, phase, measurement, completed = {}) {
  return {
    run,
    status: "fail",
    failedPhase: phase,
    error: measurement.error,
    ...completed,
    [`${phase}Ms`]: measurement.durationMs,
  };
}

export function runInstallBenchmark(
  {
    pluginId,
    marketplaceSource,
    runs = 3,
    codexBin = "codex",
    keepTemp = false,
  },
  dependencies = {},
) {
  validateOptions({ pluginId, marketplaceSource, runs });

  const runCodex = dependencies.runCodex ?? defaultRunCodex;
  const now = dependencies.now ?? (() => performance.now());
  const makeTempRoot = dependencies.makeTempRoot
    ?? (() => mkdtempSync(path.join(os.tmpdir(), "codex-plugin-install-benchmark-")));
  const removeTempRoot = dependencies.removeTempRoot
    ?? ((root) => rmSync(root, { recursive: true, force: true }));
  const codexVersion = runCodex({
    codexBin,
    args: ["--version"],
  }).trim().replace(/^codex-cli\s+/, "");
  const results = [];

  for (let run = 1; run <= runs; run += 1) {
    const tempRoot = makeTempRoot(run);
    const codexHome = path.join(tempRoot, "codex-home");
    mkdirSync(codexHome, { recursive: true });

    try {
      const retainedHome = keepTemp ? { codexHome } : {};
      const setup = measure(
        () => runCodex({
          codexBin,
          codexHome,
          args: ["plugin", "marketplace", "add", marketplaceSource, "--json"],
        }),
        now,
      );
      if (!setup.ok) {
        results.push(failureResult(run, "marketplaceSetup", setup, retainedHome));
        continue;
      }

      const install = measure(
        () => runCodex({
          codexBin,
          codexHome,
          args: ["plugin", "add", pluginId, "--json"],
        }),
        now,
      );
      if (!install.ok) {
        results.push(failureResult(run, "installCommand", install, {
          marketplaceSetupMs: setup.durationMs,
          totalMs: roundMs(setup.durationMs + install.durationMs),
          ...retainedHome,
        }));
        continue;
      }

      const verification = measure(() => {
        const inventory = JSON.parse(runCodex({
          codexBin,
          codexHome,
          args: ["plugin", "list", "--json"],
        }));
        const report = createReport({
          inventory,
          codexHome,
          codexVersion,
          onlyPlugin: pluginId,
        });
        if (report.overallStatus === "fail") {
          const failedChecks = Object.values(report.checks)
            .filter((check) => check.status === "fail")
            .map((check) => check.id)
            .join(", ");
          throw new Error(`post-install doctor failed: ${failedChecks}`);
        }
        return report;
      }, now);
      if (!verification.ok) {
        results.push(failureResult(run, "verification", verification, {
          marketplaceSetupMs: setup.durationMs,
          installCommandMs: install.durationMs,
          timeToReadyMs: roundMs(install.durationMs + verification.durationMs),
          totalMs: roundMs(
            setup.durationMs + install.durationMs + verification.durationMs,
          ),
          ...retainedHome,
        }));
        continue;
      }

      results.push({
        run,
        status: "ok",
        marketplaceSetupMs: setup.durationMs,
        installCommandMs: install.durationMs,
        verificationMs: verification.durationMs,
        timeToReadyMs: roundMs(install.durationMs + verification.durationMs),
        totalMs: roundMs(
          setup.durationMs + install.durationMs + verification.durationMs,
        ),
        doctorStatus: verification.value.overallStatus,
        ...retainedHome,
      });
    } finally {
      if (!keepTemp) removeTempRoot(tempRoot);
    }
  }

  const successful = results.filter((result) => result.status === "ok");
  const summary = Object.fromEntries(
    ["marketplaceSetupMs", "installCommandMs", "verificationMs", "timeToReadyMs", "totalMs"]
      .map((field) => [
        field,
        summarizeLatency(successful.map((result) => result[field])),
      ]),
  );

  return {
    schemaVersion: 1,
    benchmark: "plugin-install",
    generatedAt: new Date().toISOString(),
    overallStatus: successful.length === runs ? "ok" : "fail",
    pluginId,
    marketplaceSource: safeMarketplaceSource(marketplaceSource),
    codexVersion,
    isolated: true,
    runsRequested: runs,
    runsSucceeded: successful.length,
    temporaryHomesRetained: keepTemp,
    results,
    summary,
  };
}

function duration(value) {
  return value === undefined ? "-" : `${value.toFixed(2)} ms`;
}

export function renderInstallBenchmark(report) {
  const lines = [
    "Codex Plugin Install Benchmark",
    `Plugin: ${report.pluginId}`,
    `Marketplace: ${report.marketplaceSource}`,
    "Isolation: fresh temporary CODEX_HOME per run",
    `Runs: ${report.runsSucceeded}/${report.runsRequested} successful`,
    "",
  ];

  for (const result of report.results) {
    if (result.status === "ok") {
      lines.push(
        `Run ${result.run}: install ${duration(result.installCommandMs)}, `
        + `verify ${duration(result.verificationMs)}, `
        + `time-to-ready ${duration(result.timeToReadyMs)}`,
      );
    } else {
      lines.push(
        `Run ${result.run}: FAIL during ${result.failedPhase} `
        + `after ${duration(result[`${result.failedPhase}Ms`])}: ${result.error}`,
      );
    }
  }

  if (report.summary.installCommandMs) {
    lines.push(
      "",
      `Install command: median ${duration(report.summary.installCommandMs.median)}, `
      + `p95 ${duration(report.summary.installCommandMs.p95)}`,
      `Time-to-ready: median ${duration(report.summary.timeToReadyMs.median)}, `
      + `p95 ${duration(report.summary.timeToReadyMs.p95)}`,
      `Marketplace setup: median ${duration(report.summary.marketplaceSetupMs.median)} `
      + "(reported separately)",
    );
  }

  if (report.temporaryHomesRetained) {
    lines.push("", "Temporary Codex homes were retained and are listed in the JSON results.");
  }
  return `${lines.join("\n")}\n`;
}
