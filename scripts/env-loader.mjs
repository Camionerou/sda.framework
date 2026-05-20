import { existsSync, readFileSync } from "node:fs";

export function loadEnvFiles(paths = [".env.local", ".env"]) {
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
      let value = rawValue.trim();

      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      process.env[key] ??= value;
    }
  }
}
