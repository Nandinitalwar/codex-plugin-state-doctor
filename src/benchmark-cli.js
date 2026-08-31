import { runInstallBenchmark, renderInstallBenchmark } from "./benchmark.js";

export const BENCHMARK_HELP = `Usage: pdoctor benchmark-install PLUGIN@MARKETPLACE [options]

Measure cold plugin installation latency in fresh temporary Codex homes.

Options:
  --marketplace-source SOURCE  Local path, owner/repo, or Git URL (required)
  --runs N                    Independent cold-install runs (default: 3, max: 20)
  --codex-bin PATH            Codex executable (default: codex)
  --keep-temp                 Retain temporary Codex homes for inspection
  --json                      Emit a structured benchmark report
  -h, --help                  Show this help
`;

export function parseBenchmarkArgs(argv) {
  const options = {
    pluginId: null,
    marketplaceSource: null,
    runs: 3,
    codexBin: "codex",
    keepTemp: false,
    json: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      options.json = true;
    } else if (argument === "--keep-temp") {
      options.keepTemp = true;
    } else if (argument === "-h" || argument === "--help") {
      options.help = true;
    } else if (["--marketplace-source", "--runs", "--codex-bin"].includes(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${argument} requires a value`);
      }
      index += 1;
      if (argument === "--marketplace-source") options.marketplaceSource = value;
      if (argument === "--codex-bin") options.codexBin = value;
      if (argument === "--runs") {
        options.runs = Number(value);
        if (!Number.isInteger(options.runs) || options.runs < 1 || options.runs > 20) {
          throw new Error("--runs must be an integer from 1 to 20");
        }
      }
    } else if (!argument.startsWith("-") && options.pluginId === null) {
      options.pluginId = argument;
    } else {
      throw new Error(`unknown benchmark option: ${argument}`);
    }
  }

  if (!options.help) {
    if (!options.pluginId) throw new Error("benchmark-install requires PLUGIN@MARKETPLACE");
    if (!options.marketplaceSource) throw new Error("--marketplace-source is required");
  }
  return options;
}

export async function runBenchmarkCli(argv, io = console, dependencies = {}) {
  let options;
  try {
    options = parseBenchmarkArgs(argv);
  } catch (error) {
    io.error(`pdoctor: ${error.message}`);
    return 2;
  }
  if (options.help) {
    io.log(BENCHMARK_HELP.trimEnd());
    return 0;
  }

  let report;
  try {
    report = runInstallBenchmark(options, dependencies);
  } catch (error) {
    io.error(`pdoctor: ${error.message}`);
    return 2;
  }
  io.log(options.json
    ? JSON.stringify(report, null, 2)
    : renderInstallBenchmark(report).trimEnd());
  return report.overallStatus === "ok" ? 0 : 1;
}
