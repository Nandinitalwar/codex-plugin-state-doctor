# Codex Plugin State Doctor

A read-only prototype for the missing plugin integrity checks in `codex doctor`.
It catches the state mismatch where `codex plugin list` reports a plugin as
installed and enabled but the materialized payload is absent or unusable.

This is deliberately a standalone CLI rather than a plugin: a diagnostic tool
must still work when the plugin loader itself is broken. Its report mirrors the
stable, keyed check shape emitted by `codex doctor --json`, making the checks
straightforward to port into the official Rust command.

## Run it

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

## Checks

| Check ID | What it proves |
| --- | --- |
| `plugins.inventory` | The selected plugin is known and reports coherent installed/enabled state. |
| `plugins.payloads` | The expected versioned cache directory exists and is a directory. |
| `plugins.manifests` | `.codex-plugin/plugin.json` is readable and identifies the expected plugin. |
| `plugins.skills` | Declared skill roots stay inside the payload and contain valid `SKILL.md` frontmatter. |
| `plugins.dependencies` | Referenced `.app.json` and `.mcp.json` files exist, parse, and have the expected top-level key. |
| `plugins.sources` | Local sources remain reachable for updates or reinstalls. A missing source is a warning when the cache is healthy. |

The doctor never repairs, removes, installs, starts, or authenticates anything.
Remediation is reported as text.

The public issue evidence and the mapping from failure modes to proposed checks
are compiled in [docs/github-issue-evidence.md](docs/github-issue-evidence.md).

## Test it

```sh
npm test
npm run test:e2e
```

The unit suite constructs isolated filesystem fixtures for healthy and broken
payloads. The end-to-end regression test creates a temporary `CODEX_HOME`, adds
a local marketplace through the real Codex CLI, installs a fixture plugin,
moves its declared `skills/` subtree aside, and proves two things:

1. Codex still reports the fixture as installed and enabled.
2. The plugin doctor reports `plugins.skills` as failed.

The skills subtree is moved back before the temporary test directory is
removed. The test never reads or modifies the user's real Codex configuration.

## Upstream path

The smallest upstream patch would move the pure checks into
`codex-rs/cli/src/doctor/plugins.rs`, call them from the existing report builder,
and add the end-to-end fixture to the CLI integration tests. Repair should be a
separate, explicitly mutating command after the read-only diagnostics land.

## References

- [OpenAI plugin packaging documentation](https://developers.openai.com/plugins/build/plugins)
- [OpenAI plugin testing documentation](https://developers.openai.com/plugins/deploy/connect-chatgpt)
- [Public Codex plugin issue compilation](docs/github-issue-evidence.md)
