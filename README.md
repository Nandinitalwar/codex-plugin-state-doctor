# Codex Plugin State Doctor

A prototype for missing plugin integrity and installation-performance signals
in Codex. Its doctor catches the state mismatch where `codex plugin list`
reports a plugin as installed and enabled but the materialized payload is absent
or unusable. Its benchmark measures cold installation latency without changing
the user's real Codex state.

This is deliberately a standalone CLI rather than a plugin: a diagnostic tool
must still work when the plugin loader itself is broken. Its report mirrors the
stable, keyed check shape emitted by `codex doctor --json`, making the checks
straightforward to port into the official Rust command.

## What exists today

This repository implements the diagnostic slice of a possible larger Plugin
DevKit. It does not yet implement the whole plugin lifecycle.

| DevKit capability | Status | Current scope |
| --- | --- | --- |
| `plugin doctor` | Implemented | Reconciles Codex's installed-plugin inventory with cached payloads, manifests, skills, app/MCP configuration files, and local sources. |
| `benchmark-install` | Implemented | Times marketplace setup, `codex plugin add`, post-install verification, and time-to-ready in a fresh temporary `CODEX_HOME` for every run. |
| `plugin validate` | Partial | The doctor validates deterministic invariants in an installed cached package. It does not validate an arbitrary source plugin against a complete, versioned publishing schema. |
| `plugin test` | Partial | The project has unit and real-Codex regression tests, but it does not expose a headless command for testing skill activation, tool selection, UI, authentication, or complete workflows. |
| `plugin init` | Not implemented | Plugin scaffolding remains outside this project. |
| `plugin pack` | Not implemented | The project does not build or sign distributable plugin packages. |
| `plugin submit` | Not implemented | The project does not create submission drafts, upload versions, or publish plugins. |
| Live runtime diagnosis | Not implemented | The doctor does not currently probe MCP initialization, `tools/list`, OAuth readiness, loader registration, or active-session tool exposure. |

## Why this exists: community reports

Public `openai/codex` issues repeatedly describe a plugin as installed or
enabled while some later stage of the capability chain is missing:

```text
marketplace known
  -> plugin selected
  -> cache materialized
  -> package valid
  -> skills registered
  -> MCP/app dependency ready
  -> tools exposed in the active session
```

The table below groups 20 public reports by the complaint they represent. Issue
status and root cause may change; the reports establish recurring failure
classes, not that every report remains reproducible on every current build.

