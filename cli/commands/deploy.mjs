import { confirm, isCancel } from "@clack/prompts";
import { defineCommand } from "citty";
import { readFileSync, writeFileSync } from "node:fs";

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
  mineru: {
    component: null,
    healthPath: "/docs",
    name: "mineru",
    remoteDir: "/home/sistemas/sda-mineru",
    service: "mineru-api.service",
    tokenKey: null
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
    },
    smoke: {
      type: "boolean",
      description: "Tras el deploy, hace health check end-to-end de gateway+tree+mineru con latencia"
    },
    rollback: {
      type: "boolean",
      description: "Revertir lib/system-versions.json al commit anterior y redeployar el target"
    }
  },
  async run({ args }) {
    loadSdaEnv();

    if (args.rollback) {
      await applyRollback(args.target);
    }

    const targets = resolveTargets(args.target);

    for (const target of targets) {
      await prepareTarget(target, args);

      if (args.version || args.diff) {
        continue;
      }

      if (target.name === "mineru") {
        await deployMineruApi();
      } else {
        await runInherited("bash", [target.script], { env: mergedEnv() });
      }

      await healthCheck(target);
    }

    if (args.smoke) {
      await runEndToEndSmoke();
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

  if (target === "m" || target === "mineru-api") {
    return [TARGETS.mineru];
  }

  if (TARGETS[target]) {
    return [TARGETS[target]];
  }

  throw new Error("Target invalido. Usa gateway, tree, mineru o all.");
}

async function prepareTarget(target, args) {
  if (target.component === null) {
    console.log(`${target.name}: systemd reapply`);
    return;
  }

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

async function applyRollback(rawTarget) {
  const versionsPath = "lib/system-versions.json";

  const accepted = await confirm({
    message: `Esto revertirá \`${versionsPath}\` al HEAD~ anterior y redeployará ${rawTarget}. Continuar?`,
    initialValue: false
  });

  if (isCancel(accepted) || !accepted) {
    throw new Error("rollback cancelado.");
  }

  const prevResult = await run("git", ["show", `HEAD~1:${versionsPath}`], { allowFailure: true });

  if (prevResult.code !== 0) {
    throw new Error(`rollback: no se pudo leer HEAD~1:${versionsPath}.\n${prevResult.stderr}`);
  }

  const prevContent = prevResult.stdout;
  const currentContent = readFileSync(versionsPath, "utf8");

  if (prevContent.trim() === currentContent.trim()) {
    throw new Error(`rollback: no hay cambios entre HEAD y HEAD~1 en ${versionsPath}.`);
  }

  writeFileSync(versionsPath, prevContent, "utf8");
  console.log(`rollback: ${versionsPath} revertido a HEAD~1.`);

  await run("git", ["add", versionsPath], {});
  await run(
    "git",
    ["commit", "-m", `chore(versions): rollback ${rawTarget} via sda deploy --rollback`],
    {}
  );

  console.log("rollback: commit creado. Continuando con deploy...");
}

async function runEndToEndSmoke() {
  console.log("\n=== smoke test ===");

  const checks = [
    {
      label: "gateway",
      fn: async () => {
        const remoteVersions = await run(
          "ssh",
          [
            "sistemas@srv-ia-01",
            [
              `token=$(grep -m1 '^${TARGETS.gateway.tokenKey}=' '${TARGETS.gateway.remoteDir}/.env' | cut -d= -f2-)`,
              'test -n "$token"',
              `curl -fsS -H "authorization: Bearer $token" http://127.0.0.1:8787${TARGETS.gateway.healthPath}`
            ].join(" && ")
          ],
          { allowFailure: true }
        );
        return remoteVersions.code === 0;
      }
    },
    {
      label: "tree",
      fn: async () => {
        const result = await run(
          "ssh",
          [
            "sistemas@srv-ia-01",
            [
              `token=$(grep -m1 '^${TARGETS.tree.tokenKey}=' '${TARGETS.tree.remoteDir}/.env' | cut -d= -f2-)`,
              'test -n "$token"',
              `curl -fsS -H "authorization: Bearer $token" http://127.0.0.1:8790${TARGETS.tree.healthPath}`
            ].join(" && ")
          ],
          { allowFailure: true }
        );
        return result.code === 0;
      }
    },
    {
      label: "mineru",
      fn: async () => {
        const result = await run(
          "ssh",
          ["sistemas@srv-ia-01", `curl -fsS http://127.0.0.1:8765${TARGETS.mineru.healthPath}`],
          { allowFailure: true }
        );
        return result.code === 0;
      }
    }
  ];

  const rows = [];

  for (const check of checks) {
    const t0 = Date.now();
    const ok = await check.fn();
    const latencyMs = Date.now() - t0;
    rows.push({ label: check.label, ok, latencyMs });
  }

  const labelW = 10;
  const okW = 6;
  const latW = 12;
  const header = `${"service".padEnd(labelW)}${"ok?".padEnd(okW)}${"latency ms".padStart(latW)}`;
  const divider = "-".repeat(header.length);
  console.log(header);
  console.log(divider);

  for (const row of rows) {
    const line = `${row.label.padEnd(labelW)}${(row.ok ? "yes" : "NO").padEnd(okW)}${String(row.latencyMs).padStart(latW)}`;
    console.log(line);
  }

  const failed = rows.filter((r) => !r.ok);

  if (failed.length > 0) {
    throw new Error(`smoke: ${failed.map((r) => r.label).join(", ")} fallo.`);
  }

  console.log("smoke: all OK\n");
}

async function deployMineruApi() {
  const unitContent = `[Unit]
Description=MinerU FastAPI server (hot models, GPU)
After=network.target

[Service]
Type=simple
User=sistemas
Group=sistemas
WorkingDirectory=/home/sistemas/sda-mineru
Environment=PATH=/home/sistemas/sda-mineru/.venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=CUDA_VISIBLE_DEVICES=0
Environment=MINERU_DEVICE_MODE=cuda
ExecStart=/home/sistemas/sda-mineru/.venv/bin/mineru-api --host 127.0.0.1 --port 8765 --enable-vlm-preload True
Restart=on-failure
RestartSec=10
LimitNOFILE=65536
TimeoutStartSec=600

[Install]
WantedBy=multi-user.target
`;

  await runInherited("ssh", [
    "sistemas@srv-ia-01",
    `sudo tee /etc/systemd/system/mineru-api.service > /dev/null <<'UNITEOF'\n${unitContent}\nUNITEOF`
  ]);

  await runInherited("ssh", [
    "sistemas@srv-ia-01",
    "sudo systemctl daemon-reload && sudo systemctl enable mineru-api.service && sudo systemctl restart mineru-api.service"
  ]);

  console.log("mineru-api: waiting for VLM preload (hasta 240s)...");
  const pollScript = `for i in $(seq 1 48); do
  if curl -sf http://127.0.0.1:8765/docs > /dev/null 2>&1; then
    echo READY
    exit 0
  fi
  sleep 5
done
echo TIMEOUT
exit 1`;

  const result = await run("ssh", ["sistemas@srv-ia-01", pollScript], { allowFailure: true });

  if (result.code !== 0 || !result.stdout.includes("READY")) {
    throw new Error(`mineru-api: readiness timeout. Output: ${result.stdout}`);
  }

  console.log("mineru-api: ready.");
}

async function healthCheck(target) {
  if (target.name === "mineru") {
    const health = await run(
      "ssh",
      ["sistemas@srv-ia-01", `curl -fsS http://127.0.0.1:8765${target.healthPath}`],
      { allowFailure: true }
    );

    if (health.code !== 0) {
      throw new Error(`${target.name}: healthcheck fallo.\n${health.stderr || health.stdout}`);
    }

    console.log(`${target.name}: OK`);
    return;
  }

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
