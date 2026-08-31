import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const MAX_TREE_FILES = 20_000;
const MAX_TREE_BYTES = 512 * 1024 * 1024;
const MAX_SESSION_FILES = 100;
const MAX_SESSION_BYTES = 128 * 1024 * 1024;
const SAFE_CACHE_SEGMENT = /^[A-Za-z0-9._+@-]+$/;

function pluginId(plugin) {
  return plugin.pluginId || `${plugin.name}@${plugin.marketplaceName}`;
}

function pathIsInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function safeRealpath(value) {
  try {
    return realpathSync(value);
  } catch {
    return null;
  }
}

function snapshotTree(root) {
  const entries = new Map();
  let fileCount = 0;
  let byteCount = 0;

  function visit(directory, relativeDirectory = "") {
    const children = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.name !== ".git" && entry.name !== ".DS_Store")
      .sort((left, right) => left.name.localeCompare(right.name));

    for (const child of children) {
      const absolute = path.join(directory, child.name);
      const relative = path.posix.join(
        ...relativeDirectory.split(path.sep).filter(Boolean),
        child.name,
      );
      const metadata = lstatSync(absolute);

      if (metadata.isDirectory()) {
        visit(absolute, path.join(relativeDirectory, child.name));
        continue;
      }

      fileCount += 1;
      if (fileCount > MAX_TREE_FILES) {
        throw new Error(`tree contains more than ${MAX_TREE_FILES} files`);
      }

      if (metadata.isSymbolicLink()) {
        entries.set(relative, `symlink\0${readlinkSync(absolute)}`);
        continue;
      }

      if (metadata.isFile()) {
        byteCount += metadata.size;
        if (byteCount > MAX_TREE_BYTES) {
          throw new Error(`tree contains more than ${MAX_TREE_BYTES} bytes`);
        }
        const digest = createHash("sha256").update(readFileSync(absolute)).digest("hex");
        entries.set(relative, `file\0${metadata.mode & 0o111}\0${digest}`);
        continue;
      }

      entries.set(relative, `other\0${metadata.mode}`);
    }
  }

  visit(root);
  const digest = createHash("sha256");
  for (const [relative, value] of [...entries.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    digest.update(relative).update("\0").update(value).update("\0");
  }
  return { entries, digest: digest.digest("hex"), fileCount, byteCount };
}

function compareSnapshots(source, cached) {
  const missing = [];
  const extra = [];
  const changed = [];

  for (const [relative, value] of source.entries) {
    if (!cached.entries.has(relative)) {
      missing.push(relative);
    } else if (cached.entries.get(relative) !== value) {
      changed.push(relative);
    }
  }
  for (const relative of cached.entries.keys()) {
    if (!source.entries.has(relative)) extra.push(relative);
  }
  return { missing: missing.sort(), extra: extra.sort(), changed: changed.sort() };
}

function sample(values, limit = 3) {
  if (values.length === 0) return null;
  const shown = values.slice(0, limit).join(", ");
  return values.length > limit ? `${shown}, +${values.length - limit} more` : shown;
}

function describeDiff(diff) {
  return [
    diff.missing.length > 0 ? `missing ${diff.missing.length}: ${sample(diff.missing)}` : null,
    diff.extra.length > 0 ? `extra ${diff.extra.length}: ${sample(diff.extra)}` : null,
    diff.changed.length > 0 ? `changed ${diff.changed.length}: ${sample(diff.changed)}` : null,
  ]
    .filter(Boolean)
    .join("; ");
}

export function inspectProvenance(pluginStates) {
  const drift = [];
  const unverified = [];
  let checked = 0;

  for (const { plugin, payloadPath } of pluginStates) {
    const id = pluginId(plugin);
    const sourcePath = plugin?.source?.path;
    if (
      typeof sourcePath !== "string" ||
      !existsSync(sourcePath) ||
      !existsSync(payloadPath)
    ) {
      continue;
    }

    try {
      if (!statSync(sourcePath).isDirectory() || !statSync(payloadPath).isDirectory()) continue;
      if (safeRealpath(sourcePath) === safeRealpath(payloadPath)) continue;

      const source = snapshotTree(sourcePath);
      const cached = snapshotTree(payloadPath);
      checked += 1;
      if (source.digest !== cached.digest) {
        drift.push(`${id} (${describeDiff(compareSnapshots(source, cached))})`);
      }
    } catch (error) {
      unverified.push(`${id} (${error.message})`);
    }
  }

  return { checked, drift, unverified };
}

