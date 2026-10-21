// Reference implementation of the Local Review state format (see SPEC.md and ALGORITHMS.md).
//
// It exists to make the spec executable: it reads a review folder, folds the event logs into the
// reference state, and (given file contents) evaluates region marks, file marks and comment anchors
// against the review's current pin. It favours clarity over speed. No dependencies.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------------------------

export const KINDS = ["changeRequest", "question", "comment"];
export const ANNOTATION_STATUSES = ["open", "resolved", "wontFix"];
export const REVIEW_STATUSES = ["open", "done", "archived"];
export const SIDES = ["old", "new"];
export const DECISIONS = ["applied", "dismissed"];
export const RULE_CANDIDATE_TAG = "rule_candidate";

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const HASH = /^[0-9a-f]{64}$/;
const isInt = (n) => Number.isInteger(n);
const isStr = (s) => typeof s === "string";
const isObj = (o) => o !== null && typeof o === "object" && !Array.isArray(o);
const strArray = (a) => Array.isArray(a) && a.every(isStr);

// ---------------------------------------------------------------------------------------------
// Line model and hashing (ALGORITHMS.md section 1)
// ---------------------------------------------------------------------------------------------

/** Splits text into lines: on LF, dropping one trailing CR per line; a final LF ends the last line. */
export function splitLines(text) {
  if (text === "") return [];
  const parts = text.split("\n");
  if (text.endsWith("\n")) parts.pop();
  return parts.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}

/** SHA-256 over the lines, each followed by LF, as lowercase hex. */
export function hashLines(lines) {
  const h = createHash("sha256");
  for (const l of lines) {
    h.update(l, "utf8");
    h.update("\n");
  }
  return h.digest("hex");
}

const SPACE = new Set(["\t", "\v", "\f", " "]);
export function trimEnd(s) {
  let e = s.length;
  while (e > 0 && SPACE.has(s[e - 1])) e--;
  return s.slice(0, e);
}
export function trim(s) {
  let b = 0;
  while (b < s.length && SPACE.has(s[b])) b++;
  return trimEnd(s.slice(b));
}

const UTF8_STRICT = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }); // keeps a BOM so the rule below can drop it

/**
 * The lines of a blob (ALGORITHMS 1.1, 1.3), or null if the blob is not text: a NUL in the first 8000 bytes,
 * content that is not well-formed UTF-8, or a CR that is not directly followed by LF. A leading UTF-8 byte
 * order mark is not part of line 1.
 */
export function linesOfBlob(bytes) {
  if (bytes.subarray(0, 8000).includes(0)) return null;
  let text;
  try {
    text = UTF8_STRICT.decode(bytes);
  } catch {
    return null;
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  for (let i = text.indexOf("\r"); i !== -1; i = text.indexOf("\r", i + 1)) if (text[i + 1] !== "\n") return null;
  return splitLines(text);
}

// ---------------------------------------------------------------------------------------------
// Repository files (SPEC.md sections 2.1 and 9.3)
// ---------------------------------------------------------------------------------------------

export const GITATTRIBUTES_LINES = ["* -text", "*.jsonl merge=union"];
export const GITIGNORE_LINES = ["*.lock", "*.tmp", "/reviews/*/local/"];

const repoFileLines = (text) => text.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));

/**
 * Opening a group (SPEC 2.1): the file with every required line that is missing appended, in the order given.
 * Existing content is never changed; an unchanged text is returned as it is. A missing file is "".
 */
export function appendMissing(text, required) {
  const have = new Set(repoFileLines(text));
  const missing = required.filter((r) => !have.has(r));
  if (missing.length === 0) return text;
  const base = text === "" || text.endsWith("\n") ? text : `${text}\n`;
  return `${base}${missing.join("\n")}\n`;
}

