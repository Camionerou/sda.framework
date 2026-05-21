import { confirm, isCancel, multiselect, text } from "@clack/prompts";
import { defineCommand } from "citty";

import { currentBranch, gitStatusRows, hasStagedChanges } from "../shared/git.mjs";
import { run, runInherited } from "../shared/process.mjs";

export const shipCommand = defineCommand({
  meta: {
    name: "ship",
    description: "Corre checks, commitea y pushea la branch actual"
  },
  args: {
    all: {
      type: "boolean",
      description: "Stagea todos los cambios antes de commitear"
    },
    message: {
      type: "string",
      alias: "m",
      description: "Commit message"
    },
    "no-push": {
      type: "boolean",
      description: "No hacer git push"
    },
    "skip-checks": {
      type: "boolean",
      description: "Saltea lint/typecheck/build"
    }
  },
  async run({ args }) {
    const branch = await currentBranch();

    if (branch === "main") {
      const accepted = await confirm({
        message: "Estas en main. Continuar con ship?",
        initialValue: false
      });

      if (isCancel(accepted) || !accepted) {
        console.log("Cancelado.");
        return;
      }
    }

    if (!args["skip-checks"]) {
      await runChecks();
    } else {
      console.warn("Checks salteados por --skip-checks.");
    }

    await prepareStaging(args);

    if (!(await hasStagedChanges())) {
      console.log("No hay cambios staged para commitear.");
      return;
    }

    const message = await commitMessage(args.message);
    await runInherited("git", ["commit", "-m", message]);

    if (!args["no-push"]) {
      await runInherited("git", ["push", "origin", branch]);
    }
  }
});

async function runChecks() {
  const checks = [
    ["lint", "npm", ["run", "lint"]],
    ["typecheck", "npm", ["run", "typecheck"]],
    ["build", "npm", ["run", "build"]]
  ];
  const results = await Promise.all(
    checks.map(([label, command, args]) =>
      run(command, args, {
        allowFailure: true,
        prefix: label
      }).then((result) => ({ label, result }))
    )
  );
  const failed = results.filter(({ result }) => result.code !== 0);

  if (failed.length > 0) {
    throw new Error(`Checks fallidos: ${failed.map(({ label }) => label).join(", ")}.`);
  }
}

async function prepareStaging(args) {
  if (args.all) {
    await runInherited("git", ["add", "-A"]);
    return;
  }

  if (await hasStagedChanges()) {
    return;
  }

  const rows = (await gitStatusRows()).filter((row) => row.path !== "AGENT.md");

  if (rows.length === 0) {
    return;
  }

  const selected = await multiselect({
    message: "Elegí archivos para stagear",
    options: rows.map((row) => ({
      hint: row.raw.slice(0, 2),
      label: row.path,
      value: row.path
    })),
    required: true
  });

  if (isCancel(selected)) {
    console.log("Cancelado.");
    return;
  }

  await runInherited("git", ["add", "--", ...selected]);
}

async function commitMessage(value) {
  if (value?.trim()) {
    return value.trim();
  }

  const answer = await text({
    message: "Commit message",
    placeholder: "add sda cli"
  });

  if (isCancel(answer) || !String(answer).trim()) {
    throw new Error("Commit message requerido.");
  }

  return String(answer).trim();
}
