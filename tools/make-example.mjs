#!/usr/bin/env node
// Generates the reference example in examples/state (a group folder with two reviews) from the fixture
// repository in examples/content, then folds it with the reference implementation and writes
// examples/expected/. Everything is deterministic, so running it again changes nothing.
//
//   node tools/make-fixture.mjs     (once; builds examples/content)
//   node tools/make-example.mjs
//
// The example plays two writers against one review: an "app" device and a "plugin" device. Their
// event files are interleaved in time, as they would be after both synced through one remote.

import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { splitLines, hashLines, changeKey, loadContent, readReview, fold, evaluate } from "./lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const stateDir = join(root, "examples", "state");
const contentDir = join(root, "examples", "content");
const expectedDir = join(root, "examples", "expected");
const content = loadContent(contentDir);
const commits = JSON.parse(readFileSync(join(contentDir, "commits.json"), "utf8"));

// ---- ids and time --------------------------------------------------------------------------
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function ulid(ts, seed) {
  let t = ts;
  let head = "";
  for (let i = 0; i < 10; i++) {
    head = B32[t % 32] + head;
    t = Math.floor(t / 32);
  }
  const h = createHash("sha256").update(`${ts}:${seed}`).digest();
  let tail = "";
  for (let i = 0; i < 16; i++) tail += B32[h[i] % 32];
  return head + tail;
}
const T0 = Date.UTC(2026, 9, 14, 14, 0, 0);
const DAY = 86_400_000;
const GROUP_ID = ulid(T0 - 60 * DAY, "group");
const APP = ulid(T0 - 30 * DAY, "device-app");
const PLUGIN = ulid(T0 - 20 * DAY, "device-plugin");
const REVIEW_ID = ulid(T0, "review");

class Writer {
  constructor(dev) {
    this.dev = dev;
    this.seq = 0;
    this.last = 0;
    this.lines = [];
  }
  /** Appends one event `sec` seconds after T0 (or just after this device's previous event). Returns its ts. */
  emit(sec, ev) {
    const ts = Math.max(this.last + 1, T0 + sec * 1000);
    this.last = ts;
    this.seq += 1;
    const id = ulid(ts, `${this.dev}:${this.seq}`);
    this.lines.push(JSON.stringify({ v: 1, id, ts, dev: this.dev, seq: this.seq, ev }));
    return { ts, id };
  }
}

// ---- contents ------------------------------------------------------------------------------
const P1 = { baseSha: commits.master, baseTipSha: commits.master, headSha: commits["feature/calc@1"] };
const P2 = { baseSha: commits.master, baseTipSha: commits.master, headSha: commits["feature/calc@2"] };
const key = (p) => `${p.baseSha}..${p.headSha}`;
const fileAt = (pin, path) => content.changesets[key(pin)].find((f) => f.path === path);
const linesAt = (pin, path, side) => {
  const f = fileAt(pin, path);
  const blob = side === "new" ? f.newBlob : f.oldBlob;
  return { blob, lines: splitLines(content.readBlob(blob).toString("utf8")) };
};
/** A comment range with the code it is about and 3 lines of context each side. */
function anchorRange(pin, path, side, start, end) {
  const { lines } = linesAt(pin, path, side);
  return {
    side,
    startLine: start,
    endLine: end,
    snapshot: {
      lines: lines.slice(start - 1, end),
      before: lines.slice(Math.max(0, start - 1 - 3), start - 1),
      after: lines.slice(end, end + 3),
    },
  };
}
/** A reviewed-region range: the blob its line numbers apply to, and a hash of its lines. */
function markRange(pin, path, side, start, end) {
  const { blob, lines } = linesAt(pin, path, side);
  return { side, startLine: start, endLine: end, blob, hash: hashLines(lines.slice(start - 1, end)) };
}
const linesAnchor = (pin, path, ranges, oldPath) => ({ scope: "lines", path, ...(oldPath ? { oldPath } : {}), pin, ranges });

// ---- the main review -----------------------------------------------------------------------
const app = new Writer(APP);
const plugin = new Writer(PLUGIN);
const aid = (name) => ulid(T0 + 1, `annotation:${name}`);
const rid = (name) => ulid(T0 + 2, `reply:${name}`);
const CALC = "src/calc.ts";

const ids = Object.fromEntries(["div", "mul", "ver", "readme", "extra", "review", "util", "sub", "gone", "kept"].map((n) => [n, aid(n)]));

