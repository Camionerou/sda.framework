import { confirm, isCancel } from "@clack/prompts";
import { defineCommand } from "citty";
import { readFileSync } from "node:fs";

import { loadSdaEnv, mergedEnv } from "../shared/env.mjs";
import { run, runInherited } from "../shared/process.mjs";

const TARGETS = {
  all: {
    label: "all"
  },
  gateway: {
    component: "compute_gateway_extraction",
    healthPath: "/v1/health",
    name: "gateway",
    remoteDir: "/home/sistemas/sda-compute-gateway",
    script: "workers/compute-gateway/deploy.sh",
    service: "compute-gateway",
    tokenKey: "SDA_COMPUTE_GATEWAY_TOKEN"
  },
  tree: {
    component: "tree_indexer_python",
    healthPath: "/v1/health",
    name: "tree",
    remoteDir: "/home/sistemas/sda-tree-indexer-python",
    script: "workers/tree-indexer-python/deploy.sh",
    service: "tree-indexer",
    tokenKey: "SDA_TREE_INDEXER_TOKEN"
  }
};

export const deployCommand = defineCommand({
  meta: {
    name: "deploy",
    alias: ["dp", "dep"],
    description: "Deploy seguro de workers a srv-ia-01"
  },
  args: {
    target: {
      type: "positional",
      required: true,
      description: "gateway, tree o all"
    },
    diff: {
      type: "boolean",
      alias: "d",
      description: "Muestra rsync dry-run sin deployar"
    },
    version: {
      type: "boolean",
      alias: "v",
      description: "Imprime versiones local/remota"
    },
    yes: {
      type: "boolean",
      alias: "y",
      description: "No pedir confirmacion si la version es igual"
    }
  },
  async run({ args }) {
    loadSdaEnv();

    const targets = resolveTargets(args.target);

    for (const target of targets) {
      await prepareTarget(target, args);

      if (args.version || args.diff) {
        continue;
      }

      await runInherited("bash", [target.script], { env: mergedEnv() });
      await healthCheck(target);
    }
  }
});

function resolveTargets(rawTarget) {
  const target = String(rawTarget).trim();

  if (target === "all") {
    return [TARGETS.gateway, TARGETS.tree];
  }

  if (target === "g") {
    return [TARGETS.gateway];
  }

  if (target === "compute" || target === "compute-gateway") {
    return [TARGETS.gateway];
  }

  if (target === "t") {
    return [TARGETS.tree];
  }

  if (target === "tree-indexer" || target === "tree-indexer-python") {
    return [TARGETS.tree];
  }

  if (TARGETS[target]) {
    return [TARGETS[target]];
  }

  throw new Error("Target invalido. Usa gateway, tree o all.");
}

async function prepareTarget(target, args) {
  const localVersions = JSON.parse(readFileSync("lib/system-versions.json", "utf8"));
  const remoteVersions = await readRemoteVersions(target);
  const localVersion = localVersions[target.component];
  const remoteVersion = remoteVersions?.[target.component] ?? null;

  console.log(`${target.name}: local=${localVersion} remote=${remoteVersion ?? "desconocida"}`);

  if (args.diff) {
    await showDiff(target);
    return;
  }

  if (args.version) {
    return;
  }

  if (remoteVersion && compareSemver(localVersion, remoteVersion) < 0) {
    throw new Error(
      `${target.name}: abortado por posible downgrade (${localVersion} < ${remoteVersion}).`
    );
  }

  if (remoteVersion && localVersion === remoteVersion && !args.yes) {
    const accepted = await confirm({
      message: `${target.name} ya esta en ${localVersion}. Deployar de todos modos?`,
      initialValue: false
    });

    if (isCancel(accepted) || !accepted) {
      throw new Error(`${target.name}: deploy cancelado.`);
    }
  }
}

async function readRemoteVersions(target) {
  const result = await run(
    "ssh",
    ["sistemas@srv-ia-01", `cat '${target.remoteDir}/system-versions.json' 2>/dev/null`],
    { allowFailure: true }
  );

  if (result.code !== 0 || !result.stdout.trim()) {
    return null;
  }

  return JSON.parse(result.stdout);
}

async function showDiff(target) {
  if (target.name === "gateway") {
    await runInherited("rsync", [
      "-avn",
      "--delete",
      "--exclude",
      ".env",
      "workers/compute-gateway/",
      "sistemas@srv-ia-01:/home/sistemas/sda-compute-gateway/"
    ]);
    return;
  }

  await runInherited("rsync", [
    "-avn",
    "--delete",
    "--exclude",
    ".env",
    "--exclude",
    ".venv",
    "--exclude",
    "__pycache__",
    "workers/tree-indexer-python/",
    "sistemas@srv-ia-01:/home/sistemas/sda-tree-indexer-python/"
  ]);
}

async function healthCheck(target) {
  const port = target.name === "gateway" ? "8787" : "8790";
  const health = await run(
    "ssh",
    [
      "sistemas@srv-ia-01",
      [
        `token=$(grep -m1 '^${target.tokenKey}=' '${target.remoteDir}/.env' | cut -d= -f2-)`,
        'test -n "$token"',
        `curl -fsS -H "authorization: Bearer $token" http://127.0.0.1:${port}${target.healthPath}`
      ].join(" && ")
    ],
    { allowFailure: true }
  );

  if (health.code !== 0) {
    throw new Error(`${target.name}: healthcheck fallo.\n${health.stderr || health.stdout}`);
  }

  console.log(`${target.name}: ${health.stdout.trim()}`);
}

function compareSemver(left, right) {
  const a = String(left).split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const b = String(right).split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(a.length, b.length);

  for (let index = 0; index < length; index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) {
      return (a[index] ?? 0) > (b[index] ?? 0) ? 1 : -1;
    }
  }

  return 0;
}
