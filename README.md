# Codex Plugin State Doctor

## Why this exists

`codex plugin list` can report a plugin as installed and enabled without proving
that its cached files, manifest, skills, or dependencies are usable. That leaves
developers debugging an ambiguous state: Codex knows about the plugin, but the
plugin may still be unavailable to the agent.

Plugin Doctor finds the first broken transition in that chain:

```text
marketplace known
  -> plugin selected
  -> cache materialized
  -> package valid
  -> skills registered
  -> MCP/app dependency ready
  -> tools exposed in the active session
```

It is a standalone CLI so it can still run when the plugin loader is the thing
that is broken. Its structured report mirrors `codex doctor --json`, making the
checks suitable for an eventual upstream implementation.

<details>
<summary>Community evidence: 20 public Codex issue reports</summary>

These reports show recurring failure classes; they do not imply that every issue
remains reproducible or shares the same root cause.

| Reported failure class | Public reports |
| --- | --- |
| Inventory says a plugin is present, but its payload, skills, or durable marketplace source is absent. | [#34321](https://github.com/openai/codex/issues/34321), [#29103](https://github.com/openai/codex/issues/29103), [#28924](https://github.com/openai/codex/issues/28924), [#26451](https://github.com/openai/codex/issues/26451) |
| Marketplace, bundled source, cache, or a long-running session keeps stale content. | [#19834](https://github.com/openai/codex/issues/19834), [#21138](https://github.com/openai/codex/issues/21138), [#25878](https://github.com/openai/codex/issues/25878), [#25285](https://github.com/openai/codex/issues/25285) |
| Cache materialization silently produces an incomplete package. | [#18863](https://github.com/openai/codex/issues/18863), [#24770](https://github.com/openai/codex/issues/24770), [#22114](https://github.com/openai/codex/issues/22114) |
| Authoring validation and runtime ingestion disagree about plugin validity. | [#34334](https://github.com/openai/codex/issues/34334) |
| A plugin, skill, or MCP server is enabled, but the tool never becomes callable. | [#22078](https://github.com/openai/codex/issues/22078), [#33063](https://github.com/openai/codex/issues/33063), [#27907](https://github.com/openai/codex/issues/27907), [#30716](https://github.com/openai/codex/issues/30716), [#38549](https://github.com/openai/codex/issues/38549), [#25809](https://github.com/openai/codex/issues/25809) |
| Authentication, package visibility, and remote directory access report conflicting states. | [#31580](https://github.com/openai/codex/issues/31580), [#22466](https://github.com/openai/codex/issues/22466) |

See the [full issue analysis](docs/github-issue-evidence.md) for symptoms,
coverage, and proposed next checks.

</details>

## What it does

- `doctor` reconciles Codex's plugin inventory with cached payloads, manifests,
  skills, dependency files, and local sources.
- `benchmark-install` performs repeatable cold installs in isolated Codex homes
  and measures marketplace setup, installation, verification, and time-to-ready.

| Check ID | What it proves |
| --- | --- |
| `plugins.inventory` | The plugin is known and its installed/enabled state is coherent. |
| `plugins.payloads` | The expected versioned cache directory exists. |
| `plugins.manifests` | `.codex-plugin/plugin.json` is readable and identifies the expected plugin. |
| `plugins.skills` | Skill roots stay inside the payload and contain valid `SKILL.md` frontmatter. |
| `plugins.dependencies` | Referenced `.app.json` and `.mcp.json` files exist and parse correctly. |
| `plugins.sources` | Local sources remain reachable for updates or reinstalls. |

The doctor is read-only. It does not repair, install, remove, authenticate,
create, package, or publish plugins. It also does not yet probe live MCP startup,
OAuth readiness, or tool exposure in the active session. The benchmark installs
only inside temporary Codex homes and never changes the user's Codex state.

## Quick start

Requires Node.js 20+ and a Codex CLI build with plugin support.

```sh
git clone https://github.com/Nandinitalwar/codex-plugin-state-doctor.git
cd codex-plugin-state-doctor
npm install
```

Run the doctor from the cloned repository. It is a standalone diagnostic CLI,
not a plugin command inside Codex:

```sh
npm run doctor
npm run doctor -- --plugin gmail@openai-curated
npm run doctor -- --json
```

Benchmark a cold installation:

```sh
npm run doctor -- benchmark-install \
  my-plugin@my-marketplace \
  --marketplace-source owner/repo \
  --runs 5
```

The benchmark reports minimum, median, p95, maximum, and mean timings. Add
`--json` for machine-readable output or `--keep-temp` to retain the isolated
homes. Exit codes are `0` for no failures, `1` for failed integrity checks, and
`2` when the command cannot run.

## Development

```sh
npm run test:all
```

The suite contains 18 unit tests and two real-Codex end-to-end tests. Every test
uses temporary fixtures and Codex homes; none reads or modifies the user's real
configuration.

## References

- [OpenAI plugin packaging documentation](https://developers.openai.com/plugins/build/plugins)
- [OpenAI plugin testing documentation](https://developers.openai.com/plugins/deploy/connect-chatgpt)
- [Public Codex plugin issue compilation](docs/github-issue-evidence.md)
