#!/usr/bin/env node

import { runMain } from "citty";

import { mainCommand } from "../cli/main.mjs";

if (process.argv[2] === "invite" && process.argv[3]?.includes("@")) {
  process.argv.splice(3, 0, "create");
}

runMain(mainCommand);
