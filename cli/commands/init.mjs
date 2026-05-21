import { confirm, isCancel, password, text } from "@clack/prompts";
import { defineCommand } from "citty";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { run, runInherited } from "../shared/process.mjs";

export const initCommand = defineCommand({
  meta: {
    name: "init",
    alias: "setup",
    description: "Bootstrap local del proyecto"
  },
  args: {
    yes: {
      type: "boolean",
      alias: "y",
      description: "Usa defaults y no pregunta por pasos opcionales"
    }
  },
  async run({ args }) {
    await verifyDependencies();

    const env = readCurrentEnv();
    const supabaseUrl = env.SUPABASE_URL || (await promptText("SUPABASE_URL", "https://project.supabase.co"));
    const serviceKey =
      env.SUPABASE_SERVICE_ROLE_KEY || (await promptSecret("SUPABASE_SERVICE_ROLE_KEY"));
    const anonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY || (await promptSecret("NEXT_PUBLIC_SUPABASE_ANON_KEY"));

    mergeEnv({
      NEXT_PUBLIC_SUPABASE_ANON_KEY: anonKey,
      NEXT_PUBLIC_SUPABASE_URL: supabaseUrl,
      SUPABASE_SERVICE_ROLE_KEY: serviceKey,
      SUPABASE_URL: supabaseUrl
    });

    await runInherited("node", ["bin/sda.mjs", "doctor", "--quick"]);

    const generateTypes =
      args.yes ||
      (await confirm({
        message: "Generar tipos Supabase ahora?",
        initialValue: true
      }));

    if (!isCancel(generateTypes) && generateTypes) {
      await runInherited("npm", ["run", "types:gen"]);
    }

    console.log("Listo. Podes correr `sda dev`.");
  }
});

async function verifyDependencies() {
  const checks = [
    ["node", ["--version"]],
    ["npm", ["--version"]],
    ["supabase", ["--version"]],
    ["python3", ["--version"]]
  ];

  for (const [command, args] of checks) {
    const result = await run(command, args, { allowFailure: true });

    if (result.code !== 0) {
      throw new Error(`Falta dependencia: ${command}`);
    }
  }
}

function readCurrentEnv() {
  if (!existsSync(".env.local")) {
    return {};
  }

  const env = {};

  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    if (!line || line.trim().startsWith("#") || !line.includes("=")) {
      continue;
    }

    const [key, ...rest] = line.split("=");
    env[key.trim()] = rest.join("=").trim().replace(/^['"]|['"]$/g, "");
  }

  return env;
}

async function promptText(message, placeholder) {
  const answer = await text({ message, placeholder });

  if (isCancel(answer) || !String(answer).trim()) {
    throw new Error(`${message} requerido.`);
  }

  return String(answer).trim();
}

async function promptSecret(message) {
  const answer = await password({ message });

  if (isCancel(answer) || !String(answer).trim()) {
    throw new Error(`${message} requerido.`);
  }

  return String(answer).trim();
}

function mergeEnv(values) {
  const current = readCurrentEnv();
  const merged = { ...current, ...values };
  const lines = Object.entries(merged)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  writeFileSync(".env.local", `${lines}\n`);
}