/**
 * A merge conflict in .gitignore or .gitattributes (SPEC 9.3). `base` is the common ancestor's text ("" when
 * there is none, as when two groups are joined). Git applies the LAST matching line, so order matters:
 *
 *   1. the lines of the base, in their order;
 *   2. what each side added, each side's lines kept together and in the order that side wrote them, the
 *      two blocks ordered by their UTF-8 bytes (so the result does not depend on which side is "ours");
 *   3. the required lines, last, in their order, so that nothing anyone wrote can override them.
 *
 * Blank lines and duplicates are dropped (the first occurrence stays). A line that one side removed and the
 * other kept stays: nothing is lost. Both devices write the same bytes.
 */
export function mergeRepoFile(required, base, ours, theirs) {
  const clean = (t) => repoFileLines(t).filter((l) => l !== "");
  const baseLines = clean(base);
  const inBase = new Set(baseLines);
  const added = (t) => [...new Set(clean(t).filter((l) => !inBase.has(l)))];
  const bytes = (block) => Buffer.from(block.join("\n"), "utf8");
  const blocks = [added(ours), added(theirs)].filter((b) => b.length > 0).sort((x, y) => Buffer.compare(bytes(x), bytes(y)));
  const emitted = new Set(required); // the required lines go last, wherever they were before
  const out = [];
  for (const l of [...baseLines, ...blocks.flat()]) {
    if (emitted.has(l)) continue;
    emitted.add(l);
    out.push(l);
  }
  return `${[...out, ...required].join("\n")}\n`;
}

// ---------------------------------------------------------------------------------------------
// Validation of events (SPEC.md section 6)
// ---------------------------------------------------------------------------------------------

function validPin(p) {
  return isObj(p) && SHA.test(p.baseSha ?? "") && SHA.test(p.baseTipSha ?? "") && SHA.test(p.headSha ?? "");
}

function validLineSpan(r) {
  return isObj(r) && SIDES.includes(r.side) && isInt(r.startLine) && isInt(r.endLine) && r.startLine >= 1 && r.endLine >= r.startLine;
}

function distinctSides(ranges) {
  return new Set(ranges.map((r) => r.side)).size === ranges.length;
}

function validSnapshot(s) {
  return isObj(s) && strArray(s.lines) && strArray(s.before) && strArray(s.after);
}

/** Returns the anchor in its normalized form, or null if it is not a valid anchor. */
export function normalizeAnchor(a) {
  if (!isObj(a)) return null;
  if (a.scope === "review") return { scope: "review" };
  if (a.scope === "file") {
    if (!isStr(a.path) || a.path === "" || !validPin(a.pin)) return null;
    const out = { scope: "file", path: a.path, pin: a.pin };
    if (isStr(a.oldPath)) out.oldPath = a.oldPath;
    return out;
  }
  if (a.scope === "lines") {
    if (!isStr(a.path) || a.path === "" || !validPin(a.pin)) return null;
    if (!Array.isArray(a.ranges) || a.ranges.length < 1 || a.ranges.length > 2) return null;
    if (!a.ranges.every((r) => validLineSpan(r) && validSnapshot(r.snapshot))) return null;
    if (!distinctSides(a.ranges)) return null;
    const out = { scope: "lines", path: a.path, pin: a.pin, ranges: a.ranges.map((r) => ({ side: r.side, startLine: r.startLine, endLine: r.endLine, snapshot: { lines: r.snapshot.lines, before: r.snapshot.before, after: r.snapshot.after } })) };
    if (isStr(a.oldPath)) out.oldPath = a.oldPath;
    return out;
  }
  return null;
}

function validMarkRanges(ranges) {
  return (
    Array.isArray(ranges) &&
    ranges.length >= 1 &&
    ranges.length <= 2 &&
    ranges.every((r) => validLineSpan(r) && isStr(r.blob) && r.blob !== "" && HASH.test(r.hash ?? "")) &&
    distinctSides(ranges)
  );
}

const hasAnnotation = (e) => ID.test(e.annotationId ?? "");

