import { cpSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";

export function pluginEntry(overrides = {}) {
  return {
    pluginId: "healthy@fixture",
    name: "healthy",
    marketplaceName: "fixture",
    version: "0.1.0",
    installed: true,
    enabled: true,
    source: { source: "local", path: "/source/healthy" },
    ...overrides,
  };
}

export function writeHealthyPayload(codexHome, plugin = pluginEntry(), manifest = {}) {
  const payloadRoot = path.join(
    codexHome,
    "plugins",
    "cache",
    plugin.marketplaceName,
    plugin.name,
    plugin.version,
  );
  mkdirSync(path.join(payloadRoot, ".codex-plugin"), { recursive: true });
  mkdirSync(path.join(payloadRoot, "skills", "health-check"), { recursive: true });
  writeFileSync(
    path.join(payloadRoot, ".codex-plugin", "plugin.json"),
    JSON.stringify({
      name: plugin.name,
      version: "0.1.0",
      skills: "./skills/",
      ...manifest,
    }),
  );
  writeFileSync(
    path.join(payloadRoot, "skills", "health-check", "SKILL.md"),
    "---\nname: health-check\ndescription: Check fixture health.\n---\n\n# Health check\n",
  );
  const sourcePath = plugin?.source?.path;
  if (
    plugin?.source?.source === "local" &&
    typeof sourcePath === "string" &&
    realpathSync(sourcePath) !== realpathSync(payloadRoot)
  ) {
    cpSync(payloadRoot, sourcePath, { recursive: true, force: true });
  }
  return payloadRoot;
}