function gitOutput(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    timeout: 2_000,
    maxBuffer: 1024 * 1024,
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

export function inspectMarketplaces({ pluginStates, marketplaceInventory = null }) {
  const marketplacesByName = new Map(
    (Array.isArray(marketplaceInventory?.marketplaces)
      ? marketplaceInventory.marketplaces
      : []
    ).map((marketplace) => [marketplace.name, marketplace]),
  );
  const missing = [];
  const mismatched = [];
  const stale = [];
  const revisions = [];
  const visitedRoots = new Set();
  let checked = 0;

  for (const { plugin } of pluginStates) {
    const id = pluginId(plugin);
    const configuredMarketplace = marketplacesByName.get(plugin.marketplaceName);
    const root =
      configuredMarketplace?.root || plugin?.marketplaceSource?.source || null;
    if (typeof root !== "string") continue;
    checked += 1;

    if (!existsSync(root)) {
      missing.push(`${plugin.marketplaceName} (${root})`);
      continue;
    }

    const sourcePath = plugin?.source?.path;
    if (
      typeof sourcePath === "string" &&
      existsSync(sourcePath) &&
      !pathIsInside(safeRealpath(root) || root, safeRealpath(sourcePath) || sourcePath)
    ) {
      mismatched.push(`${id} (source is outside marketplace root ${root})`);
    }

    const canonicalRoot = safeRealpath(root) || path.resolve(root);
    const sourceType =
      configuredMarketplace?.marketplaceSource?.sourceType ||
      plugin?.marketplaceSource?.sourceType ||
      null;
    if (
      sourceType !== "git" ||
      visitedRoots.has(canonicalRoot) ||
      !existsSync(path.join(root, ".git"))
    ) {
      continue;
    }
    visitedRoots.add(canonicalRoot);

    const head = gitOutput(root, ["rev-parse", "HEAD"]);
    if (!head) continue;
    revisions.push(`${plugin.marketplaceName}@${head.slice(0, 12)}`);
    const upstream = gitOutput(root, ["rev-parse", "@{upstream}"]);
    if (upstream && upstream !== head) {
      stale.push(
        `${plugin.marketplaceName} (HEAD ${head.slice(0, 12)}, locally known upstream ${upstream.slice(0, 12)})`,
      );
    }
  }

  return {
    checked,
    missing: [...new Set(missing)],
    mismatched,
    stale,
    revisions,
  };
}

export function inspectCachePointers(pluginStates) {
  const stale = [];
  let checked = 0;

  for (const { plugin, payloadPath } of pluginStates) {
    const pointerPath = path.join(path.dirname(payloadPath), "latest");
    let pointerMetadata;
    try {
      pointerMetadata = lstatSync(pointerPath);
    } catch {
      continue;
    }
    if (!pointerMetadata.isSymbolicLink() && !pointerMetadata.isDirectory()) continue;
    checked += 1;

    const target = safeRealpath(pointerPath);
    const expected = safeRealpath(payloadPath) || path.resolve(payloadPath);
    if (target === null) {
      stale.push(`${pluginId(plugin)} (latest pointer is dangling)`);
    } else if (target !== expected) {
      stale.push(
        `${pluginId(plugin)} (latest points to ${path.basename(target)}, expected ${plugin.version})`,
      );
    }
  }

  return { checked, stale };
}

function recentSessionFiles(root, cutoffMs) {
  if (!existsSync(root)) return [];
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(absolute);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const metadata = statSync(absolute);
        if (metadata.mtimeMs >= cutoffMs) files.push({ path: absolute, metadata });
      }
    }
  }
  return files
    .sort((left, right) => right.metadata.mtimeMs - left.metadata.mtimeMs)
    .slice(0, MAX_SESSION_FILES);
}

