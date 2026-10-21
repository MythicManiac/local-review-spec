# Conformance: what each tool has to change

Informative. Written from reading the app (`local-review-app`, its store under `src-tauri/src/store/`) and
the plugin (`local-review-plugin` 0.1.0, commit `8a830a5`, `core/`). Neither project was changed to make
this. Items are in the order to do them. Draft 3 revised it after checking the plugin's code against the
spec (the items marked *draft 3*).

How to prove it: both tools fold `examples/state/reviews/*` and compare with `examples/expected/*.json`
(SPEC 12), run the algorithm vectors in `tools/selftest.mjs`, and pass the cross-tool test at the end.

## The app

The app's current events are close to this format; most work is additive. Already conforming: the
change-set command (SPEC 8: the app runs exactly it, plus a `--full-index` that changes nothing), the
`changeKey` format, and the identity `path` of renames and deletions.

1. **`group.json`**: write `schemaVersion: 2`, `createdAt`; make `name` optional (fall back to the folder
   name). Reading a group the plugin made currently fails with `` missing field `name` ``.
2. **Repository files**: new groups get the exact `.gitattributes` and `.gitignore` of SPEC 2.1. When
   opening a group, **append the lines that are missing**; commit; never rewrite or remove a line. A
   SHOULD on top: check the **effective rules** with git (`tools/repocheck.mjs`) and append again any
   required line a later line overrides. (Today the app writes `* -text` and `*.lock`, `*.tmp` only at
   group creation, and a group the plugin made has a `.gitignore` of only `*.tmp` and no `.gitattributes`.)
3. **Sync**: merge with `--allow-unrelated-histories`; resolve a `group.json` conflict by the rule in SPEC
   9.3, and a `.gitattributes` or `.gitignore` conflict by the rule there (the other lines of both
   versions, sorted, then the required lines last: `mergeRepoFile(required, ours, theirs)` in
   `tools/lib.mjs`, no merge base needed); retry a rejected push up to three times; keep aborting on any
   other conflict. Use the user's git identity when set.
4. **Anchors** become `{scope, path, oldPath?, pin, ranges[]}` with the snapshot per range (today:
   `{path, oldPath, side, startLine, endLine, pin, snapshot}`, which is replaced, not read). Add the
   `review` scope (a place in the UI for review-level comments) and the second range (a selection spanning
   both sides in the inline view).
5. **Line model**: stop counting a final empty line after a trailing newline. Today `line_window` counts
   one (to match Monaco), so an annotation can be created on a line that does not exist in git's model;
   clamp to the number of real lines and do not offer that line in the editor. *Draft 3:* apply the text
   rules of ALGORITHMS 1.3 and 1.1: a leading byte order mark is not part of line 1; a file that is not
   well-formed UTF-8, or has a CR that does not end a CRLF pair, is not text and gets only file marks and
   file anchors (Monaco splits on a lone CR; the numbers would differ from other tools).
6. **Marks**: stop writing `hunkReviewed`/`hunkUnreviewed`; write `regionReviewed`/`regionUnreviewed` with
   `{side, startLine, endLine, blob, hash}`. Replace `hunk marks by content hash` and the hunk panel's
   state by the evaluation of ALGORITHMS 3. Keep `fileReviewed` unchanged (`changeKey` is already
   `oldMode:newMode:oldBlob:newBlob`). Derive ranges from git hunks as in ALGORITHMS 6; add "mark
   selection reviewed".
7. **Comments**: add `ruleText` (with the existing `rule_candidate` tag), the `wontFix` status with a
   `note`, and `annotationReanchored.method`. Replace the "Outdated" chip's Re-anchor flow by the
   suggestion of ALGORITHMS 4 (it already has "pick lines"; add "accept suggestion").
8. **Drafts and reading position**: move out of the log into `reviews/<id>/local/<device-id>/` (SPEC 10),
   still `fsync`ed. Stop writing `draftSaved`, `draftDiscarded`, `positionSaved`.
9. **Device id**: unchanged, but never shared with another tool.
10. **Tests**: add the fold and evaluation vectors. Existing store tests that pin hunk marks or the flat
    anchor change with items 4 and 6. Optional, not required for now: tests for a leftover `.lock` file with
    no holder and for a killed holder (the app tests only "second open while held" and "open after drop").