app.emit(60, { type: "annotationCreated", annotationId: ids.div, kind: "changeRequest", tags: ["rule_candidate"], body: "Division by zero is not handled. `div` should reject `b === 0`.", ruleText: "Guard against division by zero in arithmetic helpers.", anchor: linesAnchor(P1, CALC, [anchorRange(P1, CALC, "new", 13, 15)]) });
app.emit(70, { type: "annotationCreated", annotationId: ids.mul, kind: "comment", tags: [], body: "Looks fine.", anchor: linesAnchor(P1, CALC, [anchorRange(P1, CALC, "new", 9, 11)]) });
plugin.emit(80, { type: "annotationCreated", annotationId: ids.ver, kind: "question", tags: [], body: "Why bump the minor version? Is this a breaking change?", anchor: linesAnchor(P1, CALC, [anchorRange(P1, CALC, "old", 9, 9), anchorRange(P1, CALC, "new", 17, 17)]) });
app.emit(90, { type: "annotationCreated", annotationId: ids.readme, kind: "comment", tags: [], body: "Nit: link the docs page.", anchor: linesAnchor(P1, "README.md", [anchorRange(P1, "README.md", "new", 3, 4)]) });
plugin.emit(100, { type: "annotationCreated", annotationId: ids.extra, kind: "comment", tags: ["rule_candidate"], body: "Is this helper used anywhere?", anchor: { scope: "file", path: "src/extra.ts", pin: P1 } });
plugin.emit(110, { type: "annotationCreated", annotationId: ids.review, kind: "question", tags: [], body: "Please describe how to run the demo in the PR body.", anchor: { scope: "review" } });
app.emit(120, { type: "annotationCreated", annotationId: ids.util, kind: "comment", tags: [], body: "Is `noop` still needed?", anchor: linesAnchor(P1, "src/util.ts", [anchorRange(P1, "src/util.ts", "old", 5, 5)], "src/util_old.ts") });
app.emit(130, { type: "annotationCreated", annotationId: ids.sub, kind: "comment", tags: [], body: "`sub` could reuse `add` with a negated operand.", anchor: linesAnchor(P1, CALC, [anchorRange(P1, CALC, "new", 5, 7)]) });
plugin.emit(140, { type: "annotationCreated", annotationId: ids.gone, kind: "changeRequest", tags: [], body: "Remove the legacy flag.", anchor: linesAnchor(P1, "src/legacy.ts", [anchorRange(P1, "src/legacy.ts", "old", 1, 1)]) });
app.emit(150, { type: "annotationCreated", annotationId: ids.kept, kind: "comment", tags: [], body: "Add a doc comment.", anchor: linesAnchor(P1, CALC, [anchorRange(P1, CALC, "new", 1, 3)]) });

// Conversation on the division comment, an edit, and a reply that was written and then removed.
plugin.emit(300, { type: "annotationEdited", annotationId: ids.div, body: "Division by zero is not handled. `div` should reject `b === 0`. Please add a test too." });
plugin.emit(400, { type: "replyAdded", annotationId: ids.div, replyId: rid("agree"), body: "Agreed, will fix." });
app.emit(420, { type: "replyAdded", annotationId: ids.div, replyId: rid("negzero"), body: "Thanks. Please also cover `b = -0`." });
app.emit(430, { type: "replyEdited", annotationId: ids.div, replyId: rid("negzero"), body: "Thanks! Please also cover `b = -0`." });
plugin.emit(440, { type: "replyAdded", annotationId: ids.div, replyId: rid("oops"), body: "Wrong thread, sorry." });
plugin.emit(450, { type: "replyDeleted", annotationId: ids.div, replyId: rid("oops") });

// Status: resolved with a note, and won't fix with a note.
app.emit(500, { type: "annotationStatusChanged", annotationId: ids.ver, status: "resolved", note: "Answered in the PR description." });
plugin.emit(600, { type: "annotationStatusChanged", annotationId: ids.util, status: "wontFix", note: "Kept for API compatibility." });

// Tombstones: one stays removed, one is removed and brought back.
plugin.emit(700, { type: "annotationDeleted", annotationId: ids.gone });
app.emit(710, { type: "annotationDeleted", annotationId: ids.kept });
app.emit(720, { type: "annotationRestored", annotationId: ids.kept });

// Reviewed regions, all against round one (P1).
app.emit(1000, { type: "regionReviewed", path: CALC, ranges: [markRange(P1, CALC, "new", 1, 3)] });
app.emit(1010, { type: "regionReviewed", path: CALC, ranges: [markRange(P1, CALC, "new", 9, 11)] });
app.emit(1020, { type: "regionUnreviewed", path: CALC, ranges: [markRange(P1, CALC, "new", 10, 10)] });
app.emit(1030, { type: "regionReviewed", path: CALC, ranges: [markRange(P1, CALC, "new", 13, 15)] });
app.emit(1040, { type: "regionReviewed", path: CALC, ranges: [markRange(P1, CALC, "new", 17, 17)] });
plugin.emit(1050, { type: "regionReviewed", path: CALC, ranges: [markRange(P1, CALC, "new", 8, 8)] }); // a blank line: it occurs many times, so it cannot be relocated
plugin.emit(1060, { type: "regionReviewed", path: CALC, ranges: [markRange(P1, CALC, "old", 9, 9), markRange(P1, CALC, "new", 17, 17)] });
app.emit(1070, { type: "regionReviewed", path: "src/util.ts", ranges: [markRange(P1, "src/util.ts", "new", 1, 3)] });

