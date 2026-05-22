import { defineCommand } from "citty";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
);
const invokedName = basename(process.argv[1] ?? "sda").replace(/\.mjs$/, "");
const commandName = ["sda", "sdaframework", "sf", "sdf"].includes(invokedName)
  ? invokedName
  : "sda";

export const mainCommand = defineCommand({
  meta: {
    name: commandName,
    version: packageJson.version,
    description: "CLI operacional local para SDA Framework"
  },
  subCommands: {
    db: () => import("./commands/db.mjs").then((module) => module.dbCommand),
    deploy: () => import("./commands/deploy.mjs").then((module) => module.deployCommand),
    dev: () => import("./commands/dev.mjs").then((module) => module.devCommand),
    doctor: () => import("./commands/doctor.mjs").then((module) => module.doctorCommand),
    help: () => import("./commands/help.mjs").then((module) => module.helpCommand),
    indexing: () => import("./commands/indexing.mjs").then((module) => module.indexingCommand),
    init: () => import("./commands/init.mjs").then((module) => module.initCommand),
    invite: () => import("./commands/invite.mjs").then((module) => module.inviteCommand),
    redis: () => import("./commands/redis.mjs").then((module) => module.redisCommand),
    ship: () => import("./commands/ship.mjs").then((module) => module.shipCommand),
    ssh: () => import("./commands/ssh.mjs").then((module) => module.sshCommand)
  }
});
