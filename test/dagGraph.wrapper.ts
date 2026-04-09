// Wrapper that makes dagGraph functions importable for tests.
// dagGraph.ts compiles to build/dagGraph.js as top-level functions.
// We eval the compiled JS in a sandbox and extract them.

import { readFileSync } from "fs";
import { join } from "path";

const jsPath = join(__dirname, "..", "build", "dagGraph.js");
const jsCode = readFileSync(jsPath, "utf-8").replace(/^"use strict";\s*/, "");

const sandbox: Record<string, any> = {};
const fn = new Function(
  "exports",
  jsCode +
    `
  exports.buildDag = buildDag;
  exports.transitiveReduction = transitiveReduction;
  exports.isReachable = isReachable;
  exports.findChain = findChain;
  exports.areIndependent = areIndependent;
  exports.topologicalSort = topologicalSort;
  exports.dagToTree = dagToTree;
  exports.flattenTree = flattenTree;
  exports.filterTasksForTeam = filterTasksForTeam;
`,
);
fn(sandbox);

export const buildDag = sandbox.buildDag;
export const transitiveReduction = sandbox.transitiveReduction;
export const isReachable = sandbox.isReachable;
export const findChain = sandbox.findChain;
export const areIndependent = sandbox.areIndependent;
export const topologicalSort = sandbox.topologicalSort;
export const dagToTree = sandbox.dagToTree;
export const flattenTree = sandbox.flattenTree;
export const filterTasksForTeam = sandbox.filterTasksForTeam;
