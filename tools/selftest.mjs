#!/usr/bin/env node
// Asserts the behaviour the example is meant to demonstrate, written by hand from the spec rather than
// copied from the reference output, so a change in the reference implementation that breaks the spec
// is caught here. Also checks that expected/ is what the current tools produce.
//
//   node tools/selftest.mjs

import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { readReview, fold, evaluate, loadContent, hashLines, resolveMark, locate, addInterval, subtractInterval, trim, trimEnd, linesOfBlob, appendMissing, mergeRepoFile, GITIGNORE_LINES, GITATTRIBUTES_LINES } from "./lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ids = JSON.parse(readFileSync(join(root, "examples", "ids.json"), "utf8"));
const content = loadContent(join(root, "examples", "content"));
const mainDir = join(root, "examples", "state", "reviews", ids.review);
const edgeDir = join(root, "examples", "state", "reviews", ids.edgeReview);
const expected = (name) => JSON.parse(readFileSync(join(root, "examples", "expected", name), "utf8"));

let passed = 0;
const test = (name, fn) => {
  try {
    fn();
    passed++;
  } catch (e) {
    console.error(`FAIL ${name}\n${e.message}`);
    process.exitCode = 1;
  }
};

// ---- vectors/*.json: the language-neutral vectors for the algorithms --------------------------
// Each file holds hand-written cases (see vectors/README.md). Any implementation can run the same files.
const vector = (name) => JSON.parse(readFileSync(join(root, "vectors", name), "utf8"));
const bytesOf = (parts) =>
  Buffer.concat(
    parts.map((p) => (p.utf8 !== undefined ? Buffer.from(p.utf8, "utf8") : p.hex !== undefined ? Buffer.from(p.hex, "hex") : Buffer.alloc(p.count, Buffer.from(p.fill, "hex")[0]))),
  );

for (const c of vector("lines.json").cases)
  test(`lines: ${c.name}`, () => {
    const got = linesOfBlob(bytesOf(c.bytes));
    if ("lineCount" in c) assert.equal(got?.length, c.lineCount);
    else assert.deepEqual(got, c.lines);
  });
for (const c of vector("hash.json").cases) test(`hash: ${c.name}`, () => assert.equal(hashLines(c.lines), c.sha256));
for (const c of vector("trim.json").cases)
  test(`trim: ${c.name}`, () => {
    assert.equal(trim(c.input), c.trim);
    assert.equal(trimEnd(c.input), c.trimEnd);
  });
for (const c of vector("intervals.json").cases)
  test(`intervals: ${c.name}`, () => assert.deepEqual((c.op === "add" ? addInterval : subtractInterval)(c.list, ...c.range), c.expected));
for (const c of vector("relocate-mark.json").cases)
  test(`mark: ${c.name}`, () => {
    const hash = hashLines(c.original.slice(c.start - 1, c.end));
    assert.deepEqual(resolveMark({ startLine: c.start, endLine: c.end, hash }, c.current), c.expected);
  });
for (const c of vector("locate.json").cases) test(`locate: ${c.name}`, () => assert.deepEqual(locate(c.range, c.file), c.expected));

const repoVectors = vector("repo-files.json");
const REQUIRED = { gitignore: GITIGNORE_LINES, gitattributes: GITATTRIBUTES_LINES };
test("repo files: the vectors and the library agree on the required lines", () => assert.deepEqual(repoVectors.required, REQUIRED));
for (const c of repoVectors.append) test(`repo files (opening): ${c.name}`, () => assert.equal(appendMissing(c.text, REQUIRED[c.file]), c.expected));
for (const c of repoVectors.merge)
  test(`repo files (conflict): ${c.name}`, () => {
    assert.equal(mergeRepoFile(REQUIRED[c.file], c.ours, c.theirs), c.expected);
    if (c.symmetric) assert.equal(mergeRepoFile(REQUIRED[c.file], c.theirs, c.ours), c.expected);
  });

// ---- the main example ------------------------------------------------------------------------
const state = fold(readReview(mainDir));
const evald = evaluate(state, content);
const by = (text) => state.annotations.find((a) => a.body.startsWith(text));
const check = (text) => evald.annotations[by(text).id];

