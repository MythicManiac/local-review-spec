// Checks that git actually honours the required repository rules (SPEC 2.1, "Effective rules"), and
// repairs the ones it does not. Git applies the LAST matching line of a file, so a required line that is
// present can still be overridden by a later one; asking git is the only reliable test.
//
// Needs git on PATH. Used by the sync experiment; a tool implements the same probes with its own git calls.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PROBE_JSONL = "reviews/probe/events/probe.jsonl";

/** Each required line, and how to tell that git honours it. Paths need not exist. */
export const PROBES = [
  { file: ".gitattributes", line: "* -text", attr: "text", expect: "unset", path: PROBE_JSONL },
  { file: ".gitattributes", line: "*.jsonl merge=union", attr: "merge", expect: "union", path: PROBE_JSONL },
  { file: ".gitignore", line: "*.lock", ignored: "reviews/probe/events/probe-device.lock" },
  { file: ".gitignore", line: "*.tmp", ignored: "reviews/probe/review.json.tmp" },
  { file: ".gitignore", line: "/reviews/*/local/", ignored: "reviews/probe/local/probe-device/position.json" },
];

const run = (dir, args) =>
  execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });

function honoured(dir, p) {
  if (p.attr) {
    const out = run(dir, ["check-attr", p.attr, "--", p.path]).trim();
    return out.endsWith(`: ${p.attr}: ${p.expect}`);
  }
  try {
    run(dir, ["check-ignore", "-q", "--", p.ignored]);
    return true;
  } catch (e) {
    if (e.status === 1) return false; // not ignored
    throw e;
  }
}

/** The probes git does not honour in the working tree of `dir`. */
export function ineffective(dir) {
  return PROBES.filter((p) => !honoured(dir, p));
}

/**
 * Appends, at the end of the right file, every required line git does not honour (a missing line, or a
 * present one that a later line overrides), then checks again. Never removes or rewrites a line. Lines still
 * ineffective afterwards (for example overridden from .git/info/attributes, which a tool must not touch)
 * are returned in `remaining` so the caller can warn.
 */
export function repair(dir) {
  const failing = ineffective(dir);
  for (const file of [".gitattributes", ".gitignore"]) {
    const lines = failing.filter((p) => p.file === file).map((p) => p.line);
    if (lines.length === 0) continue;
    const path = join(dir, file);
    const text = existsSync(path) ? readFileSync(path, "utf8") : "";
    const base = text === "" || text.endsWith("\n") ? text : `${text}\n`;
    writeFileSync(path, `${base}${lines.join("\n")}\n`);
  }
  return { appended: failing.map((p) => p.line), remaining: ineffective(dir).map((p) => p.line) };
}