// File marks, including one that was cleared and one that was cleared and set again.
const keyOf = (path) => changeKey(fileAt(P1, path));
app.emit(1100, { type: "fileReviewed", path: "README.md", changeKey: keyOf("README.md") });
app.emit(1110, { type: "fileReviewed", path: CALC, changeKey: keyOf(CALC) });
plugin.emit(1120, { type: "fileReviewed", path: "assets/logo.bin", changeKey: keyOf("assets/logo.bin") });
app.emit(1130, { type: "fileReviewed", path: "src/legacy.ts", changeKey: keyOf("src/legacy.ts") });
plugin.emit(1140, { type: "fileUnreviewed", path: "src/legacy.ts" });
app.emit(1150, { type: "fileUnreviewed", path: "README.md" });
app.emit(1160, { type: "fileReviewed", path: "README.md", changeKey: keyOf("README.md") });

// The branch moves: the review is retargeted to round two.
app.emit(2500, { type: "reviewRetargeted", pin: P2 });
plugin.emit(2000, { type: "ruleDecided", annotationIds: [ids.div], targetPath: "AGENTS.md", decision: "applied" });

// After the retarget: a comment is moved by accepting the suggested position; the division is reviewed again.
{
  const range = anchorRange(P2, CALC, "new", 7, 9);
  app.emit(3000, { type: "annotationReanchored", annotationId: ids.sub, method: "suggestion", anchor: linesAnchor(P2, CALC, [range]) });
}
app.emit(3100, { type: "regionReviewed", path: CALC, ranges: [markRange(P2, CALC, "new", 15, 18)] });

// Review level: rename, and a status that changes hands.
app.emit(3400, { type: "reviewRenamed", title: "Add calc module (round 2)" });
app.emit(3500, { type: "reviewStatusChanged", status: "done" });
plugin.emit(3600, { type: "reviewStatusChanged", status: "open" });
app.emit(3700, { type: "reviewStatusChanged", status: "done" });

// ---- the edge-case review: log mechanics only ----------------------------------------------
const EDGE_ID = "20261014-1530-edge-cases";
const EA = ulid(T0 - 10 * DAY, "edge-a");
const EB = ulid(T0 - 9 * DAY, "edge-b");
const EC = ulid(T0 - 8 * DAY, "edge-c");
const fake = (c) => c.repeat(40);
const EPIN = { baseSha: fake("1"), baseTipSha: fake("1"), headSha: fake("2") };
const env = (dev, seq, ts, id, ev) => JSON.stringify({ v: 1, id, ts, dev, seq, ev });
const E0 = T0;
const X = "x-annotation";
const Y = "y-annotation";
const dupLine = env(EA, 3, E0 + 1200, "dup-0000000001", { type: "annotationStatusChanged", annotationId: X, status: "resolved", note: "done" });
const edgeA = [
  env(EA, 1, E0 + 1000, "ea-0001", { type: "annotationCreated", annotationId: X, kind: "comment", tags: [], body: "first", anchor: { scope: "file", path: "a.txt", pin: EPIN } }),
  env(EA, 2, E0 + 1100, "ea-0002", { type: "replyAdded", annotationId: X, replyId: "r-1", body: "a reply" }),
  dupLine,
];
const edgeB = [
  dupLine, // the same event arrives through a second file (a merged or copied log)
  // Written on a clock that ran behind: it carries an earlier timestamp than the creation it edits.
  env(EB, 1, E0 + 500, "eb-0001", { type: "annotationEdited", annotationId: X, body: "edited" }),
  env(EB, 2, E0 + 1500, "eb-0002", { type: "annotationPinned", annotationId: X }), // a type this reader does not know
  env(EB, 3, E0 + 1600, "eb-0003", { type: "replyEdited", annotationId: X, replyId: "r-1", body: "a reply, edited", futureField: { nested: true } }), // an unknown field is ignored
  env(EB, 4, E0 + 2000, "eb-0004", { type: "annotationStatusChanged", annotationId: X, status: "blocked" }), // an unknown enum value: the whole event is ignored
  env(EB, 5, E0 + 2100, "eb-0005", { type: "draftSaved", key: "k", draft: { text: "unsent" } }), // written by older tools; no meaning here
  env(EB, 6, E0 + 2200, "eb-0006", { type: "positionSaved", path: "a.txt", line: 3 }),
  env(EB, 7, E0 + 2300, "eb-0007", { type: "hunkReviewed", path: "a.txt", hunkHash: "abc" }),
  env(EB, 8, E0 + 2400, "eb-0008", { type: "annotationDeleted", annotationId: "no-such-annotation" }), // targets something that does not exist
  // The same annotation created again later (re-imported): applies as an edit, in order.
  env(EB, 9, E0 + 3000, "eb-0009", { type: "annotationCreated", annotationId: X, kind: "question", tags: ["rule_candidate"], body: "re-imported", ruleText: "Keep imports idempotent.", anchor: { scope: "file", path: "a.txt", pin: EPIN } }),
];
const edgeC = [
  env(EC, 1, E0 + 1700, "ec-0001", { type: "annotationCreated", annotationId: Y, kind: "changeRequest", tags: [], body: "second thread", anchor: { scope: "review" } }),
  '{"v":1,"id":"ec-0002","ts":', // damaged in the middle of the file
  env(EC, 3, E0 + 1800, "ec-0003", { type: "replyAdded", annotationId: Y, replyId: "r-2", body: "survives the damaged line" }),
  '{"hello":"world"}', // valid JSON, not an event envelope
];
const edgeCTorn = '{"v":1,"id":"ec-0005","ts":1791993' + "6"; // the last line was cut off by a crash: no newline, not valid JSON

