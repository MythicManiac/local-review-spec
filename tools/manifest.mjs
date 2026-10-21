#!/usr/bin/env node
// Checks (or writes) MANIFEST.sha256: the hashes of the normative files of the frozen baseline.
//
//   node tools/manifest.mjs                 check this repository against MANIFEST.sha256
//   node tools/manifest.mjs --root <dir>    check a copy of the spec elsewhere (an implementation's project)
//   node tools/manifest.mjs --write         regenerate MANIFEST.sha256 (a deliberate act: see CHANGE_CONTROL.md)
//
// The normative set is SPEC.md, ALGORITHMS.md, schema/*, vectors/*.json, and the example's data
// (examples/state, examples/expected, examples/content except fixture.bundle, examples/ids.json).
// Text files outside examples/ are hashed with CRLF read as LF, so a checkout that converted line endings
// still matches; everything under examples/ is hashed byte for byte (its exact bytes are the point).
// A line of the manifest is `<sha256 hex>  <path>`, sorted by path.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const rootArg = args.indexOf("--root");
const root = rootArg === -1 ? join(dirname(fileURLToPath(import.meta.url)), "..") : args[rootArg + 1];
const write = args.includes("--write");

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
const rel = (p) => relative(root, p).split(sep).join("/");

function normativeFiles() {
  const files = ["SPEC.md", "ALGORITHMS.md", "examples/ids.json"];
  for (const dir of ["schema", "vectors", "examples/state", "examples/expected", "examples/content"]) {
    for (const p of walk(join(root, dir))) files.push(rel(p));
  }
  return [...new Set(files)]
    .filter((f) => !f.endsWith(".bundle") && !(f.startsWith("vectors/") && f.endsWith(".md")))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function digest(path) {
  let bytes = readFileSync(join(root, path));
  if (!path.startsWith("examples/")) bytes = Buffer.from(bytes.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
  return createHash("sha256").update(bytes).digest("hex");
}

const current = new Map(normativeFiles().map((f) => [f, digest(f)]));
const manifestPath = join(root, "MANIFEST.sha256");

if (write) {
  writeFileSync(manifestPath, [...current].map(([f, h]) => `${h}  ${f}`).join("\n") + "\n");
  console.log(`wrote MANIFEST.sha256: ${current.size} files`);
  process.exit(0);
}

if (!existsSync(manifestPath)) {
  console.error("no MANIFEST.sha256 in " + root);
  process.exit(2);
}
const recorded = new Map(
  readFileSync(manifestPath, "utf8")
    .split(/\r?\n/) // a checkout with core.autocrlf=true gives this file CRLF line ends
    .filter(Boolean)
    .map((l) => {
      const m = /^([0-9a-f]{64})  (.+)$/.exec(l);
      if (!m) throw new Error(`bad manifest line: ${l}`);
      return [m[2], m[1]];
    }),
);
const problems = [];
for (const [f, h] of recorded) {
  if (!current.has(f)) problems.push(`missing:  ${f}`);
  else if (current.get(f) !== h) problems.push(`changed:  ${f}`);
}
for (const f of current.keys()) if (!recorded.has(f)) problems.push(`not in the manifest: ${f}`);
if (problems.length) {
  console.error(`the normative files differ from MANIFEST.sha256:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`MANIFEST.sha256 matches: ${recorded.size} normative files`);
