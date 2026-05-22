import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeArgv } from "../main-argv.mjs";

const base = ["node", "sda.mjs"];
const argv = (...args) => [...base, ...args];

// --- alias resolution ---

test("alias ? resolves to help", () => {
  const out = normalizeArgv(argv("?"));
  assert.equal(out[2], "help");
});

test("alias h resolves to help", () => {
  const out = normalizeArgv(argv("h"));
  assert.equal(out[2], "help");
});

test("alias s resolves to ssh and preserves remaining args", () => {
  const out = normalizeArgv(argv("s", "status"));
  assert.equal(out[2], "ssh");
  assert.equal(out[3], "status");
});

test("alias dp resolves to deploy", () => {
  const out = normalizeArgv(argv("dp"));
  assert.equal(out[2], "deploy");
});

test("alias dep resolves to deploy", () => {
  const out = normalizeArgv(argv("dep"));
  assert.equal(out[2], "deploy");
});

test("alias r resolves to redis", () => {
  const out = normalizeArgv(argv("r"));
  assert.equal(out[2], "redis");
});

test("alias i resolves to indexing", () => {
  const out = normalizeArgv(argv("i"));
  assert.equal(out[2], "indexing");
});

test("alias idx resolves to indexing", () => {
  const out = normalizeArgv(argv("idx"));
  assert.equal(out[2], "indexing");
});

test("alias ok resolves to doctor", () => {
  const out = normalizeArgv(argv("ok"));
  assert.equal(out[2], "doctor");
});

test("alias d resolves to doctor", () => {
  const out = normalizeArgv(argv("d"));
  assert.equal(out[2], "doctor");
});

test("alias v resolves to invite", () => {
  const out = normalizeArgv(argv("v"));
  assert.equal(out[2], "invite");
});

test("alias inv resolves to invite", () => {
  const out = normalizeArgv(argv("inv"));
  assert.equal(out[2], "invite");
});

test("alias sh resolves to ship", () => {
  const out = normalizeArgv(argv("sh"));
  assert.equal(out[2], "ship");
});

test("no command defaults to help", () => {
  const out = normalizeArgv(base);
  assert.equal(out[2], "help");
});

test("does not mutate input array", () => {
  const input = argv("?");
  normalizeArgv(input);
  assert.equal(input[2], "?");
});

// --- default subcommand insertion ---

test("redis without subcommand defaults to ping", () => {
  const out = normalizeArgv(argv("redis"));
  assert.equal(out[2], "redis");
  assert.equal(out[3], "ping");
});

test("redis with --help inserts ping before the flag", () => {
  // shouldInsertDefaultSubcommand: flags starting with '-' trigger default insertion
  const out = normalizeArgv(argv("redis", "--help"));
  assert.equal(out[3], "ping");
  assert.equal(out[4], "--help");
});

test("redis with explicit subcommand preserves it", () => {
  const out = normalizeArgv(argv("redis", "get", "mykey"));
  assert.equal(out[3], "get");
  assert.equal(out[4], "mykey");
});

test("indexing without subcommand defaults to list", () => {
  const out = normalizeArgv(argv("indexing"));
  assert.equal(out[3], "list");
});

test("indexing with --help inserts list before the flag", () => {
  // shouldInsertDefaultSubcommand: flags starting with '-' trigger default insertion
  const out = normalizeArgv(argv("indexing", "--help"));
  assert.equal(out[3], "list");
  assert.equal(out[4], "--help");
});

test("indexing with explicit subcommand preserves it", () => {
  const out = normalizeArgv(argv("indexing", "status"));
  assert.equal(out[3], "status");
});

test("deploy without subcommand inserts all --version", () => {
  const out = normalizeArgv(argv("deploy"));
  assert.equal(out[3], "all");
  assert.equal(out[4], "--version");
});

test("deploy with --help inserts all --version before the flag", () => {
  // shouldInsertDefaultSubcommand: flags starting with '-' trigger default insertion
  const out = normalizeArgv(argv("deploy", "--help"));
  assert.equal(out[3], "all");
  assert.equal(out[4], "--version");
  assert.equal(out[5], "--help");
});

test("deploy with explicit target preserves it", () => {
  const out = normalizeArgv(argv("deploy", "gateway"));
  assert.equal(out[3], "gateway");
});

test("doctor without args inserts --quick", () => {
  const out = normalizeArgv(argv("doctor"));
  assert.equal(out[3], "--quick");
});

test("doctor with --help inserts --quick (--help is not substantial)", () => {
  // hasSubstantialArgs excludes --help and -h, so --quick is still inserted
  const out = normalizeArgv(argv("doctor", "--help"));
  assert.ok(out.includes("--quick"));
});

test("doctor with substantial arg does not insert --quick", () => {
  const out = normalizeArgv(argv("doctor", "check-ssh"));
  assert.ok(!out.includes("--quick"));
});

test("invite with email inserts create subcommand", () => {
  const out = normalizeArgv(argv("invite", "user@example.com"));
  assert.equal(out[3], "create");
  assert.equal(out[4], "user@example.com");
});

test("invite without email does not insert create", () => {
  const out = normalizeArgv(argv("invite", "list"));
  assert.equal(out[3], "list");
});
