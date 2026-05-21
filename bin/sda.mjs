#!/usr/bin/env node

import { runMain } from "citty";

import { mainCommand } from "../cli/main.mjs";

const commandAliases = new Map([
  ["?", "help"],
  ["h", "help"],
  ["ok", "doctor"],
  ["d", "doctor"],
  ["r", "redis"],
  ["i", "indexing"],
  ["idx", "indexing"],
  ["dp", "deploy"],
  ["dep", "deploy"],
  ["v", "invite"],
  ["inv", "invite"],
  ["sh", "ship"]
]);

if (!process.argv[2]) {
  process.argv.splice(2, 0, "help");
}

if (commandAliases.has(process.argv[2])) {
  process.argv[2] = commandAliases.get(process.argv[2]);
}

if (process.argv[2] === "doctor" && !hasSubstantialArgs(3)) {
  process.argv.splice(3, 0, "--quick");
}

if (process.argv[2] === "redis" && shouldInsertDefaultSubcommand(3)) {
  process.argv.splice(3, 0, "ping");
}

if (process.argv[2] === "indexing" && shouldInsertDefaultSubcommand(3)) {
  process.argv.splice(3, 0, "list");
}

if (process.argv[2] === "deploy" && shouldInsertDefaultSubcommand(3)) {
  process.argv.splice(3, 0, "all", "--version");
}

if (process.argv[2] === "invite" && process.argv[3]?.includes("@")) {
  process.argv.splice(3, 0, "create");
}

runMain(mainCommand);

function hasSubstantialArgs(offset) {
  return process.argv.slice(offset).some((arg) => arg !== "--help" && arg !== "-h");
}

function shouldInsertDefaultSubcommand(offset) {
  return !process.argv[offset] || process.argv[offset].startsWith("-");
}
