import { existsSync, readFileSync } from "node:fs";

export function cleanEnvValue(value) {
  let normalized = String(value ?? "").trim();

  for (let index = 0; index < 2; index += 1) {
    if (
      (normalized.startsWith('"') && normalized.endsWith('"')) ||
      (normalized.startsWith("'") && normalized.endsWith("'"))
    ) {
      normalized = normalized.slice(1, -1).trim();
      continue;
    }

    break;
  }

  return normalized;
}

export function loadEnvFiles(paths = [".env.local", ".env"], options = {}) {
  const override = options.override === true;

  for (const path of paths) {
    if (!existsSync(path)) {
      continue;
    }

    for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
      const line = rawLine.trim();

      if (!line || line.startsWith("#")) {
        continue;
      }

      const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);

      if (!match) {
        continue;
      }

      const [, key, rawValue] = match;
      const value = cleanEnvValue(rawValue);

      if (override || process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  }
}
