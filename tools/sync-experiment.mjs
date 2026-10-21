#!/usr/bin/env node
// Proves, against real git, the sync rules the spec relies on (SPEC.md section 9):
//
//   1. Two devices writing their own logs merge without conflict.
//   2. Two writers appending to the SAME log file (a copied device id, a restored backup) also merge
//      without conflict, because *.jsonl uses git's built-in union merge, and the fold absorbs the result.
//   3. Two groups created independently and then joined conflict only on group.json, and the
//      deterministic rule (older createdAt wins, then the smaller id) gives both devices the same file.
//   4. .gitattributes `* -text` keeps log bytes exact on a machine with core.autocrlf=true.
//   5. A group made by an older tool (a .gitignore with only "*.tmp") is brought up to the format by
//      appending the missing lines; two devices doing it independently merge cleanly, and when each also
//      has lines of its own the conflict is resolved by the rule of SPEC 9.3 with the same result on both.
//   6. Git applies the last matching line, so the checks ask git whether the required rules are honoured:
//      a present-but-overridden line is detected and repaired, and the conflict rule leaves them effective.
//
//   node tools/sync-experiment.mjs        (needs git on PATH; uses a temporary folder)

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import assert from "node:assert/strict";
import { fold, appendMissing, mergeRepoFile, GITIGNORE_LINES, GITATTRIBUTES_LINES } from "./lib.mjs";
import { ineffective, repair } from "./repocheck.mjs";

const tmp = mkdtempSync(join(tmpdir(), "lrs-sync-"));
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};
const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@localhost", "-c", "commit.gpgsign=false", ...args], { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const tryGit = (cwd, ...args) => {
  try {
    return { ok: true, out: git(cwd, ...args) };
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
};
const put = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

const GITATTRIBUTES = "* -text\n*.jsonl merge=union\n";
const GITIGNORE = "*.lock\n*.tmp\n/reviews/*/local/\n";
const NEWLINE = "\n";
const meta = (id) => JSON.stringify({ schemaVersion: 2, id, title: "t", createdAt: 1, createdBy: "d", repo: { displayName: "r", originUrl: null, rootCommit: null }, baseRef: "a", headRef: "b", mode: "direct", pin: { baseSha: "1".repeat(40), baseTipSha: "1".repeat(40), headSha: "2".repeat(40) } });
const event = (dev, seq, ts, id, ev) => JSON.stringify({ v: 1, id, ts, dev, seq, ev }) + NEWLINE;
const created = (id) => ({ type: "annotationCreated", annotationId: id, kind: "comment", tags: [], body: id, anchor: { scope: "review" } });
const readState = (dir, review) => {
  const eventsDir = join(dir, "reviews", review, "events");
  const logs = ["a.jsonl", "b.jsonl"].filter((f) => existsSync(join(eventsDir, f))).map((f) => ({ name: f, bytes: readFileSync(join(eventsDir, f)) }));
  return fold({ meta: JSON.parse(readFileSync(join(dir, "reviews", review, "review.json"), "utf8")), logs });
};
const REVIEW = "r1";
let checks = 0;
const ok = (name) => {
  checks++;
  console.log(`ok  ${name}`);
};

function newGroup(dir, id, createdAt) {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  put(join(dir, "group.json"), JSON.stringify({ schemaVersion: 2, id, createdAt }, null, 2) + NEWLINE);
  put(join(dir, ".gitattributes"), GITATTRIBUTES);
  put(join(dir, ".gitignore"), GITIGNORE);
  put(join(dir, "reviews", REVIEW, "review.json"), meta(REVIEW) + NEWLINE);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
}
const commitAll = (dir, msg) => {
  git(dir, "add", "-A");
  if (tryGit(dir, "diff", "--cached", "--quiet").ok) return;
  git(dir, "commit", "-q", "-m", msg);
};
const sync = (dir) => {
  commitAll(dir, "update");
  git(dir, "fetch", "-q", "origin");
  const merged = tryGit(dir, "merge", "--no-edit", "--allow-unrelated-histories", "-m", "merge", "origin/main");
  if (!merged.ok) return merged;
  git(dir, "push", "-q", "origin", "HEAD:refs/heads/main");
  return merged;
};

