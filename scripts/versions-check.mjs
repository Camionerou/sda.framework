import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const VERSION_FILE = "lib/system-versions.ts";

const COMPONENT_RULES = [
  {
    component: "app",
    paths: [/^app\//, /^components\//, /^lib\/(?!system-versions\.ts)/, /^package\.json$/]
  },
  {
    component: "compute_gateway_extraction",
    paths: [/^workers\/compute-gateway\//, /^lib\/compute-gateway\.ts$/]
  },
  {
    component: "extraction_pipeline",
    paths: [
      /^workers\/compute-gateway\//,
      /^inngest\/functions\/process-document-index\.ts$/,
      /^supabase\/migrations\/.*document_extractions/
    ]
  },
  {
    component: "indexing_pipeline",
    paths: [
      /^app\/api\/documents\/.+\/indexing\/request\/route\.ts$/,
      /^inngest\/functions\/process-document-index\.ts$/,
      /^inngest\/functions\/reconcile-document-indexing\.ts$/,
      /^workers\/compute-gateway\//,
      /^workers\/tree-indexer-python\//,
      /^supabase\/migrations\/.*indexing/
    ]
  },
  {
    component: "inngest_indexing_workflow",
    paths: [/^inngest\//, /^app\/api\/inngest\/route\.ts$/]
  },
  {
    component: "tree_indexer_python",
    paths: [/^workers\/tree-indexer-python\//]
  },
  {
    component: "tree_prompt",
    paths: [/^workers\/tree-indexer-python\/app\/tree_graph\.py$/]
  }
];

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);

  return index >= 0 ? process.argv[index + 1] : fallback;
}

function git(args, options = {}) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", options.allowFailure ? "ignore" : "pipe"]
  }).trim();
}

function show(ref, path) {
  try {
    return git(["show", `${ref}:${path}`], { allowFailure: true });
  } catch {
    return "";
  }
}

function parseVersions(source) {
  const versions = {};
  const match = source.match(/SYSTEM_COMPONENT_VERSIONS\s*=\s*{([\s\S]*?)}\s*as const/);

  if (!match) {
    return versions;
  }

  for (const item of match[1].matchAll(/([a-z][a-z0-9_]*):\s*"([^"]+)"/g)) {
    versions[item[1]] = item[2];
  }

  return versions;
}

function changedFiles(base, head) {
  const args = ["diff", "--name-only", base];

  if (head) {
    args.push(head);
  }

  return git(args)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

const base = argValue("--base", process.env.VERSION_CHECK_BASE ?? "HEAD");
const head = argValue("--head", process.env.VERSION_CHECK_HEAD ?? null);
const diffArgs = head ? [base, head] : [base];
const files = changedFiles(...diffArgs);

if (files.length === 0) {
  console.log("No changed files to check.");
  process.exit(0);
}

const previousVersions = parseVersions(show(base, VERSION_FILE));
const currentVersions = parseVersions(
  head ? show(head, VERSION_FILE) : readFileSync(VERSION_FILE, "utf8")
);

if (Object.keys(previousVersions).length === 0 || Object.keys(currentVersions).length === 0) {
  console.log("Version registry not present on both sides; skipping bump check.");
  process.exit(0);
}

const touchedComponents = new Set();

for (const file of files) {
  if (file === VERSION_FILE || file === "package-lock.json") {
    continue;
  }

  for (const rule of COMPONENT_RULES) {
    if (rule.paths.some((pattern) => pattern.test(file))) {
      touchedComponents.add(rule.component);
    }
  }
}

const missingBumps = [...touchedComponents].filter(
  (component) => previousVersions[component] === currentVersions[component]
);

if (missingBumps.length > 0) {
  console.error("Missing component version bump:");
  for (const component of missingBumps) {
    console.error(`- ${component} stayed at ${currentVersions[component]}`);
  }
  console.error(`Update ${VERSION_FILE} before committing these component changes.`);
  process.exit(1);
}

console.log(
  touchedComponents.size === 0
    ? "No versioned components touched."
    : `Version bumps present for: ${[...touchedComponents].join(", ")}`
);
