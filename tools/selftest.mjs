#!/usr/bin/env node
// Asserts the behaviour the example is meant to demonstrate, written by hand from the spec rather than
// copied from the reference output, so a change in the reference implementation that breaks the spec
// is caught here. Also checks that expected/ is what the current tools produce.
//
//   node tools/selftest.mjs

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { readReview, fold, evaluate, loadContent, splitLines, hashLines, resolveMark, locate, addInterval, subtractInterval, trim, trimEnd, linesOfBlob, appendMissing, mergeRepoFile, GITIGNORE_LINES, GITATTRIBUTES_LINES } from "./lib.mjs";

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

// ---- the line model -------------------------------------------------------------------------
test("lines: a trailing newline does not start another line", () => assert.deepEqual(splitLines("a\nb\n"), ["a", "b"]));
test("lines: no trailing newline keeps the last line", () => assert.deepEqual(splitLines("a\nb"), ["a", "b"]));
test("lines: one CR before LF is dropped", () => assert.deepEqual(splitLines("a\r\nb\r\n"), ["a", "b"]));
test("lines: empty text has no lines, a lone newline has one empty line", () => {
  assert.deepEqual(splitLines(""), []);
  assert.deepEqual(splitLines("\n"), [""]);
});
test("hash: SHA-256 of each line followed by LF", () =>
  assert.equal(hashLines(["abc"]), "edeaaff3f1774ad2888673770c6d64097e391bc362d7d6fb34982ddf0efd18cb")); // sha256("abc\n")
test("hash: line boundaries matter", () => assert.notEqual(hashLines(["a", "b"]), hashLines(["ab"])));
test("trim: only tab, VT, FF and space count as whitespace", () => {
  assert.equal(trim("\t x \f"), "x");
  assert.equal(trimEnd("x \u00a0"), "x \u00a0"); // NBSP is not whitespace for matching
});

// ---- text files (ALGORITHMS 1.1, 1.3) ---------------------------------------------------------
const B = (s) => Buffer.from(s, "utf8");
test("text: a UTF-8 byte order mark is not part of line 1", () => assert.deepEqual(linesOfBlob(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), B("a\nb\n")])), ["a", "b"]));
test("text: CRLF lines and a missing final newline are text", () => {
  assert.deepEqual(linesOfBlob(B("a\r\nb\r\n")), ["a", "b"]);
  assert.deepEqual(linesOfBlob(B("a\r\nb")), ["a", "b"]);
  assert.deepEqual(linesOfBlob(Buffer.alloc(0)), []);
});
test("text: content that is not well-formed UTF-8 is not text", () => {
  assert.equal(linesOfBlob(Buffer.from([0x61, 0xff, 0x0a])), null); // a stray byte
  assert.equal(linesOfBlob(Buffer.from([0xc0, 0xaf, 0x0a])), null); // overlong encoding of "/"
  assert.equal(linesOfBlob(Buffer.from([0xed, 0xa0, 0x80, 0x0a])), null); // an encoded surrogate
});
test("text: a CR that does not end a CRLF pair is not text, so editors that split on it cannot disagree", () => {
  assert.equal(linesOfBlob(B("a\rb\n")), null);
  assert.equal(linesOfBlob(B("a\r\r\nb\n")), null);
  assert.equal(linesOfBlob(B("a\r")), null);
});
test("text: a NUL in the first 8000 bytes is binary, one later is not looked for", () => {
  assert.equal(linesOfBlob(Buffer.from([0x61, 0x00, 0x0a])), null);
  assert.equal(linesOfBlob(Buffer.concat([Buffer.alloc(8000, 0x61), Buffer.from([0x00, 0x0a])])).length, 1);
});

// ---- repository files (SPEC 2.1, 9.3) --------------------------------------------------------
test("repo files: missing lines are appended, nothing else is touched", () => {
  assert.equal(appendMissing("*.tmp\n", GITIGNORE_LINES), "*.tmp\n*.lock\n/reviews/*/local/\n"); // what plugin 0.1.0 wrote
  assert.equal(appendMissing("build/", GITIGNORE_LINES), "build/\n*.lock\n*.tmp\n/reviews/*/local/\n");
  assert.equal(appendMissing("", GITATTRIBUTES_LINES), "* -text\n*.jsonl merge=union\n");
});
test("repo files: a file that has every line is returned unchanged, whatever else it holds", () => {
  const t = "# mine\r\n*.lock\r\n*.tmp\r\nout/\r\n/reviews/*/local/";
  assert.equal(appendMissing(t, GITIGNORE_LINES), t);
});
const REQ_IGN = GITIGNORE_LINES.join("\n");
test("repo files: a conflict keeps each side's additions together and in order, required lines last, identically on both sides", () => {
  const base = "*.tmp\n";
  const a = "*.tmp\n*.lock\n/reviews/*/local/\nbuild/\n";
  const b = "*.tmp\n*.lock\n/reviews/*/local/\ndist/\n\n";
  const want = `build/\ndist/\n${REQ_IGN}\n`;
  assert.equal(mergeRepoFile(GITIGNORE_LINES, base, a, b), want);
  assert.equal(mergeRepoFile(GITIGNORE_LINES, base, b, a), want);
});
test("repo files: nothing a user wrote can come after, and so override, a required line", () => {
  const base = "* -text\n*.jsonl merge=union\n";
  const ours = `${base}* text=auto eol=crlf\n`;
  const theirs = `${base}*.png binary\n`;
  const merged = mergeRepoFile(GITATTRIBUTES_LINES, base, ours, theirs);
  assert.equal(merged, "* text=auto eol=crlf\n*.png binary\n* -text\n*.jsonl merge=union\n");
  assert.equal(merged, mergeRepoFile(GITATTRIBUTES_LINES, base, theirs, ours));
});
test("repo files: a negation stays after the pattern it re-includes", () => {
  const base = "*.tmp\n";
  const ours = `${base}*.lock\n/reviews/*/local/\nbuild/*\n!build/keep.txt\n`;
  const theirs = `${base}*.lock\n/reviews/*/local/\n`;
  const merged = mergeRepoFile(GITIGNORE_LINES, base, ours, theirs);
  assert.equal(merged, `build/*\n!build/keep.txt\n${REQ_IGN}\n`);
  assert.equal(merged, mergeRepoFile(GITIGNORE_LINES, base, theirs, ours));
});
test("repo files: with no common ancestor (two groups joined) both files are kept, required lines last", () => {
  assert.equal(mergeRepoFile(GITIGNORE_LINES, "", "*.tmp\n", "*.tmp\nout/\n"), `out/\n${REQ_IGN}\n`);
});
test("repo files: a line one side removed and the other kept stays: nothing is lost", () => {
  assert.equal(mergeRepoFile(GITIGNORE_LINES, "x\ny\n", "x\n", "x\ny\n"), `x\ny\n${REQ_IGN}\n`);
});