function latestHostSkillsBody(sessionPath) {
  const text = readFileSync(sessionPath, "utf8");
  let body = null;
  let offset = 0;
  while (offset < text.length) {
    const newline = text.indexOf("\n", offset);
    const end = newline === -1 ? text.length : newline;
    const line = text.slice(offset, end);
    offset = newline === -1 ? text.length : newline + 1;
    if (!line.includes('"type":"world_state"') || !line.includes('"host_skills"')) {
      continue;
    }
    try {
      const record = JSON.parse(line);
      const candidate = record?.payload?.state?.host_skills?.body;
      if (typeof candidate === "string") body = candidate;
    } catch {
      // A partially-written final JSONL record is expected while a session is active.
    }
  }
  return body;
}

function normalizeSeparators(value) {
  return value.replaceAll("\\", "/");
}

function cacheReferences(body, codexHome) {
  const normalizedBody = normalizeSeparators(body);
  const prefix = `${normalizeSeparators(path.resolve(codexHome))}/plugins/cache/`;
  const references = [];
  let offset = 0;

  while (offset < normalizedBody.length) {
    const start = normalizedBody.indexOf(prefix, offset);
    if (start === -1) break;
    const tail = normalizedBody.slice(start + prefix.length);
    const match = tail.match(/^([^/\s]+)\/([^/\s]+)\/([^/\s]+)/);
    offset = start + prefix.length;
    if (!match || !match.slice(1).every((segment) => SAFE_CACHE_SEGMENT.test(segment))) {
      continue;
    }
    references.push({ marketplaceName: match[1], name: match[2], version: match[3] });
  }
  return references;
}

export function inspectSessionReferences({
  pluginStates,
  codexHome,
  sessionMaxAgeHours = 24,
  nowMs = Date.now(),
}) {
  const currentVersions = new Map(
    pluginStates.map(({ plugin }) => [
      `${plugin.marketplaceName}/${plugin.name}`,
      plugin.version,
    ]),
  );
  const sessionsRoot = path.join(codexHome, "sessions");
  const cutoffMs = nowMs - sessionMaxAgeHours * 60 * 60 * 1000;
  const files = recentSessionFiles(sessionsRoot, cutoffMs);
  const stale = [];
  const unverified = [];
  let scannedBytes = 0;
  let scannedSessions = 0;

  for (const session of files) {
    if (scannedBytes + session.metadata.size > MAX_SESSION_BYTES) {
      unverified.push(
        `${path.basename(session.path)} (scan budget of ${MAX_SESSION_BYTES} bytes exceeded)`,
      );
      continue;
    }
    scannedBytes += session.metadata.size;
    scannedSessions += 1;

    let body;
    try {
      body = latestHostSkillsBody(session.path);
    } catch (error) {
      unverified.push(`${path.basename(session.path)} (${error.message})`);
      continue;
    }
    if (body === null) continue;

    const seen = new Set();
    for (const reference of cacheReferences(body, codexHome)) {
      const key = `${reference.marketplaceName}/${reference.name}`;
      const identity = `${key}/${reference.version}`;
      if (seen.has(identity)) continue;
      seen.add(identity);

      const currentVersion = currentVersions.get(key);
      const referencedRoot = path.join(
        codexHome,
        "plugins",
        "cache",
        reference.marketplaceName,
        reference.name,
        reference.version,
      );
      const missing = !existsSync(referencedRoot);
      const superseded = currentVersion !== undefined && currentVersion !== reference.version;
      if (!missing && !superseded) continue;

      const reasons = [
        missing ? "referenced payload is missing" : null,
        superseded ? `installed version is ${currentVersion}` : null,
      ]
        .filter(Boolean)
        .join("; ");
      stale.push(
        `${path.basename(session.path)}: ${reference.name}@${reference.marketplaceName}/${reference.version} (${reasons})`,
      );
    }
  }

  return { scannedSessions, scannedBytes, stale, unverified };
}
