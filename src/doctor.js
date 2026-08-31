import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";

const STATUS_RANK = Object.freeze({ ok: 0, warning: 1, fail: 2 });
const PATH_FIELDS = Object.freeze([
  ["apps", "apps"],
  ["mcpServers", "mcpServers"],
]);

function check(id, category, status, summary, details, remediation = null) {
  return {
    id,
    category,
    status,
    summary,
    details,
    remediation,
    durationMs: 0,
  };
}

function worstStatus(statuses) {
  return statuses.reduce(
    (worst, status) =>
      STATUS_RANK[status] > STATUS_RANK[worst] ? status : worst,
    "ok",
  );
}

function pluginId(plugin) {
  if (typeof plugin.pluginId === "string" && plugin.pluginId.length > 0) {
    return plugin.pluginId;
  }
  return `${plugin.name ?? "unknown"}@${plugin.marketplaceName ?? "unknown"}`;
}

function list(values) {
  return values.length === 0 ? "none" : values.sort().join(", ");
}

function displayPath(value, codexHome) {
  const parent = path.dirname(path.resolve(codexHome));
  const relative = path.relative(parent, path.resolve(value));
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return path.join("~", relative);
  }
  return path.resolve(value);
}

function safeSegment(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\")
  );
}

function expectedPayloadPath(codexHome, plugin) {
  const segments = [plugin.marketplaceName, plugin.name, plugin.version];
  if (!segments.every(safeSegment)) {
    return null;
  }
  return path.join(codexHome, "plugins", "cache", ...segments);
}

function readJson(filePath) {
  try {
    return { value: JSON.parse(readFileSync(filePath, "utf8")), error: null };
  } catch (error) {
    return { value: null, error: error.message };
  }
}

function declaredPaths(value) {
  if (value === undefined || value === null) {
    return { paths: [], error: null };
  }
  if (typeof value === "string") {
    return { paths: [value], error: null };
  }
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return { paths: value, error: null };
  }
  return { paths: [], error: "must be a path string or an array of path strings" };
}

function containedPath(pluginRoot, declaredPath) {
  if (path.isAbsolute(declaredPath)) {
    return { path: null, error: "absolute paths are not allowed" };
  }

  const root = path.resolve(pluginRoot);
  const candidate = path.resolve(root, declaredPath);
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return { path: null, error: "path escapes the plugin root" };
  }

  if (existsSync(candidate)) {
    const realRoot = realpathSync(root);
    const realCandidate = realpathSync(candidate);
    const realRelative = path.relative(realRoot, realCandidate);
    if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
      return { path: null, error: "symlink resolves outside the plugin root" };
    }
  }

  return { path: candidate, error: null };
}

function findSkillFiles(root, pluginRoot) {
  const files = [];
  const errors = [];
  const pending = [root];
  const visitedDirectories = new Set();
  const realPluginRoot = realpathSync(pluginRoot);

  while (pending.length > 0) {
    const current = pending.pop();
    let realCurrent;
    try {
      realCurrent = realpathSync(current);
      const relative = path.relative(realPluginRoot, realCurrent);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        errors.push(`${path.relative(pluginRoot, current)}: resolves outside plugin root`);
        continue;
      }
    } catch (error) {
      errors.push(`${path.relative(pluginRoot, current) || "."}: ${error.message}`);
      continue;
    }
    if (visitedDirectories.has(realCurrent)) {
      continue;
    }
    visitedDirectories.add(realCurrent);

    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch (error) {
      errors.push(`${path.relative(pluginRoot, current) || "."}: ${error.message}`);
      continue;
    }

    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        try {
          const realEntry = realpathSync(entryPath);
          const relative = path.relative(realPluginRoot, realEntry);
          if (relative.startsWith("..") || path.isAbsolute(relative)) {
            errors.push(
              `${path.relative(pluginRoot, entryPath)}: symlink resolves outside plugin root`,
            );
            continue;
          }
          const target = statSync(entryPath);
          if (target.isDirectory()) {
            pending.push(entryPath);
          } else if (target.isFile() && entry.name === "SKILL.md") {
            files.push(entryPath);
          }
        } catch (error) {
          errors.push(`${path.relative(pluginRoot, entryPath)}: ${error.message}`);
        }
      } else if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (entry.isFile() && entry.name === "SKILL.md") {
        files.push(entryPath);
      }
    }
  }

  return { files, errors };
}

