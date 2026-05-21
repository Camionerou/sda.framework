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
    paths: [/^workers\/compute-gateway\//, /^lib\/indexing\/compute-gateway\.ts$/]
  },
  {
    component: "extraction_pipeline",
    paths: [
      /^workers\/compute-gateway\//,
      /^inngest\/functions\/process-document-index\//,
      /^supabase\/migrations\/.*document_extractions/
    ]
  },
  {
    component: "indexing_pipeline",
    paths: [
      /^app\/api\/documents\/.+\/indexing\/request\/route\.ts$/,
      /^inngest\/functions\/process-document-index\//,
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
    paths: [/^workers\/tree-indexer-python\/app\/prompts\.py$/]
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

function fileSource(path, head) {
  return head ? show(head, path) : readFileSync(path, "utf8");
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

function expectedRuntimeDefaultFailures(versions, head) {
  const failures = [];

  function expect(source, pattern, expected, label) {
    const match = source.match(pattern);

    if (!match) {
      failures.push(`${label} no se pudo leer.`);
      return;
    }

    if (match[1] !== expected) {
      failures.push(`${label}=${match[1]} pero ${VERSION_FILE}=${expected}.`);
    }
  }

  const computeGatewayConfig = fileSource("workers/compute-gateway/config.mjs", head);
  expect(
    computeGatewayConfig,
    /COMPUTE_GATEWAY_VERSION\s*=\s*process\.env\.SDA_COMPUTE_GATEWAY_VERSION\s*\?\?\s*"([^"]+)"/,
    versions.compute_gateway_extraction,
    "workers/compute-gateway/config.mjs SDA_COMPUTE_GATEWAY_VERSION"
  );
  expect(
    computeGatewayConfig,
    /EXTRACTION_PIPELINE_VERSION\s*=\s*process\.env\.SDA_EXTRACTION_PIPELINE_VERSION\s*\?\?\s*"([^"]+)"/,
    versions.extraction_pipeline,
    "workers/compute-gateway/config.mjs SDA_EXTRACTION_PIPELINE_VERSION"
  );
  expect(
    computeGatewayConfig,
    /INDEXING_PIPELINE_VERSION\s*=\s*process\.env\.SDA_INDEXING_PIPELINE_VERSION\s*\?\?\s*"([^"]+)"/,
    versions.indexing_pipeline,
    "workers/compute-gateway/config.mjs SDA_INDEXING_PIPELINE_VERSION"
  );

  const computeGatewayDeploy = fileSource("workers/compute-gateway/deploy.sh", head);
  expect(
    computeGatewayDeploy,
    /SDA_COMPUTE_GATEWAY_VERSION=\$\{SDA_COMPUTE_GATEWAY_VERSION:-([^}]+)\}/,
    versions.compute_gateway_extraction,
    "workers/compute-gateway/deploy.sh SDA_COMPUTE_GATEWAY_VERSION"
  );
  expect(
    computeGatewayDeploy,
    /SDA_EXTRACTION_PIPELINE_VERSION=\$\{SDA_EXTRACTION_PIPELINE_VERSION:-([^}]+)\}/,
    versions.extraction_pipeline,
    "workers/compute-gateway/deploy.sh SDA_EXTRACTION_PIPELINE_VERSION"
  );
  expect(
    computeGatewayDeploy,
    /SDA_INDEXING_PIPELINE_VERSION=\$\{SDA_INDEXING_PIPELINE_VERSION:-([^}]+)\}/,
    versions.indexing_pipeline,
    "workers/compute-gateway/deploy.sh SDA_INDEXING_PIPELINE_VERSION"
  );

  const treeVersions = fileSource("workers/tree-indexer-python/app/versions.py", head);
  for (const component of [
    "app",
    "chat_agent",
    "compute_gateway_extraction",
    "embedding_pipeline",
    "extraction_pipeline",
    "indexing_pipeline",
    "inngest_indexing_workflow"
  ]) {
    expect(
      treeVersions,
      new RegExp(`"${component}":\\s*"([^"]+)"`),
      versions[component],
      `workers/tree-indexer-python/app/versions.py ${component}`
    );
  }
  expect(
    treeVersions,
    /"tree_indexer_python":\s*_version\("SDA_TREE_INDEXER_VERSION",\s*"([^"]+)"\)/,
    versions.tree_indexer_python,
    "workers/tree-indexer-python/app/versions.py tree_indexer_python"
  );
  expect(
    treeVersions,
    /"tree_prompt":\s*_version\("SDA_TREE_PROMPT_VERSION",\s*"([^"]+)"\)/,
    versions.tree_prompt,
    "workers/tree-indexer-python/app/versions.py tree_prompt"
  );

  const treeDeploy = fileSource("workers/tree-indexer-python/deploy.sh", head);
  expect(
    treeDeploy,
    /SDA_TREE_INDEXER_VERSION=\$\{SDA_TREE_INDEXER_VERSION:-([^}]+)\}/,
    versions.tree_indexer_python,
    "workers/tree-indexer-python/deploy.sh SDA_TREE_INDEXER_VERSION"
  );
  expect(
    treeDeploy,
    /SDA_TREE_PROMPT_VERSION=\$\{SDA_TREE_PROMPT_VERSION:-([^}]+)\}/,
    versions.tree_prompt,
    "workers/tree-indexer-python/deploy.sh SDA_TREE_PROMPT_VERSION"
  );

  return failures;
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
const currentVersions = parseVersions(fileSource(VERSION_FILE, head));

if (Object.keys(currentVersions).length === 0) {
  console.log("Version registry not present; skipping version check.");
  process.exit(0);
}

const runtimeDefaultFailures = expectedRuntimeDefaultFailures(currentVersions, head);

if (runtimeDefaultFailures.length > 0) {
  console.error("Runtime version defaults drifted from lib/system-versions.ts:");
  for (const failure of runtimeDefaultFailures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

if (files.length === 0) {
  console.log("No changed files to check. Runtime version defaults aligned.");
  process.exit(0);
}

const previousVersions = parseVersions(show(base, VERSION_FILE));

if (Object.keys(previousVersions).length === 0) {
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