try {
  // ---- 1 and 2: one group, two clones -------------------------------------------------------
  const bare = join(tmp, "remote.git");
  mkdirSync(bare);
  git(bare, "init", "-q", "--bare", "-b", "main");
  const one = join(tmp, "one");
  newGroup(one, "G1", 100);
  git(one, "remote", "add", "origin", bare);
  git(one, "push", "-q", "-u", "origin", "main");
  const two = join(tmp, "two");
  git(tmp, "clone", "-q", bare, two);
  const ev = (dir) => join(dir, "reviews", REVIEW, "events");

  put(join(ev(one), "a.jsonl"), event("a", 1, 1000, "e1", created("from-one")));
  put(join(ev(two), "b.jsonl"), event("b", 1, 1100, "e2", created("from-two")));
  assert.ok(sync(one).ok);
  assert.ok(sync(two).ok);
  assert.ok(sync(one).ok);
  assert.deepEqual(readState(one, REVIEW).annotations.map((a) => a.id).sort(), ["from-one", "from-two"]);
  assert.deepEqual(readState(two, REVIEW).annotations.map((a) => a.id).sort(), ["from-one", "from-two"]);
  ok("1. two devices, each writing its own log, merge without a conflict and converge");

  // Both machines now append to the SAME file a.jsonl (as if the device id had been copied).
  const aLog = (dir) => join(ev(dir), "a.jsonl");
  writeFileSync(aLog(one), readFileSync(aLog(one), "utf8") + event("a", 2, 2000, "e3", created("one-more")));
  writeFileSync(aLog(two), readFileSync(aLog(two), "utf8") + event("a", 2, 2100, "e4", created("two-more")));
  assert.ok(sync(one).ok);
  const clash = sync(two);
  assert.ok(clash.ok, `union merge should not conflict:\n${clash.out}`);
  assert.ok(sync(one).ok);
  const text = readFileSync(aLog(two), "utf8");
  assert.ok(text.includes('"id":"e3"') && text.includes('"id":"e4"'), "both sides' events survive the merge");
  const after = readState(two, REVIEW);
  assert.deepEqual(after.annotations.map((a) => a.id).sort(), ["from-one", "from-two", "one-more", "two-more"]);
  assert.equal(readState(one, REVIEW).annotations.length, 4);
  ok("2. two writers appending to the same log merge without a conflict and no event is lost");

  // Repeating the merge must not double anything: the same line twice is one event.
  writeFileSync(aLog(one), readFileSync(aLog(one), "utf8") + event("a", 2, 2000, "e3", created("one-more")));
  const dup = fold({ meta: JSON.parse(readFileSync(join(one, "reviews", REVIEW, "review.json"), "utf8")), logs: [{ name: "a.jsonl", bytes: readFileSync(aLog(one)) }] });
  assert.ok(dup.report.duplicates >= 1);
  ok("   a repeated line is counted as a duplicate and ignored");

  // ---- 3: two groups made apart, then joined ------------------------------------------------
  const bare2 = join(tmp, "remote2.git");
  mkdirSync(bare2);
  git(bare2, "init", "-q", "--bare", "-b", "main");
  const gA = join(tmp, "groupA");
  const gB = join(tmp, "groupB");
  newGroup(gA, "01AAAA", 100); // older
  newGroup(gB, "01BBBB", 200);
  git(gA, "remote", "add", "origin", bare2);
  git(gB, "remote", "add", "origin", bare2);
  git(gA, "push", "-q", "-u", "origin", "main");
  git(gB, "fetch", "-q", "origin");
  const joined = tryGit(gB, "merge", "--no-edit", "--allow-unrelated-histories", "-m", "join", "origin/main");
  assert.equal(joined.ok, false, "group.json differs, so the join conflicts");
  const unmerged = git(gB, "diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean);
  assert.deepEqual(unmerged, ["group.json"], `only group.json may conflict, got ${unmerged}`);
  ok("3a. joining two independent groups conflicts on group.json and on nothing else (the identical .gitattributes and .gitignore join cleanly)");

  // The rule: the older createdAt wins, then the smaller id. Both devices compute the same answer.
  const read = (stage) => JSON.parse(git(gB, "show", `:${stage}:group.json`));
  const ours = read(2);
  const theirs = read(3);
  const winner = ours.createdAt < theirs.createdAt || (ours.createdAt === theirs.createdAt && ours.id < theirs.id) ? "--ours" : "--theirs";
  git(gB, "checkout", winner, "--", "group.json");
  git(gB, "add", "group.json");
  git(gB, "commit", "-q", "--no-edit");
  git(gB, "push", "-q", "origin", "HEAD:refs/heads/main");
  git(gA, "pull", "-q", "--no-edit", "origin", "main");
  assert.equal(JSON.parse(readFileSync(join(gB, "group.json"), "utf8")).id, "01AAAA");
  assert.equal(JSON.parse(readFileSync(join(gA, "group.json"), "utf8")).id, "01AAAA");
  assert.equal(tryGit(gA, "ls-files", "reviews/r1/review.json").ok, true);
  ok("3b. the deterministic rule leaves both devices with the same group.json (the older group's id)");

  // ---- 4: line endings ---------------------------------------------------------------------
  const crlfDir = join(tmp, "crlf-check");
  git(tmp, "-c", "core.autocrlf=true", "clone", "-q", bare, crlfDir);
  // The bytes the remote holds (not `one`'s working file, which the duplicate-line check above modified).
  const wanted = execFileSync("git", ["show", "main:reviews/r1/events/a.jsonl"], { cwd: bare, env });
  const got = readFileSync(join(crlfDir, "reviews", REVIEW, "events", "a.jsonl"));
  assert.ok(wanted.equals(got), "log bytes must survive a checkout with core.autocrlf=true");
  assert.ok(!got.includes(Buffer.from("\r\n")), "no CR was added");
  ok("4. with core.autocrlf=true on the cloning machine, `* -text` keeps log bytes exact");

  {
    // ---- 5: groups made by an older tool (.gitignore holds only "*.tmp", no .gitattributes) -----------
    const older = (name) => {
      const remote = join(tmp, `${name}.git`);
      mkdirSync(remote);
      git(remote, "init", "-q", "--bare", "-b", "main");
      const seed = join(tmp, `${name}-seed`);
      mkdirSync(seed);
      git(seed, "init", "-q", "-b", "main");
      put(join(seed, "group.json"), JSON.stringify({ schemaVersion: 2, id: "OLD", createdAt: 1 }, null, 2) + NEWLINE);
      put(join(seed, ".gitignore"), "*.tmp\n");
      git(seed, "add", "-A");
      git(seed, "commit", "-q", "-m", "older tool");
      git(seed, "remote", "add", "origin", remote);
      git(seed, "push", "-q", "origin", "main");
      return ["one", "two"].map((n) => {
        const d = join(tmp, `${name}-${n}`);
        git(tmp, "clone", "-q", remote, d);
        return d;
      });
    };
    const readFile = (dir, f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : "");
    const bringUpToSpec = (dir, personal = "") => {
      put(join(dir, ".gitignore"), appendMissing(readFile(dir, ".gitignore"), GITIGNORE_LINES) + personal);
      put(join(dir, ".gitattributes"), appendMissing(readFile(dir, ".gitattributes"), GITATTRIBUTES_LINES));
      commitAll(dir, "bring the group up to the format");
    };

    const [p, q] = older("older-a");
    bringUpToSpec(p);
    bringUpToSpec(q);
    assert.ok(sync(p).ok);
    const same = sync(q);
    assert.ok(same.ok, `two devices appending the same lines must merge cleanly:\n${same.out}`);
    assert.equal(readFile(q, ".gitignore"), "*.tmp\n*.lock\n/reviews/*/local/\n", "the older tool's line stays where it was");
    assert.equal(readFile(q, ".gitattributes"), "* -text\n*.jsonl merge=union\n");
    ok("5a. two devices upgrading the same older group independently append the same lines and merge without a conflict");

    const [r, s] = older("older-b");
    bringUpToSpec(r, "build/\n"); // each device also has a pattern of its own
    bringUpToSpec(s, "dist/\n");
    assert.ok(sync(r).ok);
    const clash = sync(s);
    assert.equal(clash.ok, false, "different lines appended at the same place conflict");
    assert.deepEqual(git(s, "diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean), [".gitignore"], "and only .gitignore does");
    const stage = (n) => execFileSync("git", ["show", `:${n}:.gitignore`], { cwd: s, env, encoding: "utf8" });
    const resolved = mergeRepoFile(GITIGNORE_LINES, stage(2), stage(3));
    assert.equal(resolved, mergeRepoFile(GITIGNORE_LINES, stage(3), stage(2)), "the rule does not depend on which side is ours");
    put(join(s, ".gitignore"), resolved);
    git(s, "add", ".gitignore");
    git(s, "commit", "-q", "--no-edit");
    git(s, "push", "-q", "origin", "HEAD:refs/heads/main");
    git(r, "pull", "-q", "--no-edit", "origin", "main");
    assert.equal(readFile(r, ".gitignore"), "build/\ndist/\n*.lock\n*.tmp\n/reviews/*/local/\n");
    assert.equal(readFile(s, ".gitignore"), readFile(r, ".gitignore"));
    ok("5b. differently extended copies conflict on .gitignore only; the rule keeps both devices' lines and gives both the same file");
  }

  {
    // ---- 6: a required line that is present but overridden, and a merge that must not override -----------
    const fresh = (name, files) => {
      const d = join(tmp, name);
      mkdirSync(d, { recursive: true });
      git(d, "init", "-q", "-b", "main");
      for (const [f, t] of Object.entries(files)) put(join(d, f), t);
      return d;
    };
    const text = (d, f) => readFileSync(join(d, f), "utf8");

    // 6a: every required line is in the files, but later lines override two of them (git applies the last).
    const over = fresh("overridden", {
      ".gitattributes": "* -text\n*.jsonl merge=union\n* text=auto eol=crlf\n",
      ".gitignore": "*.lock\n*.tmp\n/reviews/*/local/\n!*.lock\n",
    });
    assert.equal(appendMissing(text(over, ".gitattributes"), GITATTRIBUTES_LINES), text(over, ".gitattributes"), "by line, nothing is missing");
    assert.deepEqual(ineffective(over).map((p) => p.line).sort(), ["* -text", "*.lock"], "but git honours only the others");
    const fixed = repair(over);
    assert.deepEqual(fixed.remaining, [], "appending the two lines again makes them last, and so effective");
    assert.equal(text(over, ".gitattributes"), "* -text\n*.jsonl merge=union\n* text=auto eol=crlf\n* -text\n", "only an append: nothing removed or rewritten");
    assert.equal(text(over, ".gitignore"), "*.lock\n*.tmp\n/reviews/*/local/\n!*.lock\n*.lock\n");
    ok("6a. a required line that is present but overridden is detected by asking git, and repaired by appending it again");

    // 6b: the conflict rule, applied to files that disagree (one side even has overriding lines), leaves the
    // required rules effective. Checked by asking git, not by reading the lines.
    const attrs = mergeRepoFile(GITATTRIBUTES_LINES, "* -text\n*.jsonl merge=union\n* text=auto eol=crlf\n", "* -text\n*.jsonl merge=union\n*.png binary\n");
    const ignore = mergeRepoFile(GITIGNORE_LINES, "*.tmp\n*.lock\n/reviews/*/local/\n!*.lock\n", "*.tmp\n*.lock\n/reviews/*/local/\nbuild/\n");
    const merged = fresh("merged-rules", { ".gitattributes": attrs, ".gitignore": ignore });
    assert.deepEqual(ineffective(merged), [], "every required rule is honoured after the merge");
    ok("6b. the conflict rule keeps every required rule effective, even when a side had an overriding line");
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`${checks} experiments passed`);
