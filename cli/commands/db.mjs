import { confirm, isCancel, text } from "@clack/prompts";
import { defineCommand } from "citty";
import { mkdirSync, writeFileSync } from "node:fs";

import { run, runInherited } from "../shared/process.mjs";

const pushCommand = defineCommand({
  meta: {
    name: "push",
    description: "Preview y aplica migraciones remotas"
  },
  args: {
    yes: {
      type: "boolean",
      description: "No pedir confirmacion interactiva"
    }
  },
  async run({ args }) {
    console.log("Migraciones pendientes:");
    await runInherited("supabase", ["db", "push", "--linked", "--dry-run"]);

    if (!args.yes) {
      const accepted = await confirm({
        message: "Aplicar estas migraciones en Supabase remoto?",
        initialValue: false
      });

      if (isCancel(accepted) || !accepted) {
        console.log("Cancelado.");
        return;
      }
    }

    await runInherited("supabase", ["db", "push", "--linked", "--yes"]);
  }
});

const resetCommand = defineCommand({
  meta: {
    name: "reset",
    description: "Reset de DB local con confirmacion fuerte"
  },
  args: {
    confirm: {
      type: "boolean",
      description: "Confirma reset local"
    }
  },
  async run({ args }) {
    if (!args.confirm) {
      throw new Error("Este comando destruye la DB local. Reintentá con --confirm.");
    }

    await runInherited("supabase", ["db", "reset", "--local"]);
  }
});

const migrateCommand = defineCommand({
  meta: {
    name: "migrate",
    description: "Crea una migracion timestampada"
  },
  args: {
    name: {
      type: "positional",
      description: "Nombre slug de la migracion"
    }
  },
  async run({ args }) {
    let name = args.name;

    if (!name) {
      const answer = await text({
        message: "Nombre de la migracion",
        placeholder: "add_missing_index"
      });

      if (isCancel(answer)) {
        console.log("Cancelado.");
        return;
      }

      name = answer;
    }

    const slug = String(name)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");

    if (!slug) {
      throw new Error("Nombre de migracion invalido.");
    }

    mkdirSync("supabase/migrations", { recursive: true });
    const now = new Date();
    const timestamp = [
      now.getUTCFullYear(),
      String(now.getUTCMonth() + 1).padStart(2, "0"),
      String(now.getUTCDate()).padStart(2, "0"),
      String(now.getUTCHours()).padStart(2, "0"),
      String(now.getUTCMinutes()).padStart(2, "0"),
      String(now.getUTCSeconds()).padStart(2, "0")
    ].join("");
    const path = `supabase/migrations/${timestamp}_${slug}.sql`;

    writeFileSync(path, `-- ${slug}\n\n`, { flag: "wx" });
    console.log(path);
  }
});

function passthroughCommand(name, commandArgs) {
  return defineCommand({
    meta: {
      name,
      description: `Ejecuta ${["supabase", ...commandArgs].join(" ")}`
    },
    async run() {
      const result = await run("supabase", commandArgs, { stdio: "inherit" });

      if (result.code !== 0) {
        process.exitCode = result.code;
      }
    }
  });
}

export const dbCommand = defineCommand({
  meta: {
    name: "db",
    description: "Wrappers seguros sobre Supabase CLI"
  },
  subCommands: {
    diff: passthroughCommand("diff", ["db", "diff"]),
    migrate: migrateCommand,
    push: pushCommand,
    reset: resetCommand,
    test: passthroughCommand("test", ["test", "db"])
  }
});