**No migration.** The app's earlier format (schemaVersion 1) held no real data. The app does not read it: a
`review.json` or `group.json` below version 2 is reported as an older format and skipped (SPEC 2.2), and a
developer deletes any such files. Nothing in this format exists only to read it.

## The plugin

The plugin changes its store from one JSON file per entity to event logs, and keeps its UI. The choices
the user made for it are recorded in DECISIONS (U7 and the plugin scope below).

1. **Layout**: write `reviews/<review-id>/` with `review.json` and `events/<device-id>.jsonl` inside the
   group, not `<repo-name>/<review-id>/`. New groups get the exact repository files of SPEC 2.1. *Draft 3:*
   groups made by 0.1.0 have a `.gitignore` of only `*.tmp` and no `.gitattributes`; on opening such a
   group the plugin appends the missing lines, checks the effective rules with git and appends again any
   that a later line overrides (SPEC 2.1, a SHOULD), and commits, so lock files and device-local data are
   never committed. Keep the old `.state/` outside the group for last-opened pointers, the repository to
   group choice and the device id.
2. **Device id** *(draft 3, decided by the user; draft 5 changed its consequence)*: one per **machine**,
   generated once and kept in `.state/`, shared by every IDE on the machine that runs the plugin (SPEC 5.1,
   *Hosts*). It is not kept in IDE settings, which Settings Sync could copy to another machine. Because
   `.state/` sits in the store root, which someone may sync with a file-sync service, store a machine
   fingerprint beside the id and generate a new id when it differs (SPEC 5.1). Take the lock of SPEC 5.2
   **per event**, so all IDEs can write to one review at once; keep one lock holder per review per IDE
   process, shared by all projects and windows (Java refuses a second lock on one file in one process).
   Holding the lock for a whole session instead is allowed and makes the other IDEs read-only for that
   review (SPEC 5.2).
3. **Event log**: write (the critical section of SPEC 5.2 for every event: lock, read the log's last `ts`
   and `seq`, append, `fsync`, release) and read (SPEC 5.3) and fold (SPEC 7). `ReviewStore` becomes a view
   over the fold instead of a set of files; `AtomicFiles` remains for `review.json` and `group.json`. Lock
   the `.lock` file, not the log itself (verified: an operating system lock on the log makes `git add -A`
   fail on Windows, exit 128, "unable to index file").
4. **Replace the per-file conflict machinery.** `GroupSync`'s `rank`/`.conflict-` logic goes: merge with
   union and the three resolutions of SPEC 9.3. Keep the retry loop and the SSH key support.
5. **`review.json`**: immutable; no `revisions`, no `updatedAt`, no `lastKnownPath`; add `repo.rootCommit`
   (smallest root commit from the head). `saveReview` (rename) becomes `reviewRenamed`.
6. **Update review** becomes retargeting: write `reviewRetargeted`, and stop rewriting comments. For each
   outdated comment compute a suggestion with `Anchoring.locate` (aligned to ALGORITHMS 4: the trim set,
   tie order) and let the user accept it, writing `annotationReanchored`.
7. **Comments**: `Comment` ↔ events by the table below. Do not erase tags or anything else the plugin does
   not know: `annotationEdited` carries `tags` only when the user changed them, built from the current tags
   so unknown ones survive.
