import { existsSync, readFileSync } from "node:fs";

import { loadEnvFiles } from "../../scripts/shared/env-loader.mjs";

export function loadSdaEnv(options = { override: true }) {
  loadEnvFiles([".env.local", ".env"], options);
  return process.env;
}

export function envValue(name, fallbackName) {
  const value = process.env[name]?.trim();

  if (value) {
    return value;
  }

  if (!fallbackName) {
    return "";
  }

  return process.env[fallbackName]?.trim() ?? "";
}

export function requiredEnv(name, fallbackName) {
  const value = envValue(name, fallbackName);

  if (!value) {
    const fallback = fallbackName ? ` o ${fallbackName}` : "";
    throw new Error(`Falta ${name}${fallback}.`);
  }

  return value;
}

export function readDotenv(path = ".env.local") {
  if (!existsSync(path)) {
    return {};
  }

  const output = {};

  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();

    if (!line || line.startsWith("#") || !line.includes("=")) {
      continue;
    }

    const [key, ...rest] = line.split("=");
    let value = rest.join("=").trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    output[key.trim()] = value;
  }

  return output;
}

export function mergedEnv() {
  loadSdaEnv();
  return { ...process.env };
}
