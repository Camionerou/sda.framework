export function cleanEnvValue(value: string | null | undefined) {
  let normalized = value?.trim() ?? "";

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

export function envValue(name: string) {
  return cleanEnvValue(process.env[name]);
}

export function optionalUrlEnv(name: string) {
  const value = envValue(name);

  if (!value) {
    return "";
  }

  return new URL(value).origin;
}

export function optionalOriginEnv(name: string) {
  const value = envValue(name);

  if (!value) {
    return "";
  }

  const normalized = value.startsWith("http://") || value.startsWith("https://")
    ? value
    : `https://${value}`;

  return new URL(normalized).origin;
}