/** Returns the event with anchors normalized, or null if it is not a valid event of a known type. */
export function validateEvent(e) {
  if (!isObj(e) || !isStr(e.type)) return null;
  switch (e.type) {
    case "reviewRenamed":
      return isStr(e.title) ? e : null;
    case "reviewStatusChanged":
      return REVIEW_STATUSES.includes(e.status) ? e : null;
    case "reviewRetargeted":
      return validPin(e.pin) ? e : null;
    case "annotationCreated": {
      const anchor = normalizeAnchor(e.anchor);
      if (!hasAnnotation(e) || !KINDS.includes(e.kind) || !strArray(e.tags) || !isStr(e.body) || !anchor) return null;
      if (e.ruleText !== undefined && !isStr(e.ruleText)) return null;
      return { ...e, anchor };
    }
    case "annotationEdited":
      if (!hasAnnotation(e)) return null;
      if (e.body !== undefined && !isStr(e.body)) return null;
      if (e.kind !== undefined && !KINDS.includes(e.kind)) return null;
      if (e.tags !== undefined && !strArray(e.tags)) return null;
      if (e.ruleText !== undefined && e.ruleText !== null && !isStr(e.ruleText)) return null;
      return e;
    case "annotationStatusChanged":
      if (!hasAnnotation(e) || !ANNOTATION_STATUSES.includes(e.status)) return null;
      return e.note === undefined || isStr(e.note) ? e : null;
    case "annotationReanchored": {
      const anchor = normalizeAnchor(e.anchor);
      if (!hasAnnotation(e) || !anchor) return null;
      if (e.method !== undefined && !["picked", "suggestion"].includes(e.method)) return null;
      return { ...e, anchor };
    }
    case "annotationDeleted":
    case "annotationRestored":
      return hasAnnotation(e) ? e : null;
    case "replyAdded":
    case "replyEdited":
      return hasAnnotation(e) && ID.test(e.replyId ?? "") && isStr(e.body) ? e : null;
    case "replyDeleted":
    case "replyRestored":
      return hasAnnotation(e) && ID.test(e.replyId ?? "") ? e : null;
    case "fileReviewed":
      return isStr(e.path) && e.path !== "" && isStr(e.changeKey) && e.changeKey !== "" ? e : null;
    case "fileUnreviewed":
      return isStr(e.path) && e.path !== "" ? e : null;
    case "regionReviewed":
    case "regionUnreviewed":
      return isStr(e.path) && e.path !== "" && validMarkRanges(e.ranges) ? e : null;
    case "ruleDecided":
      return Array.isArray(e.annotationIds) && e.annotationIds.every((i) => ID.test(i)) && isStr(e.targetPath) && DECISIONS.includes(e.decision) ? e : null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Reading logs (SPEC.md section 5)
// ---------------------------------------------------------------------------------------------

const emptyReport = () => ({
  events: 0,
  duplicates: 0,
  unknown: 0,
  orphans: 0,
  invalidEnvelopes: 0,
  tornTails: 0,
  corruptLines: [],
});

/** Parses one device log. `name` is only used in the report. Never throws on bad data. */
export function parseLog(name, bytes, report) {
  const text = Buffer.from(bytes).toString("utf8");
  const terminated = text.endsWith("\n");
  const rows = text.split("\n");
  if (terminated) rows.pop();
  const out = [];
  rows.forEach((raw, i) => {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.trim() === "") return;
    let env;
    try {
      env = JSON.parse(line);
    } catch {
      if (i === rows.length - 1 && !terminated) report.tornTails++;
      else report.corruptLines.push({ file: name, line: i + 1 });
      return;
    }
    if (!isObj(env) || !isInt(env.v) || !ID.test(env.id ?? "") || !isInt(env.ts) || !isStr(env.dev) || env.dev === "" || !isInt(env.seq) || !isObj(env.ev) || !isStr(env.ev.type)) {
      report.invalidEnvelopes++;
      return;
    }
    out.push(env);
  });
  return out;
}

export function readReview(dir) {
  const meta = JSON.parse(readFileSync(join(dir, "review.json"), "utf8"));
  const eventsDir = join(dir, "events");
  const files = existsSync(eventsDir) ? readdirSync(eventsDir).filter((f) => f.endsWith(".jsonl")).sort() : [];
  return { meta, logs: files.map((f) => ({ name: f, bytes: readFileSync(join(eventsDir, f)) })) };
}

// ---------------------------------------------------------------------------------------------
// Fold (SPEC.md section 7)
// ---------------------------------------------------------------------------------------------

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
export const byFoldOrder = (a, b) => cmp(a.ts, b.ts) || cmp(a.dev, b.dev) || cmp(a.seq, b.seq) || cmp(a.id, b.id);

export function fold({ meta, logs }) {
  const report = emptyReport();
  const envelopes = logs.flatMap((l) => parseLog(l.name, l.bytes, report));
  envelopes.sort(byFoldOrder);

  // Deduplicate by event id; the first in fold order wins.
  const seen = new Set();
  const typed = [];
  for (const env of envelopes) {
    if (seen.has(env.id)) {
      report.duplicates++;
      continue;
    }
    seen.add(env.id);
    const ev = validateEvent(env.ev);
    if (!ev) {
      report.unknown++;
      continue;
    }
    typed.push({ env, ev });
  }
  report.events = typed.length;

  const state = {
    review: {
      id: meta.id,
      title: meta.title,
      status: "open",
      createdAt: meta.createdAt,
      createdBy: meta.createdBy,
      repo: meta.repo,
      baseRef: meta.baseRef,
      headRef: meta.headRef,
      mode: meta.mode,
      pin: meta.pin,
    },
    annotations: [],
    fileMarks: [],
    regionEvents: [],
    report,
  };
  const byId = new Map();
  const touch = (a, ts) => {
    if (ts > a.updatedAt) a.updatedAt = ts;
  };

  // Phase 1: the first creation of each annotation. A later creation with the same id is not applied
  // here: it acts as an edit at its own place in the order (phase 3), so re-importing is idempotent
  // and still obeys last-writer-wins.
  const creators = new Set();
  for (const { env, ev } of typed) {
    if (ev.type !== "annotationCreated" || byId.has(ev.annotationId)) continue;
    const a = {
      id: ev.annotationId,
      kind: ev.kind,
      tags: [...ev.tags],
      body: ev.body,
      ruleText: ev.ruleText ?? null,
      status: "open",
      statusNote: null,
      deleted: false,
      createdAt: env.ts,
      createdBy: env.dev,
      updatedAt: env.ts,
      anchor: ev.anchor,
      ruleDecision: null,
      replies: [],
    };
    byId.set(a.id, a);
    state.annotations.push(a);
    creators.add(env.id);
  }

  // Phase 2: the first creation of each reply, for the same reason.
  const replyCreators = new Set();
  for (const { env, ev } of typed) {
    if (ev.type !== "replyAdded") continue;
    const a = byId.get(ev.annotationId);
    if (!a) {
      report.orphans++;
      continue;
    }
    if (a.replies.some((r) => r.id === ev.replyId)) continue;
    a.replies.push({ id: ev.replyId, body: ev.body, deleted: false, createdAt: env.ts, createdBy: env.dev, updatedAt: env.ts });
    replyCreators.add(env.id);
    touch(a, env.ts);
  }

  // Phase 3: everything else, in fold order, last writer wins.
  for (const { env, ev } of typed) {
    const t = ev.type;
    if (creators.has(env.id) || replyCreators.has(env.id)) continue;
    if (t === "annotationCreated") {
      const a = byId.get(ev.annotationId);
      a.kind = ev.kind;
      a.tags = [...ev.tags];
      a.body = ev.body;
      a.ruleText = ev.ruleText ?? null;
      a.anchor = ev.anchor;
      touch(a, env.ts);
      continue;
    }
    if (t === "replyAdded") {
      const a = byId.get(ev.annotationId);
      if (!a) continue; // already counted as an orphan in phase 2
      const r = a.replies.find((x) => x.id === ev.replyId);
      r.body = ev.body;
      r.updatedAt = Math.max(r.updatedAt, env.ts);
      touch(a, env.ts);
      continue;
    }
    if (t === "reviewRenamed") state.review.title = ev.title;
    else if (t === "reviewStatusChanged") state.review.status = ev.status;
    else if (t === "reviewRetargeted") state.review.pin = ev.pin;
    else if (t === "fileReviewed") {
      const m = state.fileMarks.find((x) => x.path === ev.path);
      if (m) m.changeKey = ev.changeKey;
      else state.fileMarks.push({ path: ev.path, changeKey: ev.changeKey });
    } else if (t === "fileUnreviewed") {
      state.fileMarks = state.fileMarks.filter((x) => x.path !== ev.path);
    } else if (t === "regionReviewed" || t === "regionUnreviewed") {
      state.regionEvents.push({ id: env.id, ts: env.ts, dev: env.dev, seq: env.seq, type: t === "regionReviewed" ? "reviewed" : "unreviewed", path: ev.path, ranges: ev.ranges });
    } else if (t === "ruleDecided") {
      for (const id of ev.annotationIds) {
        const a = byId.get(id);
        if (!a) {
          report.orphans++;
          continue;
        }
        a.ruleDecision = { decision: ev.decision, targetPath: ev.targetPath };
        touch(a, env.ts);
      }
    } else {
      // Everything left addresses one annotation (and maybe one reply).
      const a = byId.get(ev.annotationId);
      if (!a) {
        report.orphans++;
        continue;
      }
      if (t === "annotationEdited") {
        if (ev.body !== undefined) a.body = ev.body;
        if (ev.kind !== undefined) a.kind = ev.kind;
        if (ev.tags !== undefined) a.tags = [...ev.tags];
        if (ev.ruleText !== undefined) a.ruleText = ev.ruleText;
      } else if (t === "annotationStatusChanged") {
        a.status = ev.status;
        a.statusNote = ev.note ?? null;
      } else if (t === "annotationReanchored") a.anchor = ev.anchor;
      else if (t === "annotationDeleted") a.deleted = true;
      else if (t === "annotationRestored") a.deleted = false;
      else {
        const r = a.replies.find((x) => x.id === ev.replyId);
        if (!r) {
          report.orphans++;
          continue;
        }
        if (t === "replyEdited") r.body = ev.body;
        else if (t === "replyDeleted") r.deleted = true;
        else if (t === "replyRestored") r.deleted = false;
        r.updatedAt = Math.max(r.updatedAt, env.ts);
      }
      touch(a, env.ts);
    }
  }

  state.annotations.sort((a, b) => a.createdAt - b.createdAt || cmp(a.id, b.id));
  state.fileMarks.sort((a, b) => cmp(a.path, b.path));
  for (const a of state.annotations) a.replies.sort((x, y) => x.createdAt - y.createdAt || cmp(x.id, y.id));
  return state;
}

// ---------------------------------------------------------------------------------------------
// Interval helpers for region coverage (ALGORITHMS.md section 3)
// ---------------------------------------------------------------------------------------------

/** Inclusive integer intervals, kept sorted, disjoint and merged when they touch. */
export function addInterval(list, s, e) {
  const out = [];
  let ns = s;
  let ne = e;
  for (const [a, b] of list) {
    if (b + 1 < ns || a > ne + 1) out.push([a, b]);
    else {
      ns = Math.min(ns, a);
      ne = Math.max(ne, b);
    }
  }
  out.push([ns, ne]);
  return out.sort((x, y) => x[0] - y[0]);
}

export function subtractInterval(list, s, e) {
  const out = [];
  for (const [a, b] of list) {
    if (b < s || a > e) out.push([a, b]);
    else {
      if (a < s) out.push([a, s - 1]);
      if (b > e) out.push([e + 1, b]);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Relocation of a reviewed region (ALGORITHMS.md section 3)
// ---------------------------------------------------------------------------------------------

/** Where the marked lines are in `lines` now: the same place, or the one place they occur; else null. */
export function resolveMark(range, lines) {
  if (!lines) return null;
  const n = range.endLine - range.startLine + 1;
  if (range.endLine <= lines.length && hashLines(lines.slice(range.startLine - 1, range.endLine)) === range.hash) {
    return [range.startLine, range.endLine];
  }
  let found = null;
  for (let i = 0; i + n <= lines.length; i++) {
    if (hashLines(lines.slice(i, i + n)) !== range.hash) continue;
    if (found) return null; // ambiguous
    found = [i + 1, i + n];
  }
  return found;
}

// ---------------------------------------------------------------------------------------------
// Locating a comment's code again, for suggestions (ALGORITHMS.md section 4)
// ---------------------------------------------------------------------------------------------

const FUZZY = 0.7;

export function locate(range, lines) {
  const snip = range.snapshot.lines;
  const n = snip.length;
  const oldStart = range.startLine;
  if (n === 0 || lines.length < n) return null;
  const { before, after } = range.snapshot;

  const score = (i) => {
    let s = 0;
    before
      .slice()
      .reverse()
      .forEach((b, k) => {
        const idx = i - 1 - k;
        if (idx >= 0 && trim(lines[idx]) === trim(b)) s++;
      });
    after.forEach((a, k) => {
      const idx = i + n + k;
      if (idx < lines.length && trim(lines[idx]) === trim(a)) s++;
    });
    return s;
  };
  const pick = (cands) => {
    let best = null;
    for (const i of cands) {
      if (!best) {
        best = { i, s: score(i), d: Math.abs(i + 1 - oldStart) };
        continue;
      }
      const s = score(i);
      const d = Math.abs(i + 1 - oldStart);
      if (s > best.s || (s === best.s && d < best.d)) best = { i, s, d };
    }
    return best ? [best.i + 1, best.i + n] : null;
  };
  const windows = (match) => {
    const out = [];
    for (let i = 0; i + n <= lines.length; i++) if (match(i)) out.push(i);
    return out;
  };

  let r = pick(windows((i) => snip.every((l, k) => trimEnd(lines[i + k]) === trimEnd(l))));
  if (r) return r;
  r = pick(windows((i) => snip.every((l, k) => trim(lines[i + k]) === trim(l))));
  if (r) return r;
  if (n >= 3) {
    r = pick(windows((i) => snip.filter((l, k) => trim(lines[i + k]) === trim(l)).length / n >= FUZZY));
    if (r) return r;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Evaluation against file contents (SPEC.md section 8)
// ---------------------------------------------------------------------------------------------

const ZERO = /^0+$/;

export function changeKey(f) {
  return `${f.oldMode}:${f.newMode}:${f.oldBlob}:${f.newBlob}`;
}

export const pinsEqual = (a, b) => a.baseSha === b.baseSha && a.baseTipSha === b.baseTipSha && a.headSha === b.headSha;

/**
 * `content` = { changesets, readBlob(id) -> Buffer | null }. The changeset for the current pin lists the
 * changed files with their modes and blob ids; blobs give the text of each side.
 */
export function evaluate(state, content) {
  const pin = state.review.pin;
  const files = content.changesets[`${pin.baseSha}..${pin.headSha}`];
  if (!files) throw new Error(`no changeset for pin ${pin.baseSha}..${pin.headSha}`);
  const fileFor = (path) => files.find((f) => f.path === path) ?? null;

  const sideLines = (file, side) => {
    if (!file) return null;
    const blob = side === "new" ? file.newBlob : file.oldBlob;
    if (ZERO.test(blob)) return null;
    const bytes = content.readBlob(blob);
    if (!bytes) return null;
    return linesOfBlob(bytes); // null when the blob is not text (ALGORITHMS 1.3)
  };

  // Comments
  const annotations = {};
  for (const a of state.annotations) {
    const anchor = a.anchor;
    if (anchor.scope === "review" || pinsEqual(anchor.pin, pin)) {
      annotations[a.id] = { state: "current" };
      continue;
    }
    const file = fileFor(anchor.path);
    if (!file) {
      annotations[a.id] = { state: "outdated" };
      continue;
    }
    if (anchor.scope === "file") {
      annotations[a.id] = { state: "unchanged" };
      continue;
    }
    let unchanged = true;
    const suggestion = [];
    for (const r of anchor.ranges) {
      const lines = sideLines(file, r.side);
      const same = lines && r.endLine <= lines.length && r.snapshot.lines.length === r.endLine - r.startLine + 1 && lines.slice(r.startLine - 1, r.endLine).every((l, k) => l === r.snapshot.lines[k]);
      if (!same) unchanged = false;
      const at = same ? [r.startLine, r.endLine] : lines ? locate(r, lines) : null;
      suggestion.push(at ? { side: r.side, startLine: at[0], endLine: at[1] } : null);
    }
    if (unchanged) annotations[a.id] = { state: "unchanged" };
    else if (suggestion.every(Boolean)) annotations[a.id] = { state: "outdated", suggestion: { path: file.path, ranges: suggestion } };
    else annotations[a.id] = { state: "outdated" };
  }

  // File marks
  const fileMarks = state.fileMarks.map((m) => {
    const f = fileFor(m.path);
    return { path: m.path, state: !f ? "gone" : changeKey(f) === m.changeKey ? "valid" : "stale" };
  });

  // Region marks
  const groups = new Map();
  for (const ev of state.regionEvents) {
    for (const r of ev.ranges) {
      const key = `${ev.path}\u0000${r.side}`;
      if (!groups.has(key)) groups.set(key, { path: ev.path, side: r.side, steps: [] });
      groups.get(key).steps.push({ type: ev.type, range: r });
    }
  }
  const regions = [];
  for (const g of groups.values()) {
    const lines = sideLines(fileFor(g.path), g.side);
    let covered = [];
    const staleByBlob = new Map();
    for (const { type, range } of g.steps) {
      const at = resolveMark(range, lines);
      if (at) {
        covered = type === "reviewed" ? addInterval(covered, at[0], at[1]) : subtractInterval(covered, at[0], at[1]);
      } else {
        const list = staleByBlob.get(range.blob) ?? [];
        staleByBlob.set(range.blob, type === "reviewed" ? addInterval(list, range.startLine, range.endLine) : subtractInterval(list, range.startLine, range.endLine));
      }
    }
    const stale = [];
    for (const [blob, list] of staleByBlob) for (const [s, e] of list) stale.push({ blob, startLine: s, endLine: e });
    stale.sort((a, b) => a.startLine - b.startLine || cmp(a.blob, b.blob));
    if (covered.length || stale.length) regions.push({ path: g.path, side: g.side, reviewed: covered, stale });
  }
  regions.sort((a, b) => cmp(a.path, b.path) || cmp(a.side, b.side));

  return { pin, annotations, fileMarks, regions };
}

export function loadContent(dir) {
  const changesets = JSON.parse(readFileSync(join(dir, "changesets.json"), "utf8"));
  return {
    changesets,
    readBlob: (id) => {
      const p = join(dir, "blobs", id);
      return existsSync(p) ? readFileSync(p) : null;
    },
  };
}
