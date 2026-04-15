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
  "syncPush.js",
  "removeMapping.js",
]) {
  copyFileSync(join(build, f), join(out, f));
}

// syncPull.js = dagGraph.js + syncPull.js (concatenated)
// dagGraph.js is compiled as an ES module (dist/); strip module syntax
// so it works inside syncPull's IIFE in the OmniFocus plugin.
const dagGraph = readFileSync(join(dist, "dagGraph.js"), "utf-8")
  .replace(/^"use strict";\s*/m, "")
  .replace(/^export /gm, "")
  .replace(/^import .*;\s*$/gm, "");
const syncPull = readFileSync(join(build, "syncPull.js"), "utf-8");

// Insert dagGraph functions right after the IIFE opening
const assembled = syncPull.replace(
  /^("use strict";\s*\(\(\)\s*=>\s*\{)/,
  "$1\n" + dagGraph,
);
writeFileSync(join(out, "syncPull.js"), assembled);

console.log("Plugin assembled in " + out);
