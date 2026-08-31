import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { createReport, renderHuman } from "./doctor.js";

const HELP = `Usage: codex-plugin-doctor [options]

Read-only integrity diagnostics for installed Codex plugins.

Options:
  --codex-home PATH  Codex state directory (default: CODEX_HOME or ~/.codex)
  --codex-bin PATH   Codex executable (default: codex)
  --plugin ID        Check one exact plugin id, such as gmail@openai-curated
  --list-file PATH   Read saved 'codex plugin list --json' output (for tests)
  --json             Emit an official codex-doctor-style JSON report
  --summary          Omit details for non-passing checks
  -h, --help         Show this help
`;

export function parseArgs(argv) {
  const options = {
    codexHome: process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
    codexBin: "codex",
    onlyPlugin: null,
    listFile: null,
    json: false,
    summary: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      options.json = true;
    } else if (argument === "--summary") {
      options.summary = true;
    } else if (argument === "-h" || argument === "--help") {
      options.help = true;
    } else if (["--codex-home", "--codex-bin", "--plugin", "--list-file"].includes(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${argument} requires a value`);
      }
      index += 1;
      if (argument === "--codex-home") options.codexHome = value;
      if (argument === "--codex-bin") options.codexBin = value;
      if (argument === "--plugin") options.onlyPlugin = value;
      if (argument === "--list-file") options.listFile = value;
    } else {
      throw new Error(`unknown option: ${argument}`);
    }
  }
  return options;
}

function run(command, args, options) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: { ...process.env, CODEX_HOME: options.codexHome },
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) {
    throw new Error(`could not run ${command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const reason = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    throw new Error(`${command} ${args.join(" ")} failed: ${reason}`);
  }
  return result.stdout;
}

function loadInputs(options) {
  if (options.listFile) {
    return {
      inventory: JSON.parse(readFileSync(options.listFile, "utf8")),
      codexVersion: "fixture",
    };
  }

  const inventory = JSON.parse(
    run(options.codexBin, ["plugin", "list", "--json"], options),
  );
  const versionOutput = run(options.codexBin, ["--version"], options).trim();
  const codexVersion = versionOutput.replace(/^codex-cli\s+/, "");
  return { inventory, codexVersion };
}

export async function runCli(argv, io = console) {
  const options = parseArgs(argv);
  if (options.help) {
    io.log(HELP.trimEnd());
    return 0;
  }

  let inputs;
  try {
    inputs = loadInputs(options);
  } catch (error) {
    io.error(`codex-plugin-doctor: ${error.message}`);
    return 2;
  }

  const report = createReport({
    ...inputs,
    codexHome: path.resolve(options.codexHome),
    onlyPlugin: options.onlyPlugin,
  });
  if (options.json) {
    io.log(JSON.stringify(report, null, 2));
  } else {
    io.log(renderHuman(report, { summary: options.summary }).trimEnd());
  }
  return report.overallStatus === "fail" ? 1 : 0;
}