8. **Marks**: replace `viewedFingerprint`/`viewedHunks` by `fileReviewed` (with the file's modes added to
   its `changeKey`, from the pinned command of SPEC 8: `GitCli.parseRaw` drops the modes today, and
   `GitCli.diffRaw` lacks `-c diff.renameLimit=5000`, `--no-color`, `--no-textconv` and
   `--ignore-submodules=none`) and region marks. Build
   ranges from the IDE diff chunks as in ALGORITHMS 6. The "all hunks reviewed means the file is reviewed"
   rule may stay as a tool behaviour that emits both events. The Changes tree computes progress from
   region marks against the changed lines in the background (user's choice), with a "calculating" state and
   an "unverified" state when the repository or a pinned commit is missing (SPEC 8).
9. **Selection across sides** in a unified diff stops collapsing to the clicked line: emit a range per
   side (`UnifiedDiffViewer.transferLineFromOnesideStrict(side, line)` gives, per selected line, its old and
   new numbers, or -1 when the line is not on that side). The review viewer forces whitespace-sensitive
   comparison (ALGORITHMS 6).
10. **Never move or rename anything.** *(Draft 3; this replaces "quarantine only files the plugin owns".)*
    Unreadable files are reported and left where they are: not in `events/`, not `review.json`, not files of
    the old layout (another 0.1.0 device may still use them). The plugin's `*.corrupt` renaming goes;
    `*.corrupt` files left by 0.1.0 are ignored.
11. **Lines come from the blobs** *(draft 3)*. Snapshots, hashes and line numbers are computed from the git
    blob bytes by ALGORITHMS 1, never from the IDE's document (`DiffReviewController.sideLines` reads
    `document.text` today; the IDE applies its own charset, drops the BOM and splits on a lone CR). The
    trim set is the four ASCII characters of ALGORITHMS 1.4, not Kotlin's Unicode `trim()`
    (`Anchoring.kt`). For a file whose numbering in the viewer differs from the blob's, do not offer line
    comments or region marks; file comments and file marks still work. The plugin's plan (verified with
    probes on PyCharm 2026.2.3: the IDE strips a BOM, normalises CRLF, does not split on U+2028, U+0085 or
    form feed, turns invalid bytes into U+FFFD without changing the line count, and splits only on a lone
    CR, which ALGORITHMS 1.3 excludes): compute the lines by ALGORITHMS 1, feed the viewer the decoded text
    so its numbering matches by construction, and check the line counts as a safety net.
12. **Finding the clone** *(draft 3)*. `ReviewService.rootFor` matches `lastKnownPath` first; that path is
    forbidden in synced files. Use SPEC 4.1 (root commit, then URL, then display name) with a device-local
    mapping to open projects.
13. **Evaluation** *(draft 3)*. ALGORITHMS 3 is quadratic as written; implement 3.3's faster equivalent, run
    evaluation off the UI thread and cache it per (pin, events, blob). Never draw an unverified, stale or
    ambiguous range as reviewed.
14. **Commit author** *(draft 3)*: the fallback is `Local Review <local-review@localhost>` as SPEC 9.2
    says; the plugin's rename changed its string to `Local Diff Review`.
15. **New vocabulary** *(draft 3, decided by the user)*, offered in the first conformant release: replies
    (shown and written), review status (`open`, `done`, `archived`; the Open Review list hides archived
    reviews, which stay openable), `ruleDecided` (`applied`, with the target path) when AGENTS.md is
    written, and tag-only rule candidates (shown as "needs wording" and listed in the AGENTS.md proposal and
    in exports). Everything else in the format that the plugin has no UI for is read, preserved and never
    erased.
16. **Import** of 0.1.0 reviews *(draft 3, decided by the user)*: automatic when a group opens, for each
    review whose commits are all present in a clone of the reviewed repository; see the next section.
17. **No dual writing.** A 0.1.0 device does not see events written in this format: it keeps working on the
    old files, and what it writes afterwards is picked up by the import. From reading its code (not run),
    0.1.0 skips a `reviews/` folder it cannot parse and only checks that `group.json` exists, so it does not
    break on a group in this format. Users should upgrade all their devices.
18. **Tests**: add the fold and evaluation vectors and the `examples/` comparison; remove the conflict tests
    of `GroupsTest`.

### Plugin 0.1.0 files → this format

For a one-time, repeatable import of an old review. The plugin runs it automatically when a group opens;
another tool that wants to read 0.1.0 data can use the same procedure. The old files are never modified or
deleted.

The import is a function of the old files **and of the git objects they name**: it needs the reviewed
repository for the identity paths, the root commit and the change keys. A review whose commits (every
base, effective base and head in its `revisions`) are not all present is reported as "not imported yet"
and tried again when they arrive; nothing is written for it. Given the same inputs, every device writes the
same `review.json` bytes, the same event ids and the same event contents. Only an event's `ts` may differ
between devices, and only to keep the log increasing (see *Ids and times*); since events are identified by
id, that never duplicates anything.