// ---- intervals ------------------------------------------------------------------------------
test("intervals: touching intervals merge", () => assert.deepEqual(addInterval([[1, 3]], 4, 6), [[1, 6]]));
test("intervals: subtracting the middle splits", () => assert.deepEqual(subtractInterval([[9, 11]], 10, 10), [[9, 9], [11, 11]]));

// ---- relocation of a reviewed region ---------------------------------------------------------
const L = ["a", "b", "c", "d", "e", "f"];
const mark = (s, e, lines = L) => ({ startLine: s, endLine: e, hash: hashLines(lines.slice(s - 1, e)) });
test("mark: same place stays", () => assert.deepEqual(resolveMark(mark(2, 3), L), [2, 3]));
test("mark: moved lines are found when unique", () => assert.deepEqual(resolveMark(mark(2, 3), ["x", "y", ...L]), [4, 5]));
test("mark: edited lines are gone", () => assert.equal(resolveMark(mark(2, 3), ["a", "b", "CHANGED", "d"]), null));
test("mark: a repeated window is ambiguous, not guessed", () => {
  const rep = ["x", "", "y", "", "z"];
  assert.equal(resolveMark(mark(2, 2, rep), ["q", ...rep]), null); // line 2 is no longer blank, and a blank line is now at both 3 and 5
});
test("mark: the original position wins even if the text repeats elsewhere", () => {
  const rep = ["x", "", "y", "", "z"];
  assert.deepEqual(resolveMark(mark(2, 2, rep), rep), [2, 2]);
});
test("mark: a file that no longer has the side resolves to nothing", () => assert.equal(resolveMark(mark(1, 1), null), null));

// ---- locating a comment's code (suggestions) --------------------------------------------------
const snap = (lines, before = [], after = []) => ({ startLine: 5, endLine: 4 + lines.length, snapshot: { lines, before, after } });
test("locate: with equal context, the lower start line wins a distance tie", () => {
  // "x","y" occurs at lines 2-3 and 8-9; the old start is 5, so both are 3 lines away.
  const file = ["k", "x", "y", "k", "k", "k", "k", "x", "y", "k"];
  assert.deepEqual(locate(snap(["x", "y"]), file), [2, 3]);
});
test("locate: with equal context, the nearer one wins", () => {
  const file = ["k", "x", "y", "k", "k", "k", "k", "k", "k", "x", "y"]; // lines 2-3 (3 away) and 10-11 (5 away)
  assert.deepEqual(locate(snap(["x", "y"]), file), [2, 3]);
});
test("locate: whitespace-only differences still match (second pass)", () => assert.deepEqual(locate(snap(["  x", "y"]), ["a", "x", "y"]), [2, 3]));
test("locate: matching context beats distance", () => {
  // "x" at line 2 has both neighbours right (score 2, 6 lines from the old line 8); at line 10 only one (score 1, 2 lines away).
  const file = ["p", "x", "q", "r", "r", "r", "r", "r", "w", "x", "q"];
  const r = { startLine: 8, endLine: 8, snapshot: { lines: ["x"], before: ["p"], after: ["q"] } };
  assert.deepEqual(locate(r, file), [2, 2]);
});
test("locate: fuzzy matching needs at least 3 lines and 70% of them equal", () => {
  assert.equal(locate(snap(["a", "b"]), ["a", "X"]), null); // 2 lines: no fuzzy pass
  assert.equal(locate(snap(["a", "b", "c"]), ["a", "b", "X"]), null); // 2 of 3 = 67%
  assert.deepEqual(locate(snap(["a", "b", "c", "d"]), ["a", "b", "c", "X"]), [1, 4]); // 3 of 4 = 75%
});
test("locate: nothing similar gives no suggestion", () => assert.equal(locate(snap(["a", "b", "c"]), ["x", "y", "z"]), null));

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

console.log(`${passed} checks passed${process.exitCode ? ", with failures" : ""}`);