| Community complaint | Public reports |
| --- | --- |
| Inventory or policy says a plugin is present, but its payload, skills, or durable marketplace source is absent. | [#34321](https://github.com/openai/codex/issues/34321), [#29103](https://github.com/openai/codex/issues/29103), [#28924](https://github.com/openai/codex/issues/28924), [#26451](https://github.com/openai/codex/issues/26451) |
| Marketplace, bundled source, installed cache, or long-running session keeps stale content. | [#19834](https://github.com/openai/codex/issues/19834), [#21138](https://github.com/openai/codex/issues/21138), [#25878](https://github.com/openai/codex/issues/25878), [#25285](https://github.com/openai/codex/issues/25285) |
| Cache materialization silently produces an incomplete package, especially around symlinks or locked files. | [#18863](https://github.com/openai/codex/issues/18863), [#24770](https://github.com/openai/codex/issues/24770), [#22114](https://github.com/openai/codex/issues/22114) |
| Authoring validation and runtime ingestion disagree about what constitutes a valid plugin. | [#34334](https://github.com/openai/codex/issues/34334) |
| A plugin, skill, or MCP server is enabled, but the required tool never becomes callable in the active session. | [#22078](https://github.com/openai/codex/issues/22078), [#33063](https://github.com/openai/codex/issues/33063), [#27907](https://github.com/openai/codex/issues/27907), [#30716](https://github.com/openai/codex/issues/30716), [#38549](https://github.com/openai/codex/issues/38549), [#25809](https://github.com/openai/codex/issues/25809) |
| Authentication, package visibility, and remote directory access are coupled or report conflicting states. | [#31580](https://github.com/openai/codex/issues/31580), [#22466](https://github.com/openai/codex/issues/22466) |

The current MVP intentionally covers only the earliest, deterministic layers.
It can identify broken cached payloads, manifests, skill trees, dependency files,
and local sources. It cannot replace fixes to cache invalidation, session
refresh, OAuth lifecycle, MCP readiness, or runtime tool registration. The full
failure-by-failure analysis and proposed next checks are in
[docs/github-issue-evidence.md](docs/github-issue-evidence.md).

## Run the doctor

No package installation or API key is required:

```sh
node ./bin/codex-plugin-doctor.js
node ./bin/codex-plugin-doctor.js --json
node ./bin/codex-plugin-doctor.js --plugin gmail@openai-curated
```

Exit codes follow diagnostic CLI conventions:

- `0`: no failing checks (warnings may be present)
- `1`: at least one integrity check failed
- `2`: the doctor could not run, parse arguments, or query Codex

## Benchmark installation latency

Pass the exact plugin ID and the local or Git marketplace that contains it:

```sh
node ./bin/codex-plugin-doctor.js benchmark-install \
  my-plugin@my-marketplace \
  --marketplace-source owner/repo \
  --runs 5
```

Add `--json` for a machine-readable report. Every run creates a fresh temporary
`CODEX_HOME`, adds the marketplace, installs the plugin with the real Codex CLI,
runs `codex plugin list --json`, verifies the installed files with the doctor,
and removes the temporary home. The user's installed plugins and configuration
are never changed. `--keep-temp` retains the isolated homes for investigation.

The report separates:

- `marketplaceSetupMs`: marketplace registration or fetch time;
- `installCommandMs`: wall-clock time for `codex plugin add`;
- `verificationMs`: inventory lookup and post-install doctor checks;
- `timeToReadyMs`: install plus successful verification;
- `totalMs`: marketplace setup through successful verification.

For repeated runs, the report includes minimum, median, p95, maximum, and mean
for every phase. Marketplace setup is reported separately so network clone time
does not get mistaken for plugin materialization time.

## Checks

| Check ID | What it proves |
| --- | --- |
| `plugins.inventory` | The selected plugin is known and reports coherent installed/enabled state. |
| `plugins.payloads` | The expected versioned cache directory exists and is a directory. |
| `plugins.manifests` | `.codex-plugin/plugin.json` is readable and identifies the expected plugin. |
| `plugins.skills` | Declared skill roots stay inside the payload and contain valid `SKILL.md` frontmatter. |
| `plugins.dependencies` | Referenced `.app.json` and `.mcp.json` files exist, parse, and have the expected top-level key. |
| `plugins.sources` | Local sources remain reachable for updates or reinstalls. A missing source is a warning when the cache is healthy. |

The doctor command never repairs, removes, installs, starts, or authenticates
anything. The benchmark command performs installation only inside its temporary
Codex homes. Remediation is reported as text.

## Test it

```sh
npm test
npm run test:e2e
```

The unit suite constructs isolated filesystem fixtures for healthy and broken
payloads. The end-to-end tests create temporary Codex homes and use the real
Codex CLI. One installs a fixture plugin, moves its declared `skills/` subtree
aside, and proves two things:

1. Codex still reports the fixture as installed and enabled.
2. The plugin doctor reports `plugins.skills` as failed.

The skills subtree is moved back before the temporary test directory is
removed. A second test runs the installation benchmark and verifies its timing
and post-install health report. The tests never read or modify the user's real
Codex configuration.

## Upstream path

The smallest upstream patch would move the pure checks into
`codex-rs/cli/src/doctor/plugins.rs`, call them from the existing report builder,
and add the end-to-end fixture to the CLI integration tests. Repair should be a
separate, explicitly mutating command after the read-only diagnostics land.

## References

- [OpenAI plugin packaging documentation](https://developers.openai.com/plugins/build/plugins)
- [OpenAI plugin testing documentation](https://developers.openai.com/plugins/deploy/connect-chatgpt)
- [Public Codex plugin issue compilation](docs/github-issue-evidence.md)
