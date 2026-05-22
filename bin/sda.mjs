#!/usr/bin/env node

import { runMain } from "citty";

import { mainCommand } from "../cli/main.mjs";
import { normalizeArgv } from "../cli/main-argv.mjs";

const normalized = normalizeArgv(process.argv);
process.argv.length = 0;
process.argv.push(...normalized);

runMain(mainCommand);