// ---- write ---------------------------------------------------------------------------------
const GITATTRIBUTES = "* -text\n*.jsonl merge=union\n";
const GITIGNORE = "*.lock\n*.tmp\n/reviews/*/local/\n";
const put = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
rmSync(stateDir, { recursive: true, force: true });
put(join(stateDir, "group.json"), JSON.stringify({ schemaVersion: 2, id: GROUP_ID, name: "Example Group", createdAt: T0 - 60 * DAY }, null, 2) + "\n");
put(join(stateDir, ".gitattributes"), GITATTRIBUTES);
put(join(stateDir, ".gitignore"), GITIGNORE);

const review = join(stateDir, "reviews", REVIEW_ID);
put(
  join(review, "review.json"),
  JSON.stringify(
    {
      schemaVersion: 2,
      id: REVIEW_ID,
      title: "Add calc module",
      createdAt: T0,
      createdBy: APP,
      repo: { displayName: "calc-demo", originUrl: "https://example.com/acme/calc-demo.git", rootCommit: commits.master },
      baseRef: "master",
      headRef: "feature/calc",
      mode: "mergeBase",
      pin: P1,
    },
    null,
    2,
  ) + "\n",
);
put(join(review, "events", `${APP}.jsonl`), app.lines.join("\n") + "\n");
put(join(review, "events", `${PLUGIN}.jsonl`), plugin.lines.join("\n") + "\n");

const edge = join(stateDir, "reviews", EDGE_ID);
put(
  join(edge, "review.json"),
  JSON.stringify(
    {
      schemaVersion: 2,
      id: EDGE_ID,
      title: "Edge cases of the event logs",
      createdAt: T0 - 10 * DAY,
      createdBy: EA,
      repo: { displayName: "edge-demo", originUrl: null, rootCommit: null },
      baseRef: "main",
      headRef: "topic",
      mode: "direct",
      pin: EPIN,
    },
    null,
    2,
  ) + "\n",
);
put(join(edge, "events", `${EA}.jsonl`), edgeA.join("\n") + "\n");
put(join(edge, "events", `${EB}.jsonl`), edgeB.join("\r\n") + "\r\n"); // CRLF on purpose
put(join(edge, "events", `${EC}.jsonl`), edgeC.join("\n") + "\n" + edgeCTorn); // no final newline on purpose

// ---- fold and write the expected results ---------------------------------------------------
rmSync(expectedDir, { recursive: true, force: true });
const mainState = fold(readReview(review));
put(join(expectedDir, "main.json"), JSON.stringify({ review: REVIEW_ID, fold: mainState, evaluated: evaluate(mainState, content) }, null, 2) + "\n");
put(join(expectedDir, "edge-cases.json"), JSON.stringify({ review: EDGE_ID, fold: fold(readReview(edge)) }, null, 2) + "\n");

writeFileSync(join(root, "examples", "ids.json"), JSON.stringify({ group: GROUP_ID, appDevice: APP, pluginDevice: PLUGIN, review: REVIEW_ID, annotations: ids, edgeReview: EDGE_ID }, null, 2) + "\n");
console.log(`wrote ${stateDir}\n  main review ${REVIEW_ID}\n  edge review ${EDGE_ID}`);
