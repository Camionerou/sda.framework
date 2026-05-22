import { confirm, isCancel } from "@clack/prompts";
import { defineCommand } from "citty";

import { runInherited } from "../shared/process.mjs";

const HOST = "sistemas@srv-ia-01";

const SERVICE_MAP = {
  gateway: { cmd: "--user", unit: "sda-compute-gateway.service" },
  tree: { cmd: "--user", unit: "sda-tree-indexer.service" },
  mineru: { cmd: null, unit: "mineru-api.service", sudo: true }
};

export const sshCommand = defineCommand({
  meta: {
    name: "ssh",
    description: "SSH a srv-ia-01 con shortcuts y passthrough generico"
  },
  args: {
    command: {
      type: "positional",
      required: false,
      description: "Shortcut (status|logs|restart|gpu) o comando shell para ejecutar remotamente",
      valueHint: "<command or shortcut>"
    },
    follow: {
      type: "boolean",
      alias: "f",
      description: "Seguir logs en tiempo real (para: logs)"
    },
    lines: {
      type: "string",
      alias: "n",
      description: "Cantidad de lineas de log (para: logs, default 50)"
    },
    yes: {
      type: "boolean",
      alias: "y",
      description: "No pedir confirmacion (para: restart)"
    }
  },
  async run({ args, rawArgs }) {
    const firstArg = args.command ?? rawArgs[0] ?? null;

    if (!firstArg) {
      await runInherited("ssh", [HOST]);
      return;
    }

    if (firstArg === "status") {
      await runStatus();
      return;
    }

    if (firstArg === "gpu") {
      await runGpu();
      return;
    }

    if (firstArg === "logs") {
      const service = rawArgs[1] ?? null;
      await runLogs(service, args);
      return;
    }

    if (firstArg === "restart") {
      const service = rawArgs[1] ?? null;
      await runRestart(service, args);
      return;
    }

    // Generic passthrough: join all positional args as a remote shell command
    const remoteCmd = rawArgs
      .filter((a) => !a.startsWith("-"))
      .join(" ");

    if (!remoteCmd) {
      throw new Error("Nada que ejecutar. Pasa un comando o un shortcut.");
    }

    await runInherited("ssh", [HOST, remoteCmd]);
  }
});

async function runStatus() {
  const sections = [
    {
      label: "GPU",
      cmd: "nvidia-smi --query-gpu=memory.used,memory.free,utilization.gpu --format=csv"
    },
    {
      label: "mineru-api",
      cmd: "systemctl status mineru-api.service --no-pager | head -3"
    },
    {
      label: "user services",
      cmd: "systemctl --user status sda-compute-gateway.service sda-tree-indexer.service --no-pager | head -10"
    },
    {
      label: "docker",
      cmd: 'docker ps --format "table {{.Names}}\\t{{.Status}}" | head -5'
    }
  ];

  const parts = sections.map((s) => `echo '=== ${s.label} ===' && ${s.cmd}`);
  const remoteCmd = parts.join(" && echo && ");

  await runInherited("ssh", [HOST, remoteCmd]);
}

async function runGpu() {
  const remoteCmd = [
    "nvidia-smi --query-gpu=name,memory.used,memory.free,memory.total,utilization.gpu --format=csv",
    "echo",
    "nvidia-smi --query-compute-apps=pid,used_memory,process_name --format=csv"
  ].join(" && ");

  await runInherited("ssh", [HOST, remoteCmd]);
}

async function runLogs(service, args) {
  if (!service || !SERVICE_MAP[service]) {
    const valid = Object.keys(SERVICE_MAP).join(", ");
    throw new Error(`Servicio invalido. Usa uno de: ${valid}`);
  }

  const svc = SERVICE_MAP[service];
  const lineCount = args.lines ?? "50";
  const follow = args.follow;

  let journalParts = [];

  if (svc.sudo) {
    journalParts.push("sudo");
  }

  journalParts.push("journalctl");

  if (svc.cmd) {
    journalParts.push(svc.cmd);
  }

  journalParts.push("-u", svc.unit);

  if (follow) {
    journalParts.push("-f", "--no-pager");
  } else {
    journalParts.push("-n", lineCount);
  }

  const remoteCmd = journalParts.join(" ");

  await runInherited("ssh", [HOST, remoteCmd]);
}

async function runRestart(service, args) {
  if (!service || !SERVICE_MAP[service]) {
    const valid = Object.keys(SERVICE_MAP).join(", ");
    throw new Error(`Servicio invalido. Usa uno de: ${valid}`);
  }

  if (!args.yes) {
    const accepted = await confirm({
      message: `Reiniciar ${service} en srv-ia-01?`,
      initialValue: false
    });

    if (isCancel(accepted) || !accepted) {
      throw new Error("Restart cancelado.");
    }
  }

  const svc = SERVICE_MAP[service];

  let restartParts = [];

  if (svc.sudo) {
    restartParts.push("sudo");
  }

  restartParts.push("systemctl");

  if (svc.cmd) {
    restartParts.push(svc.cmd);
  }

  restartParts.push("restart", svc.unit);

  const remoteCmd = restartParts.join(" ");

  await runInherited("ssh", [HOST, remoteCmd]);
}
