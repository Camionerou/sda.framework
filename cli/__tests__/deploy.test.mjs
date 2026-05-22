import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveTargets, compareSemver } from "../commands/deploy.mjs";

// --- resolveTargets ---

test("resolveTargets: 'gateway' returns gateway", () => {
  const targets = resolveTargets("gateway");
  assert.equal(targets.length, 1);
  assert.equal(targets[0].name, "gateway");
});

test("resolveTargets: 'g' alias returns gateway", () => {
  const targets = resolveTargets("g");
  assert.equal(targets.length, 1);
  assert.equal(targets[0].name, "gateway");
});

test("resolveTargets: 'compute' alias returns gateway", () => {
  const targets = resolveTargets("compute");
  assert.equal(targets.length, 1);
  assert.equal(targets[0].name, "gateway");
});

test("resolveTargets: 'compute-gateway' alias returns gateway", () => {
  const targets = resolveTargets("compute-gateway");
  assert.equal(targets.length, 1);
  assert.equal(targets[0].name, "gateway");
});

test("resolveTargets: 'tree' returns tree", () => {
  const targets = resolveTargets("tree");
  assert.equal(targets.length, 1);
  assert.equal(targets[0].name, "tree");
});

test("resolveTargets: 't' alias returns tree", () => {
  const targets = resolveTargets("t");
  assert.equal(targets.length, 1);
  assert.equal(targets[0].name, "tree");
});

test("resolveTargets: 'tree-indexer' alias returns tree", () => {
  const targets = resolveTargets("tree-indexer");
  assert.equal(targets.length, 1);
  assert.equal(targets[0].name, "tree");
});

test("resolveTargets: 'tree-indexer-python' alias returns tree", () => {
  const targets = resolveTargets("tree-indexer-python");
  assert.equal(targets.length, 1);
  assert.equal(targets[0].name, "tree");
});

test("resolveTargets: 'mineru' returns mineru", () => {
  const targets = resolveTargets("mineru");
  assert.equal(targets.length, 1);
  assert.equal(targets[0].name, "mineru");
});

test("resolveTargets: 'm' alias returns mineru", () => {
  const targets = resolveTargets("m");
  assert.equal(targets.length, 1);
  assert.equal(targets[0].name, "mineru");
});

test("resolveTargets: 'mineru-api' alias returns mineru", () => {
  const targets = resolveTargets("mineru-api");
  assert.equal(targets.length, 1);
  assert.equal(targets[0].name, "mineru");
});

test("resolveTargets: 'all' returns gateway and tree", () => {
  const targets = resolveTargets("all");
  assert.equal(targets.length, 2);
  const names = targets.map((t) => t.name);
  assert.ok(names.includes("gateway"));
  assert.ok(names.includes("tree"));
});

test("resolveTargets: invalid target throws with mensaje descriptivo", () => {
  assert.throws(() => resolveTargets("inexistente"), /invalido/i);
});

test("resolveTargets: empty string throws", () => {
  assert.throws(() => resolveTargets(""), /invalido/i);
});

test("resolveTargets: trims whitespace from target", () => {
  const targets = resolveTargets("  gateway  ");
  assert.equal(targets[0].name, "gateway");
});

// --- compareSemver ---

test("compareSemver: 1.2.3 < 1.2.4", () => {
  assert.equal(compareSemver("1.2.3", "1.2.4"), -1);
});

test("compareSemver: 0.2.0 > 0.1.7", () => {
  assert.equal(compareSemver("0.2.0", "0.1.7"), 1);
});

test("compareSemver: 1.0.0 === 1.0.0", () => {
  assert.equal(compareSemver("1.0.0", "1.0.0"), 0);
});

test("compareSemver: 2.0.0 > 1.9.9", () => {
  assert.equal(compareSemver("2.0.0", "1.9.9"), 1);
});

test("compareSemver: 1.10.0 > 1.9.0", () => {
  assert.equal(compareSemver("1.10.0", "1.9.0"), 1);
});

test("compareSemver: 0.0.1 < 0.0.2", () => {
  assert.equal(compareSemver("0.0.1", "0.0.2"), -1);
});

test("compareSemver: strips leading v prefix from both sides", () => {
  // The impl splits on /[.-]/ so 'v1.2.3' → ['v1','2','3'] → parseInt('v1') = 1
  // Edge case: ensure v prefix doesn't break comparison
  assert.equal(compareSemver("v1.2.3", "v1.2.3"), 0);
  assert.equal(compareSemver("v1.2.4", "v1.2.3"), 1);
  assert.equal(compareSemver("v1.2.3", "v1.2.4"), -1);
});

test("compareSemver: equal versions return 0", () => {
  assert.equal(compareSemver("0.1.7", "0.1.7"), 0);
});
