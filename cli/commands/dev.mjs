import { defineCommand } from "citty";
import { spawn } from "node:child_process";

export const devCommand = defineCommand({
  meta: {
    name: "dev",
    alias: "run",
    description: "Arranca Next, Inngest dev y opcionalmente tunnel/log tail"
  },
  args: {
    "tail-logs": {
      type: "boolean",
      alias: "l",
      description: "Agrega tail de indexing events"
    },
    tunnel: {
      type: "boolean",
      alias: "t",
      description: "Agrega cloudflared tunnel publico"
    }
  },
  async run({ args }) {
    const processes = [
      start("next", "npm", ["run", "dev"]),
      start("inngest", "npx", ["inngest-cli@latest", "dev", "-u", "http://localhost:3000/api/inngest"])
    ];

    if (args.tunnel) {
      processes.push(start("tunnel", "npx", ["cloudflared@latest", "tunnel", "--url", "http://localhost:3000"]));
    }

    if (args["tail-logs"]) {
      processes.push(start("tail", "node", ["bin/sda.mjs", "indexing", "tail", "latest"]));
    }

    const stop = () => {
      for (const child of processes) {
        child.kill("SIGTERM");
      }
    };

    process.on("SIGINT", () => {
      stop();
      process.exit(130);
    });
    process.on("SIGTERM", () => {
      stop();
      process.exit(143);
    });

    await new Promise((resolve, reject) => {
      for (const child of processes) {
        child.on("exit", (code) => {
          if (code && code !== 0) {
            stop();
            reject(new Error(`Proceso dev termino con codigo ${code}.`));
            return;
          }

          resolve();
        });
      }
    });
  }
});

function start(label, command, args) {
  const child = spawn(command, args, {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  child.stdout.on("data", (chunk) => writePrefixed(label, chunk, process.stdout));
  child.stderr.on("data", (chunk) => writePrefixed(label, chunk, process.stderr));

  return child;
}

function writePrefixed(label, chunk, output) {
  for (const line of chunk.toString().split(/\r?\n/)) {
    if (line) {
      output.write(`[${label.padEnd(8)}] ${line}\n`);
    }
  }
}
