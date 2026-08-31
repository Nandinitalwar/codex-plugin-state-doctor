# Test strategy

The feature crosses several boundaries, so one test type is not enough.

## 1. Pure state checks

Table-driven unit fixtures cover every transition in the installed plugin
lifecycle:

```text
listed -> cached -> manifest readable -> capability paths present -> loadable
```

Each fixture changes one condition and asserts the exact stable check ID,
status, and remediation. These tests are fast, deterministic, and offline.

## 2. Filesystem safety

Fixtures verify that absolute paths, `..` traversal, and escaping symlinks are
rejected. The doctor reads files only under the versioned plugin payload.

## 3. Codex CLI integration

The end-to-end test uses a temporary `CODEX_HOME` and the real commands:

```sh
codex plugin marketplace add <fixture>
codex plugin add healthy@doctor-fixture
codex plugin list --json
```

It then moves the installed payload's declared `skills/` subtree aside and
confirms the known divergence: the inventory still says enabled, while
`plugins.skills` fails. This is the
regression test for openai/codex#34321.

## 4. Output contract

JSON contract tests pin `schemaVersion`, keyed check IDs, statuses, details,
remediation, and exit codes. Human-rendering snapshot tests can be added when
the upstream output style is finalized.

## 5. MCP runtime checks (next milestone)

Filesystem integrity does not prove that an MCP server starts. A second
milestone should use fake stdio servers to test:

- process does not start;
- initialize times out;
- `tools/list` returns invalid schemas;
- app or resource metadata is missing;
- authentication is required but discoverable;
- clean initialization and shutdown.

Remote endpoints should be opt-in because network probes are slower and can
send data outside the machine. Default `codex doctor` behavior should remain
bounded and read-only.
