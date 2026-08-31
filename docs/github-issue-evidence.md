# Evidence: recurring Codex plugin failure modes

This compilation uses public issues in `openai/codex` as of August 31, 2026.
The reports are evidence of recurring failure *classes*, not proof that every
report has the same root cause or remains reproducible on every current build.

## Executive summary

Plugin failures repeatedly occur between states that Codex currently reports
independently:

```text
marketplace known
  -> plugin selected
  -> cache materialized
  -> package valid
  -> skills registered
  -> MCP/app dependency ready
  -> tools exposed in the active session
```

The common user-facing symptom is “installed and enabled, but unavailable.” A
plugin doctor is useful because it can identify the first broken transition and
recommend a specific next action. It cannot replace fixes to cache invalidation,
session refresh, OAuth lifecycle, or MCP registration.

## 1. Inventory and materialized state disagree

| Issue | Reported failure | Diagnostic opportunity |
| --- | --- | --- |
| [#34321: `plugin list` says installed/enabled while cache payload or skills are missing](https://github.com/openai/codex/issues/34321) | Config and inventory remain positive while the plugin contributes no skills. The issue explicitly requests `codex plugin doctor` or `plugin list --verify`. | Compare inventory with the exact versioned cache directory, manifest, declared skills, and dependencies. This is the MVP’s primary regression. |
| [#29103: plugins disappear after restart because a built-in marketplace source is not persisted](https://github.com/openai/codex/issues/29103) | UI installation creates cache state without durable marketplace provenance; reconcile later treats the cache as orphaned. | Report installed cache entries with no resolvable configured marketplace and predict that reinstall/update cannot succeed. |
| [#28924: `INSTALLED_BY_DEFAULT` is surfaced but not enacted](https://github.com/openai/codex/issues/28924) | Marketplace policy is parsed and shown, yet the expected plugin is absent. | Compare marketplace policy with effective installation state and label the mismatch separately from corruption. |
| [#26451: bundled Computer Use exists in the marketplace but reconcile skips or removes it](https://github.com/openai/codex/issues/26451) | Different reconciliation stages disagree on whether the bundled plugin exists. | Show marketplace presence, selected version, cache presence, and effective enablement in one row. |

## 2. Marketplace and cache freshness are opaque

| Issue | Reported failure | Diagnostic opportunity |
| --- | --- | --- |
| [#19834: stale marketplace repository clone is detected internally but not surfaced](https://github.com/openai/codex/issues/19834) | Users cannot distinguish a stale marketplace checkout from a stale installed plugin. | Report marketplace source revision, expected revision, last refresh, and affected plugins. |
| [#21138: same manifest version can preserve stale plugin contents](https://github.com/openai/codex/issues/21138) | Cache refresh compares only the version string, so changed source contents can remain stale. | Record and compare a deterministic source/payload content digest in addition to version. |
| [#25878: bundled plugin marketplace and cache stay stale after a Microsoft Store update](https://github.com/openai/codex/issues/25878) | App version, bundled source, cache version, native-host paths, and `latest` pointers diverge. | Cross-check app version, bundled marketplace provenance, active cache version, pointers, and referenced binaries. |
| [#25285: long-lived sessions retain paths under obsolete cache hashes](https://github.com/openai/codex/issues/25285) | A cache update succeeds, but older sessions reference deleted `SKILL.md` paths. | Scan durable session references for volatile cache-version paths and compare them with the active version. |

## 3. Cache materialization can be incomplete

| Issue | Reported failure | Diagnostic opportunity |
| --- | --- | --- |
| [#18863: local plugin installation silently drops symlinks](https://github.com/openai/codex/issues/18863) | The cache looks partially populated but omits symlinked runtime files. | Compare a bounded source/payload file manifest and identify missing or changed entries. |
| [#24770: cross-agent plugin layouts using shared symlinks become empty or partial](https://github.com/openai/codex/issues/24770) | Common shared-skill/script layouts do not survive materialization. | Explain whether a missing cached file was absent at source, rejected by policy, or lost during copy. |
| [#22114: Chrome cache loses manifest and runtime files while status still says installed/enabled](https://github.com/openai/codex/issues/22114) | A locked helper and failed lifecycle operation leave a partial cache tree. | Validate required files and report likely locks/process ownership separately from “plugin missing.” |

## 4. Authoring validators and runtime ingestion disagree

| Issue | Reported failure | Diagnostic opportunity |
| --- | --- | --- |
| [#34334: plugin-creator validator rejects manifests allowed by docs/ingestion](https://github.com/openai/codex/issues/34334) | The authoring validator requires optional fields, rejects supported hooks, and ignores declared skill paths. | Use one versioned schema/validation library for creator, doctor, installer, and submission preflight; print which contract version was applied. |

This is especially important for a doctor: a validator that disagrees with the
loader creates false failures and destroys trust. The MVP therefore limits
itself to invariants observed in installed packages and avoids enforcing
optional presentation metadata.

## 5. “Installed” does not mean capabilities are exposed

| Issue | Reported failure | Diagnostic opportunity |
| --- | --- | --- |
| [#22078: local plugin is enabled but its skills are absent from sessions](https://github.com/openai/codex/issues/22078) | Manifest and skill directory appear valid, yet session discovery omits them. | Compare declared skills, loader registry output, and the capabilities injected into a fresh diagnostic session. |
| [#33063: MCP server keys with hyphens are listed but not callable](https://github.com/openai/codex/issues/33063) | MCP configuration accepts a name that cannot become a callable tool namespace. | Validate namespace compatibility at install time and compare configured servers with exposed tool prefixes. |
| [#27907: Computer Use skill is present but its required `node_repl` tool is absent](https://github.com/openai/codex/issues/27907) | The workflow instructions and bootstrap file load without the tool required to execute them. | Build a capability dependency graph: skill -> required MCP server -> required tool -> active-session exposure. |
| [#30716: OAuth succeeds and a fresh CLI process gets tools, but the running app does not refresh](https://github.com/openai/codex/issues/30716) | Stored authentication and server behavior are healthy; the running app has stale tool state. | Compare a fresh-process probe with app-server/session state and recommend a scoped refresh when they differ. |
| [#38549: bundled MCP client never reaches ready, so tools are omitted](https://github.com/openai/codex/issues/38549) | Browser UI works, but the plugin’s MCP client fails readiness and is excluded from the tool catalog. | Add bounded MCP initialize/readiness/`tools/list` probes with elapsed time and the exact failed phase. |
| [#25809: plugin and MCP both report enabled while native wiring and callable tools are missing](https://github.com/openai/codex/issues/25809) | Multiple status commands look healthy but the complete capability path is broken. | Check native dependencies and active tool exposure instead of treating enablement as the terminal state. |

## 6. Authentication and discovery state are coupled unclearly

| Issue | Reported failure | Diagnostic opportunity |
| --- | --- | --- |
| [#31580: canceling or disconnecting OAuth removes a plugin and its local skills](https://github.com/openai/codex/issues/31580) | Authentication readiness is treated like package installation/visibility even when skills do not require the account. | Report package state and each remote dependency’s auth state independently. |
| [#22466: remote plugin discovery fails with 403 despite active ChatGPT login and working model requests](https://github.com/openai/codex/issues/22466) | Model-provider auth, ChatGPT auth, and plugin-directory access have different outcomes. | Probe each auth/network surface independently and identify which request class failed without exposing credentials. |

## What the current MVP covers

The implemented read-only checks cover the earliest and most deterministic
layers:

- `plugins.inventory`: selected plugin exists in Codex’s inventory.
- `plugins.payloads`: the versioned cache payload exists.
- `plugins.manifests`: the cached manifest is readable and identifies the plugin.
- `plugins.skills`: declared skill roots and `SKILL.md` frontmatter are loadable.
- `plugins.dependencies`: referenced app and MCP configuration files are valid.
- `plugins.sources`: local sources remain reachable for a reinstall.

## Checks justified for the next milestones

1. `plugins.marketplaces`: configured source, checkout revision, freshness, and
   persistence.
2. `plugins.provenance`: source-to-cache digest and incomplete-copy detection.
3. `plugins.registry`: declared skills and dependencies versus loader registry.
4. `plugins.mcp_runtime`: bounded initialize, readiness, and `tools/list` probes.
5. `plugins.exposure`: registry capabilities versus a fresh app-server session.
6. `plugins.auth`: package installation separated from per-dependency auth
   readiness.

The first four can be safe, read-only diagnostics. Active session exposure may
need an app-server diagnostic API. Automated repair should remain a separate,
explicitly mutating operation.