test("main: nothing in the main review is damaged", () => {
  const r = state.report;
  assert.equal(r.duplicates + r.unknown + r.orphans + r.invalidEnvelopes + r.tornTails + r.corruptLines.length, 0);
});
test("main: review rename, retarget and status resolve across two devices", () => {
  assert.equal(state.review.title, "Add calc module (round 2)");
  assert.equal(state.review.status, "done");
  assert.equal(state.review.pin.headSha, JSON.parse(readFileSync(join(root, "examples", "content", "commits.json"), "utf8"))["feature/calc@2"]);
});
test("main: edits, replies and tombstones", () => {
  const div = by("Division by zero");
  assert.ok(div.body.endsWith("Please add a test too."));
  assert.deepEqual(div.replies.map((r) => [r.body, r.deleted]), [["Agreed, will fix.", false], ["Thanks! Please also cover `b = -0`.", false], ["Wrong thread, sorry.", true]]);
  assert.equal(by("Remove the legacy").deleted, true);
  assert.equal(by("Add a doc comment").deleted, false); // removed and restored
});
test("main: status, notes and rule decision", () => {
  assert.deepEqual([by("Why bump").status, by("Why bump").statusNote], ["resolved", "Answered in the PR description."]);
  assert.deepEqual([by("Is `noop`").status, by("Is `noop`").statusNote], ["wontFix", "Kept for API compatibility."]);
  assert.deepEqual(by("Division by zero").ruleDecision, { decision: "applied", targetPath: "AGENTS.md" });
  assert.equal(by("Is this helper").ruleDecision, null);
  assert.equal(by("Is this helper").tags[0], "rule_candidate");
  assert.equal(by("Division by zero").ruleText, "Guard against division by zero in arithmetic helpers.");
});
test("main: a comment may cover one range on each side", () => assert.deepEqual(by("Why bump").anchor.ranges.map((r) => r.side), ["old", "new"]));
test("main: a review-level comment has no path and is current", () => {
  assert.equal(by("Please describe").anchor.path, undefined);
  assert.equal(check("Please describe").state, "current");
});
test("check: moved code is outdated with a suggestion (mul 9-11 -> 11-13)", () => {
  const c = check("Looks fine");
  assert.equal(c.state, "outdated");
  assert.deepEqual(c.suggestion.ranges, [{ side: "new", startLine: 11, endLine: 13 }]);
});
test("check: edited code is outdated with no suggestion (div)", () => assert.deepEqual(check("Division by zero"), { state: "outdated" }));
test("check: both ranges are located independently (old side unchanged, new side moved)", () =>
  assert.deepEqual(check("Why bump").suggestion.ranges, [{ side: "old", startLine: 9, endLine: 9 }, { side: "new", startLine: 20, endLine: 20 }]));
test("check: a file the retarget did not touch stays unchanged", () => assert.equal(check("Nit: link").state, "unchanged"));
test("check: a re-anchored comment is current", () => assert.equal(check("`sub` could").state, "current"));
test("check: an old-side comment on a renamed file keeps working", () => assert.equal(check("Is `noop`").state, "unchanged"));

test("marks: file marks are valid only while the change is the same", () =>
  assert.deepEqual(evald.fileMarks.map((m) => [m.path, m.state]), [["README.md", "valid"], ["assets/logo.bin", "valid"], ["src/calc.ts", "stale"]]));
const region = (path, side) => evald.regions.find((r) => r.path === path && r.side === side);
test("marks: a moved region follows its lines, an unreviewed line splits another", () => {
  const r = region("src/calc.ts", "new");
  // add (1-3 -> 3-5), mul minus its middle line (11 and 13), the division re-reviewed on round two (15-18), VERSION (-> 20)
  assert.deepEqual(r.reviewed, [[3, 5], [11, 11], [13, 13], [15, 18], [20, 20]]);
});
test("marks: edited and ambiguous regions are stale, not guessed", () => {
  const r = region("src/calc.ts", "new");
  assert.deepEqual(r.stale.map((s) => [s.startLine, s.endLine]), [[8, 8], [13, 15]]);
});
test("marks: an old-side region is evaluated against the old side", () => assert.deepEqual(region("src/calc.ts", "old").reviewed, [[9, 9]]));
test("marks: an untouched file keeps its region", () => assert.deepEqual(region("src/util.ts", "new").reviewed, [[1, 3]]));

// ---- the edge-case review --------------------------------------------------------------------
const edge = fold(readReview(edgeDir));
test("edge: every kind of damage is counted, none aborts the read", () => {
  const r = edge.report;
  assert.equal(r.duplicates, 1);
  assert.equal(r.unknown, 2); // an unknown type and an unknown enum value
  assert.equal(r.orphans, 1);
  assert.equal(r.invalidEnvelopes, 1);
  assert.equal(r.tornTails, 1);
  assert.equal(r.corruptLines.length, 1);
});
test("edge: an edit with an earlier timestamp than its creation still applies; a repeated creation applies as a later edit", () => {
  const x = edge.annotations.find((a) => a.id === "x-annotation");
  assert.equal(x.body, "re-imported"); // created "first", edited at ts 500 ("edited"), re-created at ts 3000
  assert.equal(x.kind, "question");
  assert.equal(x.status, "resolved"); // the unknown "blocked" status was ignored
  assert.equal(x.replies[0].body, "a reply, edited"); // the unknown field did not stop the edit
});
test("edge: a damaged line does not hide the events after it", () => {
  const y = edge.annotations.find((a) => a.id === "y-annotation");
  assert.equal(y.replies[0].body, "survives the damaged line");
});

// ---- expected/ is current --------------------------------------------------------------------
test("expected/main.json matches the reference implementation", () => assert.deepEqual(expected("main.json"), JSON.parse(JSON.stringify({ review: ids.review, fold: state, evaluated: evald }))));
test("expected/edge-cases.json matches the reference implementation", () => assert.deepEqual(expected("edge-cases.json"), JSON.parse(JSON.stringify({ review: ids.edgeReview, fold: edge }))));
test("every file in examples/state/reviews is a review the tests know about", () => {
  assert.deepEqual(readdirSync(join(root, "examples", "state", "reviews")).sort(), [ids.edgeReview, ids.review].sort());
});
test("the normative files match MANIFEST.sha256 (a change to them must be deliberate: CHANGE_CONTROL.md)", () => {
  execFileSync("node", [join(root, "tools", "manifest.mjs")], { stdio: ["ignore", "pipe", "pipe"] });
});

console.log(`${passed} checks passed${process.exitCode ? ", with failures" : ""}`);
