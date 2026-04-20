// Assemble the plugin from compiled JS files.
// dagGraph.js is prepended to syncPull.js since syncPull depends on it
// and OmniFocus loads each file independently (no module system).

import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from "fs";
import { join } from "path";

const build = "build";
const dist = "dist";
const out = join("DagnySync.omnifocusjs", "Resources");

mkdirSync(out, { recursive: true });

// Files that are copied directly
for (const f of [
  "dagnyLib.js",
  "configure.js",
  "removeMapping.js",
]) {
  copyFileSync(join(build, f), join(out, f));
}

// dagGraph.js is compiled as an ES module (dist/); strip module syntax
// so it works inside each plugin file's IIFE in the OmniFocus plugin.
const dagGraph = readFileSync(join(dist, "dagGraph.js"), "utf-8")
  .replace(/^"use strict";\s*/m, "")
  .replace(/^export /gm, "")
  .replace(/^import .*;\s*$/gm, "");

// Inject dagGraph functions into both syncPull.js and syncPush.js,
// since both now use graph functions (buildLabeledDag, etc.).
for (const f of ["syncPull.js", "syncPush.js"]) {
  const src = readFileSync(join(build, f), "utf-8");
  const assembled = src.replace(
    /^("use strict";\s*\(\(\)\s*=>\s*\{)/,
    "$1\n" + dagGraph,
  );
  writeFileSync(join(out, f), assembled);
}

console.log("Plugin assembled in " + out);