**Where things go**

| Plugin 0.1.0 | This format |
| ------------ | ----------- |
| `group.json` `{schemaVersion: 1, id, createdAt: ISO}` | rewritten **in place** (the one exception to "never rewritten", needed because the old file sits at the new file's path) as `{schemaVersion: 2, id, createdAt: ms}`, `name` omitted, in the same canonical form as `review.json` below with the properties in that order. Done only when the file's `schemaVersion` is below 2, so a group already converted (by any device) is left alone; two devices converting before they sync write the same bytes |
| folder `<repo-name>/<review-id>/` | `reviews/<id>/`; the repository name goes to `repo.displayName` |
| review id | kept if it matches the id rule. Otherwise: each character outside `[A-Za-z0-9_-]` becomes `_`; if the result is longer than 64, keep its first 55 characters and append `-` and the first 8 hex characters of the SHA-256 of the original id (UTF-8). 0.1.0 ids are `yyyyMMdd-HHmm-<slug>` with an optional `-N` suffix and reach 67 characters, so a few long titles need this |
| `review.json` | written **only if `reviews/<id>/review.json` does not exist**, in the form below |
| `repo{name, remoteUrl, lastKnownPath}` | `repo{displayName, originUrl, rootCommit}`; `lastKnownPath` is dropped; `rootCommit` is the smallest root commit reachable from the head of the first revision |
| `mergeBase` | `mode`: `mergeBase` / `direct` |
| `revisions[0]` | `pin`; `baseSha`→`baseTipSha`, `effectiveBaseSha`→`baseSha`, `headSha`→`headSha` |
| `revisions[n]`, n ≥ 2 | one `reviewRetargeted` event with that pin, `ts` = the revision's `at` |
| `title` | `title` as it is when the review is first imported (0.1.0 has no rename) |
| `createdAt` | `createdAt` (ms) |

The written `review.json` is canonical, so two devices that import before they sync write the same bytes
and git merges the two additions without a conflict: UTF-8 without a byte order mark; the properties in
this order, `schemaVersion`, `id`, `title`, `createdAt`, `createdBy`, `repo` (`displayName`, `originUrl`,
`rootCommit`), `baseRef`, `headRef`, `mode`, `pin` (`baseSha`, `baseTipSha`, `headSha`); `createdBy` is
`import-v1`; `originUrl` is written as `null` when there is none; two-space indentation exactly as
`JSON.stringify(value, null, 2)` produces it; one `\n` at the end.

**Comments**: each `comments/<uuid>.json` gives these events, in this order, all with `annotationId` = the
old `id`. Times are the file's `createdAt`, `updatedAt` and `deletedAt` in ms.

| Event | When | `ts` | Carries |
| ----- | ---- | ---- | ------- |
| `annotationCreated` | always | `createdAt` | the *current* `kind`, `body`, `tags`, `ruleText` and `anchor` |
| `annotationEdited` | `updatedAt` > `createdAt` | `updatedAt` | the current `body`, `kind`, `tags`, `ruleText` |
| `annotationStatusChanged` | `updatedAt` > `createdAt`, or the status is not `OPEN` | `updatedAt` | `status` and `note` (= `resolutionNote`); this also records a reopening |
| `annotationDeleted` | `deletedAt` is set | `deletedAt` | |
| `annotationRestored` | `deletedAt` is not set and `updatedAt` > `createdAt` | `updatedAt` | |

Field mapping: `kind` `CHANGE_REQUEST` / `QUESTION` / `NOTE` → `changeRequest` / `question` / `comment`;
`status` `OPEN` / `RESOLVED` / `WONT_FIX` → `open` / `resolved` / `wontFix`; `rule` (text) → the tag
`rule_candidate` and `ruleText`; no `rule` → no tag. `outdated` is dropped (computed). The anchor:

| 0.1.0 anchor | This format |
| ------------ | ----------- |
| `scope` `REVIEW` / `FILE` / `LINES` | `review` / `file` / `lines` |
| `revision` n | `pin` = the pin of revision n (as in the `revisions` rows above) |
| `path`, `side` `BASE` / `HEAD` | `path` and `oldPath`: in the change set between the pin's `baseSha` and `headSha`, the file whose old path (for `BASE`) or new path (for `HEAD`) equals `path`; `path` is that file's identity path (SPEC 8), `oldPath` is set for a rename. If no file matches, `path` stays as it was, with no `oldPath` |
| `startLine`, `endLine`, `snippet`, `before`, `after`; `side` | one range: `side` `old` / `new`, the lines, and `snapshot{lines, before, after}` exactly as stored |
| a `LINES` anchor whose file is not text at that pin (ALGORITHMS 1.3) or whose lines do not exist in the blob | scope `file` (0.1.0's viewer could show a line after a final newline) |

A snapshot is taken as stored. 0.1.0 captured it from the IDE's document, so for a file with a byte order
mark or another encoding it may differ from the blob's lines; the comment then evaluates as outdated and
gets a suggestion, which is correct behaviour.

**Marks**: each `progress/<key>.json` gives **one** event for its `path`, at `ts` = its `updatedAt`:
`fileReviewed` with the file's `changeKey` (`oldMode:newMode:oldBlob:newBlob` from `git diff --raw`, at the
old review's last revision) if the file is in that change set and recomputing 0.1.0's fingerprint
`sha1("STATUS|oldPath|newPath|oldBlob|newBlob")` for it equals `viewedFingerprint` (`STATUS` is `ADDED`,
`MODIFIED`, `DELETED`, `RENAMED`, `COPIED` or `TYPE_CHANGED`; an absent path is the text `null`; an absent
blob is the empty text); otherwise `fileUnreviewed`. (So a mark removed or gone stale in 0.1.0 after an
earlier import is cleared by the next one.) `viewedHunks` are dropped: they are hashes of IDE diff chunks
and cannot be turned into lines. `hunkCount` is dropped.

**Ids and times.** An imported event's `id` is `imp-` followed by the first 32 hex characters of
`SHA-256(<file path relative to the review folder> NUL <file bytes> NUL <event type> NUL <part>)`, where
`NUL` is one zero byte and `<part>` is the revision number n for `reviewRetargeted` and empty for every
other event (all retargets come from the same `review.json`, so they need it). The device is `import-v1`
and the events go to `events/import-v1.jsonl` with `seq` 1, 2, 3 … in the order written. `ts` is the source
time in milliseconds, truncated (not rounded); events are written in order of `ts`, then the order of the
tables above, then `id`; an event whose `ts` is not greater than the previous line's gets the previous
line's plus 1, because a log's `ts` is strictly increasing (SPEC 5).

**Importing again.** Compute the events for the files as they are now and append those whose ids are not
already in `import-v1.jsonl`. Unchanged files add nothing. A file a 0.1.0 device changed gives new events
that apply as edits (SPEC 7: a repeated `annotationCreated` is an edit, carrying the current anchor; a
later native event, such as a re-anchoring, still wins by time). `import-v1.jsonl` is one log that several
devices may append to; the union merge in SPEC 2.1 and the fold absorb that.

**Known limits.** A 0.1.0 review of a repository whose folder name is `reviews` sits at
`reviews/<id>/review.json` (schemaVersion 1), the place a version 2 review would use. It is reported as an
older format (SPEC 2.2) and **not** imported automatically: writing `events/` and a version 2 `review.json`
there would mix two formats in one folder. Moving the folder `reviews/` to another name in the group, then
importing, resolves it. Hunk marks are lost, as above.

## Both

1. **Spec home**: put this repository where both projects can reference it. A submodule needs the spec to
   have a remote that both can clone; until then keep a copy in each project and a test that compares its
   hashes with the spec's files. (The plugin's repository is public; the spec repository has no remote yet.)
2. **Cross-tool test**: run the app and the plugin as two devices against one bare git remote. Each adds
   comments, replies and marks on the same review (including a drag-selected region across two hunks and a
   two-sided region), syncs both ways, and the two folded states must be equal and equal to the expected
   shape. `tools/sync-experiment.mjs` shows the git side of this with the reference implementation.
3. **Refuse what you do not know**: both check `schemaVersion` and refuse a larger one.
4. **Text files**: both apply ALGORITHMS 1.3; a file that is not text gets file marks and file anchors only.