function skillFrontmatterErrors(skillPath, pluginRoot) {
  let text;
  try {
    text = readFileSync(skillPath, "utf8");
  } catch (error) {
    return [`${path.relative(pluginRoot, skillPath)}: ${error.message}`];
  }

  const match = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\s*\r?\n|$)/);
  if (!match) {
    return [`${path.relative(pluginRoot, skillPath)}: missing YAML frontmatter`];
  }

  const frontmatter = match[1];
  const errors = [];
  for (const field of ["name", "description"]) {
    const fieldPattern = new RegExp(`^${field}\\s*:\\s*\\S.+$`, "m");
    if (!fieldPattern.test(frontmatter)) {
      errors.push(`${path.relative(pluginRoot, skillPath)}: missing ${field}`);
    }
  }
  return errors;
}

/**
 * Diagnose a `codex plugin list --json` inventory without mutating Codex state.
 */
export function diagnosePluginInventory({ inventory, codexHome, onlyPlugin = null }) {
  const startedAt = Date.now();
  const installed = Array.isArray(inventory?.installed) ? inventory.installed : [];
  const available = Array.isArray(inventory?.available) ? inventory.available : [];
  const plugins = onlyPlugin
    ? installed.filter((plugin) => pluginId(plugin) === onlyPlugin)
    : installed;

  const payloadMissing = [];
  const payloadInvalid = [];
  const stateInvalid = [];
  const manifestMissing = [];
  const manifestInvalid = [];
  const manifestNameMismatch = [];
  const skillsMissing = [];
  const skillsInvalid = [];
  const dependencyMissing = [];
  const dependencyInvalid = [];
  const sourceMissing = [];
  let skillFilesChecked = 0;
  let dependencyFilesChecked = 0;

  for (const plugin of plugins) {
    const id = pluginId(plugin);
    if (plugin.enabled === true && plugin.installed !== true) {
      stateInvalid.push(`${id} (enabled but not installed)`);
    }

    const payloadPath = expectedPayloadPath(codexHome, plugin);
    if (payloadPath === null) {
      payloadInvalid.push(`${id} (unsafe or incomplete cache identity)`);
      continue;
    }
    if (!existsSync(payloadPath)) {
      payloadMissing.push(`${id} (${displayPath(payloadPath, codexHome)})`);
      continue;
    }
    if (!lstatSync(payloadPath).isDirectory()) {
      payloadInvalid.push(`${id} (cache payload is not a directory)`);
      continue;
    }

    const sourcePath = plugin?.source?.path;
    if (plugin?.source?.source === "local" && typeof sourcePath === "string") {
      if (!existsSync(sourcePath)) {
        sourceMissing.push(`${id} (${displayPath(sourcePath, codexHome)})`);
      }
    }

    const manifestPath = path.join(payloadPath, ".codex-plugin", "plugin.json");
    if (!existsSync(manifestPath)) {
      manifestMissing.push(id);
      continue;
    }

    const parsedManifest = readJson(manifestPath);
    if (parsedManifest.error) {
      manifestInvalid.push(`${id} (${parsedManifest.error})`);
      continue;
    }
    const manifest = parsedManifest.value;
    if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
      manifestInvalid.push(`${id} (manifest must be a JSON object)`);
      continue;
    }
    if (manifest.name !== plugin.name) {
      manifestNameMismatch.push(
        `${id} (manifest name ${JSON.stringify(manifest.name)})`,
      );
    }
    if (typeof manifest.version !== "string" || manifest.version.length === 0) {
      manifestInvalid.push(`${id} (manifest version is missing)`);
    }

    const skillDeclaration = declaredPaths(manifest.skills);
    if (skillDeclaration.error) {
      skillsInvalid.push(`${id} (${skillDeclaration.error})`);
    }
    for (const declaredSkillPath of skillDeclaration.paths) {
      const resolved = containedPath(payloadPath, declaredSkillPath);
      if (resolved.error) {
        skillsInvalid.push(`${id}:${declaredSkillPath} (${resolved.error})`);
        continue;
      }
      if (!existsSync(resolved.path) || !statSync(resolved.path).isDirectory()) {
        skillsMissing.push(`${id}:${declaredSkillPath}`);
        continue;
      }
      const found = findSkillFiles(resolved.path, payloadPath);
      if (found.files.length === 0) {
        skillsMissing.push(`${id}:${declaredSkillPath} (no SKILL.md files)`);
      }
      skillsInvalid.push(...found.errors.map((error) => `${id}:${error}`));
      for (const skillPath of found.files) {
        skillFilesChecked += 1;
        skillsInvalid.push(...skillFrontmatterErrors(skillPath, payloadPath).map(
          (error) => `${id}:${error}`,
        ));
      }
    }

    for (const [manifestField, requiredTopLevelKey] of PATH_FIELDS) {
      const declaration = declaredPaths(manifest[manifestField]);
      if (declaration.error) {
        dependencyInvalid.push(`${id}:${manifestField} (${declaration.error})`);
      }
      for (const declaredDependencyPath of declaration.paths) {
        const resolved = containedPath(payloadPath, declaredDependencyPath);
        if (resolved.error) {
          dependencyInvalid.push(
            `${id}:${declaredDependencyPath} (${resolved.error})`,
          );
          continue;
        }
        if (!existsSync(resolved.path) || !statSync(resolved.path).isFile()) {
          dependencyMissing.push(`${id}:${declaredDependencyPath}`);
          continue;
        }
        dependencyFilesChecked += 1;
        const parsedDependency = readJson(resolved.path);
        if (parsedDependency.error) {
          dependencyInvalid.push(
            `${id}:${declaredDependencyPath} (${parsedDependency.error})`,
          );
        } else if (
          parsedDependency.value === null ||
          typeof parsedDependency.value !== "object" ||
          typeof parsedDependency.value[requiredTopLevelKey] !== "object" ||
          parsedDependency.value[requiredTopLevelKey] === null
        ) {
          dependencyInvalid.push(
            `${id}:${declaredDependencyPath} (missing top-level ${requiredTopLevelKey})`,
          );
        }
      }
    }
  }

  const enabledCount = installed.filter((plugin) => plugin.enabled === true).length;
  const inventoryStatus = onlyPlugin && plugins.length === 0 ? "fail" : "ok";
  const inventoryCheck = check(
    "plugins.inventory",
    "plugins",
    inventoryStatus,
    inventoryStatus === "ok"
      ? `${plugins.length} installed plugin${plugins.length === 1 ? "" : "s"} selected`
      : `plugin ${onlyPlugin} is not installed`,
    {
      installed: String(installed.length),
      enabled: String(enabledCount),
      available: String(available.length),
      selected: String(plugins.length),
    },
    inventoryStatus === "fail"
      ? `Install ${onlyPlugin}, then rerun the doctor.`
      : null,
  );

  const payloadFailures = [...payloadMissing, ...payloadInvalid, ...stateInvalid];
  const payloadCheck = check(
    "plugins.payloads",
    "plugins",
    payloadFailures.length > 0 ? "fail" : "ok",
    payloadFailures.length > 0
      ? `${payloadFailures.length} plugin payload issue${payloadFailures.length === 1 ? "" : "s"}`
      : "installed plugin payloads are materialized",
    {
      checked: String(plugins.length),
      missing: list(payloadMissing),
      invalid: list(payloadInvalid),
      "state mismatch": list(stateInvalid),
    },
    payloadFailures.length > 0
      ? "Reinstall each affected plugin from its configured marketplace, then rerun the doctor."
      : null,
  );

  const manifestFailures = [
    ...manifestMissing,
    ...manifestInvalid,
    ...manifestNameMismatch,
  ];
  const manifestCheck = check(
    "plugins.manifests",
    "plugins",
    manifestFailures.length > 0 ? "fail" : "ok",
    manifestFailures.length > 0
      ? `${manifestFailures.length} plugin manifest issue${manifestFailures.length === 1 ? "" : "s"}`
      : "cached plugin manifests are readable",
    {
      missing: list(manifestMissing),
      invalid: list(manifestInvalid),
      "name mismatch": list(manifestNameMismatch),
    },
    manifestFailures.length > 0
      ? "Fix the source manifest and reinstall the affected plugin."
      : null,
  );

  const skillFailures = [...skillsMissing, ...skillsInvalid];
  const skillCheck = check(
    "plugins.skills",
    "plugins",
    skillFailures.length > 0 ? "fail" : "ok",
    skillFailures.length > 0
      ? `${skillFailures.length} declared skill issue${skillFailures.length === 1 ? "" : "s"}`
      : "declared plugin skills are loadable",
    {
      "SKILL.md files checked": String(skillFilesChecked),
      missing: list(skillsMissing),
      invalid: list(skillsInvalid),
    },
    skillFailures.length > 0
      ? "Restore each declared skills path and ensure every skill has SKILL.md frontmatter with name and description."
      : null,
  );

  const dependencyFailures = [...dependencyMissing, ...dependencyInvalid];
  const dependencyCheck = check(
    "plugins.dependencies",
    "plugins",
    dependencyFailures.length > 0 ? "fail" : "ok",
    dependencyFailures.length > 0
      ? `${dependencyFailures.length} plugin dependency issue${dependencyFailures.length === 1 ? "" : "s"}`
      : "declared app and MCP files are loadable",
    {
      "dependency files checked": String(dependencyFilesChecked),
      missing: list(dependencyMissing),
      invalid: list(dependencyInvalid),
    },
    dependencyFailures.length > 0
      ? "Restore or correct each manifest-referenced .app.json or .mcp.json file, then reinstall the plugin."
      : null,
  );

  const sourceCheck = check(
    "plugins.sources",
    "plugins",
    sourceMissing.length > 0 ? "warning" : "ok",
    sourceMissing.length > 0
      ? `${sourceMissing.length} local plugin source${sourceMissing.length === 1 ? " is" : "s are"} unavailable`
      : "local plugin sources are reachable",
    { missing: list(sourceMissing) },
    sourceMissing.length > 0
      ? "Restore the local marketplace source before attempting an update or reinstall."
      : null,
  );

  const checks = Object.fromEntries(
    [
      inventoryCheck,
      payloadCheck,
      manifestCheck,
      skillCheck,
      dependencyCheck,
      sourceCheck,
    ].map((item) => [item.id, item]),
  );

  return {
    checks,
    overallStatus: worstStatus(Object.values(checks).map((item) => item.status)),
    durationMs: Date.now() - startedAt,
  };
}

export function createReport({ inventory, codexHome, codexVersion, onlyPlugin = null }) {
  const diagnostics = diagnosePluginInventory({ inventory, codexHome, onlyPlugin });
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    overallStatus: diagnostics.overallStatus,
    codexVersion,
    checks: diagnostics.checks,
  };
}

export function renderHuman(report, { summary = false } = {}) {
  const symbols = { ok: "PASS", warning: "WARN", fail: "FAIL" };
  const lines = ["Codex Plugin Doctor", `Overall: ${report.overallStatus.toUpperCase()}`, ""];

  for (const item of Object.values(report.checks)) {
    lines.push(`[${symbols[item.status]}] ${item.id}: ${item.summary}`);
    if (!summary && item.status !== "ok") {
      for (const [key, value] of Object.entries(item.details)) {
        if (value !== "none" && value !== "0") {
          lines.push(`  ${key}: ${value}`);
        }
      }
      if (item.remediation) {
        lines.push(`  next: ${item.remediation}`);
      }
    }
  }

  return `${lines.join("\n")}\n`;
}
