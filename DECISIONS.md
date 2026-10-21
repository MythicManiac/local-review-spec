# Decisions

Informative. Why the format is the way it is. "App" is the standalone desktop app, "plugin" is the
JetBrains plugin (Local Diff Review 0.1.0).

The brief: one format that carries the feature sets of both tools, without implementing the same thing
twice where preferring one behaviour works. Where the tools disagreed on something that changes what the
user sees, the user chose. Everything else was decided on the merits and is listed with its reason, so it
can be reopened.

## Decided by the user

| # | Question | Decision | Consequence |
| - | -------- | -------- | ----------- |
| U1 | Storage format | **Event log, one append-only file per device** (the app's design) | The plugin moves from one mutable JSON file per comment to logs. In return nothing can conflict, nothing is lost by a rewrite, and the format can grow without breaking older tools. |
| U2 | What "reviewed" is bound to | **Region marks**: a reviewed mark is a line range on one side, plus a hash of the lines | Replaces both the app's git-hunk hashes and the plugin's IDE-chunk hashes. A hunk is only a shortcut for choosing a range. File marks stay, for files with no lines to select. |
| U3 | When a region mark goes stale | **Content-bound, with exact relocation** | A mark survives edits elsewhere in the file. One precisely specified matching rule (ALGORITHMS 3) replaces both tools' rules. |
| U4 | What happens to comments when the review moves to new commits | **Suggest, user confirms** | Both tools run one locate algorithm (the plugin's, with ties made exact). It only proposes; applying it writes `annotationReanchored`. Neither tool's old behaviour (silent fuzzy move, or no help at all) survives. |
| U5 | What one comment or region can cover | **Up to one range per side** | Covers a drag selection across hunks on one side, and a unified-view selection that spans removed and added lines. Tools must read two ranges; creating two is optional. |
| U6 | Where drafts and reading position live | **Device-local, not synced** | Out of the log and out of history. The app stops writing `draftSaved` and `positionSaved`. Resuming on another device starts at the top. |
| U7 | Device id of one tool's several hosts on one machine | **One per machine** in the plugin's `.state/`, shared by every IDE running it | The IDEs append through the lock of SPEC 5.2 (SPEC 5.1, *Hosts*). Draft 3 made the second IDE read-only for a review the first was writing; draft 5 takes the lock per event instead, so all IDEs can write, and a session-long lock (read-only others) remains allowed. The alternative, one id per IDE, would have avoided the sharing altogether. |
| U8 | What to do about groups made by 0.1.0 whose `.gitignore` is `*.tmp` only | **Change the spec**: a tool appends the missing required lines | SPEC 2.1 and 9.3 changed. The app does the same (CONFORMANCE). |
| U9 | Scope of the plugin's first conformant release | Replies (read and write), review status, `ruleDecided` on writing AGENTS.md, tag-only rule candidates, automatic import of 0.1.0 reviews, tree progress computed from region marks in the background | Listed in CONFORMANCE (plugin items 8, 15, 16). |
| U10 | Does the app need to read, or migrate, its own earlier files | **No.** It has no real data | Everything that existed only to read the app's earlier format is removed: the legacy event types, the flat anchor reader, the migration paragraph, the app-events mapping table. The plugin's 0.1.0 import stays (0.1.0 is released). |
| U11 | Who writes a group's `.gitignore` and `.gitattributes` | **Only the tools.** Nobody is expected to hand-edit them | The conflict rule need not preserve any ordering among other lines (sorted is enough), the effective-rules check is a SHOULD, and no merge base is needed. Foreign lines are still kept, never dropped. |
| U12 | How a reviewed region is relocated when its lines occur more than once in the file | **Unique only.** An ambiguous mark stays stale | No tie rules and no distance rules to agree on between tools. About 1.5% of surviving marks, all single lines, show as stale and are re-marked. See "Ambiguity is stale, not nearest" below. |

### What the brief assumed, and what was found

The brief assumed that neither tool supports a drag-selected region that is not a single hunk. Reading
both: **both already let the user drag-select lines on one side and comment on them**, across hunks if
they like (the app's gutter "+" over a selection, up to 500 lines; the plugin's editor selection).
Neither binds a **comment** to a hunk; only the reviewed **marks** are per hunk. What neither does:

- a region spanning **both sides** (in a unified diff the plugin collapses a selection that crosses sides to the
  clicked line);
- any reviewed mark smaller or larger than a whole file or a whole hunk.

U2 and U5 are the answer to those two gaps. Comments were already line-range based; the spec keeps that
and adds the second range.

## Decided on the merits (the two tools differed)

| Topic | App | Plugin | Spec | Why |
| ----- | --- | ------ | ---- | --- |
| Comment kind names | `changeRequest`, `question`, `comment` | `CHANGE_REQUEST`, `QUESTION`, `NOTE` | App's names; `NOTE` = `comment` | Pure naming. The event log is JSON with camelCase fields already. |
| Side names | `old`, `new` | `BASE`, `HEAD` | `old`, `new` | In a diff a side is a side of the diff, not a branch. Equivalent. |
| Comment status | `open`, `resolved` | adds `WONT_FIX` and a resolution note | `open`, `resolved`, `wontFix`, with optional `note` | A superset costs one enum value; dropping a distinction the plugin's users make would lose data. |
| Review-level comment | none | scope `REVIEW` | scope `review` | A superset. The app needs somewhere to show them. |
| Rule candidate | the tag `rule_candidate`, drafted later by a model | a rule text on the comment | The tag **and** an optional `ruleText` | They are different intents (flag it vs. I wrote it). Both fit, and neither tool's workflow is lost. |
| Replies, tags, review status | present | absent | present | They are additions; a tool that has no use for them shows the data and does not erase it. |
| Comment pin | three commits on the comment | an index into a review-wide revision list | three commits on the comment | Self-contained: a comment says what it was written about without reading anything else. The plugin's index translates to a pin on migration. |
| Review metadata | immutable `review.json` + events | mutable `review.json` with a `revisions` list | immutable + events | A file that is never rewritten never conflicts. `revisions` becomes a series of `reviewRetargeted` events. |
| Time | epoch milliseconds | ISO-8601 strings | milliseconds | Integers sort and compare without parsing. |
| Ids | ULID | UUID, and slug-style review ids | Any `[A-Za-z0-9_-]{1,64}`; ULID recommended | Both tools' ids already fit; no one has to renumber. |
| Group marker | `{schemaVersion, id, name}` | `{schemaVersion, id, createdAt}` | `{schemaVersion, id, createdAt, name?}` | A superset. `createdAt` is also what resolves two groups being joined. |
| Group location | explicit list in device config | scan a store root | not specified | Device-local convenience; either works against the same repository. |
| Review location | `reviews/<id>/` | `<repo-name>/<id>/` | `reviews/<id>/` | The repository name is data inside `review.json`, not a path component. `reviews/` also leaves the root free for the plugin's old layout during migration. |
| Repository identity | root commit, origin URL, display name | normalised URL, else name | all three, matched in that priority | Root commit is stable across forks and renames; the others remain as fallbacks. The plugin's URL normalisation is kept. |
| Machine path in synced files | none | `lastKnownPath` | forbidden | It is only true on one machine and invites conflicts. |
| Line model | trailing newline gives a final empty line (editor style) | trailing newline does not | trailing newline does not | Git's own model, and an anchor on a line that does not exist is a bug. The app must clamp. |
| Whitespace for matching | n/a | the language's `isWhitespace` | four ASCII characters | The two languages disagree on exotic characters; one fixed set is implementable identically. |
| Hash of lines | SHA-256 | SHA-1 | SHA-256 | Collision resistance costs nothing here. |
| Commit author | fixed `Local Review` identity | the user's identity if configured | user's if configured, else fixed | The history then says who made a commit when the user's git is set up. |
| Git merge | plain merge, fails on unrelated histories | `--allow-unrelated-histories` | allow unrelated histories | Lets two groups made apart be joined. |
| Same-file conflict | abort and report | keep the loser as `<file>.conflict-<hash>` | `group.json`, `.gitignore` and `.gitattributes` resolved by rule; anything else aborts and reports | With logs there is no same-file conflict to resolve. A side file nobody reads is a silent loss, so it is not offered. The three files can still conflict when groups are joined or upgraded, and a rule loses nothing there. |
| Unreadable file | report, never move | rename to `*.corrupt` | report, never move, in every file the format or an older tool wrote | Moving the user's data changes history on every device. Draft 2's CONFORMANCE had let the plugin quarantine its own files, which contradicted this; settled in draft 3. |
| When to sync | manual button | background plus manual | not specified | A policy of the tool, not of the format. Both are safe. |
| SSH key per group | none | per group, stored in the group's git config | optional, in the group's git config | A convenience that does not touch the format. |
| Repository files | `* -text` and `*.lock`, `*.tmp` written at creation only | `.gitignore` of only `*.tmp`, no `.gitattributes` | append missing lines; SHOULD check that git honours each rule and append again any a later line overrides; on conflict the other lines sorted, then the required lines last (U8, U11) | Groups the plugin already made would otherwise stay unprotected, and git applies the last matching line (see Changes since draft 2 and draft 3). Appending cannot lose anything and is what two devices would independently do. |
| What a text file is | n/a (no rule) | n/a | well-formed UTF-8, no lone CR, no NUL in the first 8000 bytes; a leading BOM is dropped | Tools and editors disagree on invalid bytes and on a lone CR; one rule removes the disagreement for the price of file marks on rare files. |

## Decided in the design (no conflict, but not obvious)

- **Union merge for logs.** `*.jsonl merge=union` makes the rare same-file append (a copied device id, a
  restored backup) merge without conflict. Verified in `tools/sync-experiment.mjs`. The fold removes
  duplicates and does not require `seq` to be contiguous, so the result is correct.
- **A repeated creation is an edit.** `annotationCreated` for an id that exists applies in order as an edit.
  This makes importing the same review twice (two devices migrating the plugin's old files) converge instead
  of duplicating, while still obeying last-writer-wins.
- **Creations are applied first.** An edit with a timestamp from a slow clock, earlier than its target's
  creation, is not lost.
- **File marks and region marks are independent.** The plugin's rule "all hunks reviewed means the file is
  reviewed, un-reviewing the file clears the hunks" is a tool behaviour, built from events, not a storage
  rule. It was removed from the format because the app does not have it and it entangles two facts.
- **Ambiguity is stale, not nearest (U12).** A mark relocates only when its exact lines occur once (or are
  still at the same numbers). More than one occurrence leaves it stale. "Nearest" is kept only where a human
  confirms the result (comment suggestions, ALGORITHMS 4). Why: a mark placed on a guessed occurrence
  reports code as reviewed that the reviewer never looked at, and "nearest" can jump between occurrences
  when unrelated lines change. Measured on the history of two small repositories (the app, 415 hunks; the
  plugin, 258 hunks), evaluated against the file at HEAD: about 17-18% of marks moved and were found
  uniquely, and 1.5% of the marks whose lines still existed were ambiguous. Every ambiguous mark was a
  one-line hunk (a blank line, a brace, an import); none of two or more lines was. The repositories are
  young (18 and 13 commits), so a large old one may show more, but the cost stays confined to short ranges.
  If it proves annoying in use, the upgrade is suggest-and-confirm for stale marks (no format change), not
  guessing.
- **Comment state is computed.** The plugin stored `outdated` in the comment file; storing it means two
  devices can disagree and a stale flag survives. Computing it from the pin and the files cannot.
- **Hunks are not in the format at all.** Not as an anchor, not as a mark, not as a hint. That is what
  makes the two tools' different hunks irrelevant.

## Left to each tool

User interface and gestures; automatic or manual sync; SSH identity; export formats (Markdown, JSON, agent
prompt); the model or command that drafts agent rules; keep-alive refs in the reviewed repository (only the
namespace is shared, SPEC 9.5); the display of `wontFix`, replies and review-level comments; whether to
emit `fileReviewed` automatically when regions cover a file.

## Known limits and open points

- **Renames across retargets.** A comment or mark whose file was renamed between pins is `outdated` / `stale`
  with no suggestion in the reference implementation. A tool may do better (ALGORITHMS 4.1).
- **Region marks do not follow a renamed file.** They are keyed by the file's identity path.
- **Large files.** Relocation hashes windows; ALGORITHMS 3.3 says an implementation must be faster than the
  definition and give the same answer. No performance work has been done in the reference implementation.
- **Several root commits.** `rootCommit` is the smallest; a repository that later gains an older root
  would change it. Matching falls back to the URL and the name.
- **No compaction.** Logs only grow. At the sizes of a review this is not a problem; if it becomes one, a
  snapshot event is an additive change (a new type).
- **Authorship.** Events record the device, not a person. A shared group is trusted: any device can write
  any event.
- **A reader that is too old** neither sees nor damages newer events (5.3, 11), and is told by the counts.
- **Several IDEs, one device id.** With one id per machine (U7) the IDEs append through the per-event lock of
  SPEC 5.2 and can all write to one review. A host that holds the lock for a whole session makes the others
  read-only for that review; both styles are allowed.
- **Stale locks.** The device lock cannot go stale after a crash (an OS lock on an open handle; a leftover
  `.lock` file is harmless), provided a tool implements it that way. Git's own `.git/index.lock` can: a crash
  during a git command leaves it, and commits and syncing fail until it is removed. Nothing is lost, and the
  committer reports git's message. **Undecided**, deliberately not specified: whether a tool offers to remove
  it on user confirmation, or removes one older than some age (state-repo git operations take milliseconds).
  Also not specified: how long to wait for a held device lock (about 3 seconds suggested), that the lock
  handle must not be inherited by child processes (true for the app's Rust handle; the plugin's Java handle
  is unchecked), that `git clean -fdx` could delete a held lock file, and that a hung process holds a
  session-long lock until it is killed. All judged rare.
- **Old-layout folder named `reviews`.** A 0.1.0 review of a repository called `reviews` sits where a
  version 2 review goes. It is reported and not imported automatically (CONFORMANCE).
- **Re-importing is by id, not by time.** An import after a 0.1.0 device changed a file adds events with new
  ids; their `ts` may be raised by a millisecond to keep the log increasing, which can reorder them against
  another device's event within that millisecond.

## Changes since draft 2

Draft 3 came from checking the plugin's code against the spec; no tool had implemented draft 2, so the
format version stays 2.

| Change | Why |
| ------ | --- |
| SPEC 2.1: repository files must **contain** the required lines; opening a group **appends** the missing ones (U8) | Draft 2 said "present with different content: do not rewrite". Every group plugin 0.1.0 made has a `.gitignore` of only `*.tmp`, so `*.lock` and `/reviews/*/local/` would never be ignored and lock files and device-local drafts would be committed (checked: `git add -A` stages a locked `.lock` file). |
| SPEC 9.3: a `.gitattributes` / `.gitignore` conflict is resolved by the union rule, not by writing the exact content | Exact content would drop lines a user or an older tool added. Verified with real git in `tools/sync-experiment.mjs` (5a, 5b). |
| SPEC 5.1: *Hosts*; several hosts of one tool may share a device id when they take the lock (U7) | The plugin runs in several IDEs on one machine. |
| SPEC 2.2: a `review.json` below version 2 is reported and skipped | A 0.1.0 review can sit exactly where a version 2 one goes. |
| ALGORITHMS 1.1, 1.3: a byte order mark is dropped; **text** now also means well-formed UTF-8 and no lone CR; lines come from the blob's bytes | An IDE document differs from the blob in charset, BOM and splitting on a lone CR; invalid UTF-8 has no single decoding. Such a file gets file marks and file anchors only. |
| CONFORMANCE: the import is deterministic and needs the reviewed repository; canonical `review.json` and `group.json`; id rule for ids over 64 characters; one event per progress file; restore and reopen are expressed; event ids made unique for retargets; no quarantine of any file | Draft 2 called the import "a pure function of the old bytes" although it needs the repository, wrote `review.json` in a way two devices could write differently (an add/add conflict that SPEC 9.3 aborts on), and gave every retarget the same id. |

## Changes since draft 3

Draft 4 answers a review of draft 3 and the user's answer that the app has no real data. No tool has
implemented any draft, so the format version stays 2.

| Change | Why |
| ------ | --- |
| SPEC 9.3: the `.gitignore`/`.gitattributes` conflict rule puts the required lines **last** (draft 3: first), with the other lines of both versions sorted before them | Git applies the **last** matching line. Draft 3's rule could put a `* text=auto eol=crlf` from the other side after `* -text`, turning on the conversion the rule exists to prevent (shown with real git). An intermediate version of draft 4 also kept each side's lines in their own order using the merge base, so a negation stayed after its pattern; it was dropped because the files belong to the tools (U11), so no ordering among the other lines means anything. The rule needs no merge base. Experiment 6b. |
| SPEC 2.1: **Effective rules**. Opening a group SHOULD ask git whether each required rule is honoured, and append again any that a later line overrides; warn if one still is not | Draft 3 treated a required line as satisfied wherever it appeared, so `* -text` followed by `* text=auto` was accepted. Present is not effective. A SHOULD, not a MUST, because between tools that follow the spec it cannot arise (U11). Experiment 6a. `tools/repocheck.mjs`. |
| SPEC 5.2: the writer's lock is on `<device-id>.lock`, never on the log | Draft 3 allowed either while CONFORMANCE forbade the log, because a lock on the log can stop git from reading it. One rule now. |
| Removed: the legacy event types (old SPEC 6.1) and the `ignoredLegacy` count; the app's flat anchor shape in the reference reader; the app's migration paragraph; the "App events → this format" table; the three legacy lines of the edge-case example (U10) | The app has no real data (U10). A spec that carries its predecessor's format forever pays for it in every reader. An event type nobody defines is simply an unknown event. SPEC 6.1 now says drafts, position and hunk marks are not part of the format. |
| SPEC 2.2 names what "older format" means: plugin 0.1.0, and the app's pre-spec files, which are not supported | There is no app-v1 upgrade to specify, so the gap found in the review (an unspecified, non-canonical rewrite of the app's `review.json`, contradicting "never modified") does not exist. |

## Changes since draft 4

Draft 5 answers the plugin developer's review of draft 4 (verified with probes on PyCharm 2026.2.3) and a
check of the app against the spec. No tool has implemented any draft, so the format version stays 2.

| Change | Why |
| ------ | --- |
| SPEC 8 pins the whole change-set command: `git -c diff.renameLimit=5000 diff --raw -z -M --no-color --no-ext-diff --no-textconv --ignore-submodules=none --no-abbrev` | Found twice, independently: the plugin developer from git's documentation, and by comparing the app (which already ran these flags) with the spec's plain `-M`. A user's `diff.renameLimit` (default 1000) makes git skip inexact rename detection, and `diff.ignoreSubmodules` hides submodule changes, so two devices could disagree on file identity and `changeKey`. `tools/changeset-experiment.mjs` shows both effects and that the pinned command is immune. The app conforms as it stands. |
| SPEC 5.2: appending is a per-event critical section under the lock (take it, read the log's last `ts` and `seq`, append, `fsync`, release); holding it for a whole session is allowed; "a second instance MUST be refused" is gone | The plugin developer pointed out that 5.2 asked for the lock per event but also for refusing a second instance, which only a session-long lock gives. Per event is what lets several IDEs share one device id and all write (U7 chose the shared id; its consequence, a read-only second IDE, is now optional). The app's session-long lock stays valid. |
| SPEC 5.1: a tool SHOULD detect that its device id was copied (machine identifier beside the id; new id on mismatch); the group's folder and the folder holding ids and locks SHOULD be on a local disk | The plugin keeps its id in `.state/` inside the store root, which a file-sync service could copy to another machine; OS locks are unreliable on network and cloud-synced folders. |
| ALGORITHMS 6: ranges for marks come from a whitespace-sensitive comparison; changed lines may come from the tool's own engine and need not agree between tools | A viewer that ignores whitespace could never mark a whitespace-only change. IDE and git choose different hunks around repeated lines; nothing stored depends on it. |
| CONFORMANCE: the plugin's verified plan for lines from blobs (probes on 11 awkward files: only a lone CR changes the IDE's numbering), for unified selections, for the lock and the device id, and the exact flags `GitCli.diffRaw` lacks | Recorded so the implementation starts from what was measured. |
| Informative notes on stale locks (SPEC 5.2, 9.2); no new requirements | Raised after asking whether a crash can leave a lock stuck. Judged rare enough not to specify further for now. |
| U12 recorded: reviewed marks relocate only when unique (confirmed by the user); the earlier "nearest" wording is gone | The user's first choice was "exact relocation (unique, nearest)"; the spec narrowed it to unique and flagged that. After seeing the tradeoffs and a measurement, the user confirmed unique-only. |

## Changes since draft 5

Draft 6 is the wording pass the plugin developer asked for after re-reading draft 5. No tool has implemented
any draft, so the format version stays 2.

| Change | Why |
| ------ | --- |
| SPEC 5.2 step 2: the writer reads the `ts` and `seq` of the last line that is a **valid event envelope** (any event type), scanning back from the end; if there is none, `seq` is 1 and `ts` is only bounded by the writer's own previous event | Draft 5 said "last complete line". A writer that adds the `\n` after a torn tail (step 3) and then dies leaves an invalid fragment as the last complete line, and the next writer would have nothing to read. A newer tool's events must count too, so any type is accepted. |
| SPEC 8: a tool MUST run the change-set command with git's working directory at the top level of the reviewed repository | With `diff.relative` set in a user's configuration, the same command run from a subdirectory reports only that subdirectory's files with shortened paths; no flag of the command prevents it (`tools/changeset-experiment.mjs`, check 4). Running at the top level was chosen over adding `--no-relative`, which needs git 2.28 or newer. |

## Changes since draft 6 (baseline 1)

Frozen for implementation as `baseline-1`. No tool has implemented any draft, so the format version stays 2.

| Change | Why |
| ------ | --- |
| SPEC 5.2: a writer that holds the lock for the whole session may keep the last `ts` and `seq` in memory | Step 2 says to read the end of the log for each event, which read literally made the app's session-long lock non-conformant. Nobody else can append to the log while the lock is held, so the cached values are equivalent. Found while confirming that the app conforms. |
| The algorithm vectors moved from `tools/selftest.mjs` to language-neutral JSON files in `vectors/` (119 checks including the manifest check, up from 55 once each case counts separately), with new cases for rules that had none (the interval operations, the trim set, a code point above U+10FFFF, a truncated sequence, the exact-before-trimmed pass order, context scoring, UTF-8 byte order in the conflict sort) | The Rust and Kotlin implementations would otherwise transcribe the vectors by hand from JavaScript. The expected values are hand-derived (the digests with `sha256sum`), so the reference implementation cannot hide a bug in them; breaking the reference six ways, each was caught. |
| The freeze: `CHANGE_CONTROL.md`, `FINDINGS.md`, `SPEC_VERSION`, `MANIFEST.sha256` and `tools/manifest.mjs` (the self-test fails if a normative file differs from the manifest); the tag `baseline-1` | A frozen text needs a name, a record of exactly which bytes it is, and a rule for changing it. Line endings are normalised when hashing Markdown and JSON outside `examples/`, so a checkout with converted line endings still matches. |
