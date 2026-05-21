import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";

const MAX_FILE_BYTES = 1_500_000;
const SKIP_PATHS = new Set(["package-lock.json"]);
const SKIP_PREFIXES = [".next/", "node_modules/", "workers/tree-indexer-python/.venv/"];

const PATTERNS = [
  {
    name: "redis-url-with-password",
    regex: /rediss?:\/\/[^:\s"'`]+:[^@\s"'`]+@/gi
  },
  {
    name: "upstash-rest-token-assignment",
    regex: /UPSTASH_REDIS_REST_TOKEN\s*=\s*["']?[A-Za-z0-9_-]{30,}/gi
  },
  {
    name: "upstash-token-like",
    regex: /\bgQ[A-Za-z0-9_-]{30,}\b/g
  },
  {
    name: "supabase-service-key-assignment",
    regex: /SUPABASE_(?:SERVICE_ROLE|SECRET)_KEY\s*=\s*["']?[A-Za-z0-9_-]{30,}/gi
  },
  {
    name: "openai-key",
    regex: /\bsk-[A-Za-z0-9_-]{30,}\b/g
  },
  {
    name: "openrouter-key",
    regex: /\bsk-or-v1-[A-Za-z0-9_-]{20,}\b/g
  },
  {
    name: "private-key",
    regex: /-----BEGIN (?:RSA |EC |OPENSSH |)?PRIVATE KEY-----/g
  }
];

function gitFiles() {
  const output = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    {
      encoding: "buffer",
      stdio: ["ignore", "pipe", "pipe"]
    }
  );

  return output
    .toString("utf8")
    .split("\0")
    .map((path) => path.trim())
    .filter(Boolean);
}

function shouldSkip(path) {
  return SKIP_PATHS.has(path) || SKIP_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function lineNumberFor(source, index) {
  let line = 1;

  for (let cursor = 0; cursor < index; cursor += 1) {
    if (source.charCodeAt(cursor) === 10) {
      line += 1;
    }
  }

  return line;
}

const findings = [];

for (const path of gitFiles()) {
  if (shouldSkip(path) || !existsSync(path)) {
    continue;
  }

  const stat = statSync(path);

  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
    continue;
  }

  const buffer = readFileSync(path);

  if (buffer.includes(0)) {
    continue;
  }

  const source = buffer.toString("utf8");

  for (const pattern of PATTERNS) {
    pattern.regex.lastIndex = 0;

    for (const match of source.matchAll(pattern.regex)) {
      findings.push({
        line: lineNumberFor(source, match.index ?? 0),
        pattern: pattern.name,
        path
      });
    }
  }
}

if (findings.length > 0) {
  console.error("Potential secrets found in git-trackable files:");

  for (const finding of findings) {
    console.error(`${finding.path}:${finding.line} ${finding.pattern}`);
  }

  process.exit(1);
}

console.log("No secret-like values found in git-trackable files.");
