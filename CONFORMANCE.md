# Conformance: what each tool has to change

Informative. Written from reading the app (`local-review-app`, its store under `src-tauri/src/store/`) and
the plugin (`local-review-plugin` 0.1.0, commit `8a830a5`, `core/`). Neither project was changed to make
this. Items are in the order to do them.

How to prove it: both tools fold `examples/state/reviews/*` and compare with `examples/expected/*.json`
(SPEC 12), run the algorithm vectors in `tools/selftest.mjs`, and pass the cross-tool test at the end.

## The app

The app's current events are close to this format; most work is additive.

1. **`group.json`**: write `schemaVersion: 2`, `createdAt`; make `name` optional (fall back to the folder
   name). Reading a group the plugin made currently fails with `` missing field `name` ``.
2. **Repository files**: write the exact `.gitattributes` and `.gitignore` of SPEC 2.1, including
   `*.jsonl merge=union` and `/reviews/*/local/`; create them when opening a group that lacks them. (Today
   the app writes `* -text` and `*.lock`, `*.tmp` only at group creation.)
3. **Sync**: merge with `--allow-unrelated-histories`; resolve a `group.json` conflict by the rule in SPEC
   9.3 (and `.gitattributes`, `.gitignore` by rewriting them); retry a rejected push up to three times;
   keep aborting on any other conflict. Use the user's git identity when set.
4. **Anchors** become `{scope, path, oldPath?, pin, ranges[]}` with the snapshot per range (today:
   `{path, oldPath, side, startLine, endLine, pin, snapshot}`). Keep reading the old flat shape
   (`normalizeAnchor` in `tools/lib.mjs` shows the conversion). Add the `review` scope (a place in the UI
   for review-level comments) and the second range (a selection spanning both sides in the inline view).
5. **Line model**: stop counting a final empty line after a trailing newline. Today `line_window` counts
   one (to match Monaco), so an annotation can be created on a line that does not exist in git's model;
   clamp to the number of real lines and do not offer that line in the editor.
6. **Marks**: stop writing `hunkReviewed`/`hunkUnreviewed`; write `regionReviewed`/`regionUnreviewed` with
   `{side, startLine, endLine, blob, hash}`. Replace `hunk marks by content hash` and the hunk panel's
   state by the evaluation of ALGORITHMS 3. Keep `fileReviewed` unchanged (`changeKey` is already
   `oldMode:newMode:oldBlob:newBlob`). Derive ranges from git hunks as in ALGORITHMS 6; add "mark
   selection reviewed".
7. **Comments**: add `ruleText` (with the existing `rule_candidate` tag), the `wontFix` status with a
   `note`, and `annotationReanchored.method`. Replace the "Outdated" chip's Re-anchor flow by the
   suggestion of ALGORITHMS 4 (it already has "pick lines"; add "accept suggestion").
8. **Drafts and reading position**: move out of the log into `reviews/<id>/local/<device-id>/` (SPEC 10),
   still `fsync`ed. Stop writing `draftSaved`, `draftDiscarded`, `positionSaved`. Existing events of these
   types are ignored on read (they are on the legacy list).
9. **Device id**: unchanged, but never shared with another tool.
10. **Tests**: add the fold and evaluation vectors. Existing store tests that pin hunk marks or the flat
    anchor change with items 4 and 6.

The app's present on-disk format (schemaVersion 1) is a subset of this one except for the three changes
above (anchor shape, hunk marks, drafts and position), so a one-time rewrite of `group.json` and
`review.json` is the only migration; the event logs are never rewritten, only read with the legacy rules.

## The plugin

The plugin changes its store from one JSON file per entity to event logs, and keeps its UI.

1. **Layout**: write `reviews/<review-id>/` with `review.json` and `events/<device-id>.jsonl` inside the
   group, not `<repo-name>/<review-id>/`. Write the exact repository files of SPEC 2.1. Keep the old
   `.state/` outside the group for last-opened pointers and for the device id.
2. **Device id**: generate one per installation, store it in `.state/`, never sync it.
3. **Event log**: write (append, `fsync`, lock, torn-tail repair, per SPEC 5.2) and read (SPEC 5.3) and
   fold (SPEC 7). `ReviewStore` becomes a view over the fold instead of a set of files; `AtomicFiles`
   remains for `review.json` and `group.json`.
4. **Replace the per-file conflict machinery.** `GroupSync`'s `rank`/`.conflict-` logic goes: merge with
   union and the three resolutions of SPEC 9.3. Keep the retry loop and the SSH key support.
5. **`review.json`**: immutable; no `revisions`, no `updatedAt`, no `lastKnownPath`; add `repo.rootCommit`
   (smallest root commit from the head). `saveReview` (rename) becomes `reviewRenamed`.
6. **Update review** becomes retargeting: write `reviewRetargeted`, and stop rewriting comments. For each
   outdated comment compute a suggestion with `Anchoring.locate` (aligned to ALGORITHMS 4: the trim set,
   tie order) and let the user accept it, writing `annotationReanchored`.
7. **Comments**: `Comment` ↔ events by the table below. Show **replies** (the app writes them), at least
   read-only, and do not erase tags or anything else it does not know.
8. **Marks**: replace `viewedFingerprint`/`viewedHunks` by `fileReviewed` (with the file's modes added to
   its `changeKey`, from `git diff --raw`) and region marks. Build ranges from the IDE diff chunks as in
   ALGORITHMS 6. The "all hunks reviewed means the file is reviewed" rule may stay as a tool behaviour
   that emits both events.
9. **Selection across sides** in a unified diff stops collapsing to the clicked line: emit a range per
   side.
10. **Quarantine** only files the plugin itself owns; never rename anything in `events/`.

### Plugin 0.1.0 files → this format

For a one-time import of an old review (also usable by the app to read plugin data). The import must be a
pure function of the old bytes, so two devices importing the same review write the same lines.

| Plugin 0.1.0 | This format |
| ------------ | ----------- |
| `group.json` `{schemaVersion, id, createdAt: ISO}` | `{schemaVersion: 2, id, createdAt: ms}`; `name` omitted |
| folder `<repo-name>/<review-id>/` | `reviews/<review-id>/` (the id is kept; it matches the id rule) |
| `review.json` `repo{name, remoteUrl, lastKnownPath}` | `repo{displayName, originUrl, rootCommit?}`; `lastKnownPath` dropped |
| `mergeBase` | `mode`: `mergeBase` / `direct` |
| `revisions[0]` | `pin`; `baseSha`→`baseTipSha`, `effectiveBaseSha`→`baseSha`, `headSha`→`headSha` |
| `revisions[1..]` | one `reviewRetargeted` per revision, `ts` = the revision's `at` |
| `title`, `createdAt` | `title`, `createdAt` (ms) |
| comment `id` (UUID) | `annotationId` |
| `kind` `CHANGE_REQUEST` / `QUESTION` / `NOTE` | `changeRequest` / `question` / `comment` |
| `status` `OPEN` / `RESOLVED` / `WONT_FIX`, `resolutionNote` | `annotationStatusChanged` `open` / `resolved` / `wontFix` with `note` |
| `body` | `body` |
| `anchor.scope` `REVIEW` / `FILE` / `LINES` | `review` / `file` / `lines` |
| `anchor.path`, `side` `BASE` / `HEAD` | `path` and `oldPath` (identity path from the change set of the anchor's revision), side `old` / `new` |
| `startLine`, `endLine`, `snippet`, `before`, `after` | one range with `snapshot{lines, before, after}` |
| `anchor.revision` n | `anchor.pin` = the pin of revision n |
| `outdated` | dropped (computed) |
| `rule` (text) | tag `rule_candidate` and `ruleText` |
| `createdAt`, `updatedAt` | the `ts` of `annotationCreated` and of an `annotationEdited` if they differ |
| `deletedAt` | `annotationDeleted` with `ts` = `deletedAt` |
| `progress/<key>.json` `viewedFingerprint` | `fileReviewed` if recomputing the plugin's fingerprint (`sha1("STATUS\|old\|new\|oldBlob\|newBlob")`) for the file at the current pin gives the same value, with the new `changeKey`; else dropped (stale) |
| `viewedHunks` | dropped: they are hashes of the IDE's diff chunks and cannot be turned into lines |

Event ids for imported events: `imp-` followed by the first 32 hex characters of
`SHA-256(<review-relative file path> NUL <file bytes> NUL <event type>)`; device `import-v1`; written to
`events/import-v1.jsonl`. Identical input gives identical lines on every device; a later re-import after the
plugin changed the file adds events with different ids that apply as edits (SPEC 7).

Plugin 0.1.0 is released. It keeps working on the old layout and ignores `reviews/`, and a new tool must keep
reading the old layout for as long as 0.1.0 devices are in use, treating it as one more event source. Old
files written by 0.1.0 after an import are picked up by the same rule.

### App events (schema 1, pre-spec) → this format

| App today | This format |
| --------- | ----------- |
| `annotationCreated.anchor` flat `{path, oldPath, side, startLine, endLine, pin, snapshot}` | `{scope: lines or file, path, oldPath, pin, ranges: [{side, startLine, endLine, snapshot}]}`; no `startLine` means scope `file` |
| `hunkReviewed`, `hunkUnreviewed` | ignored (legacy) |
| `draftSaved`, `draftDiscarded`, `positionSaved` | ignored (legacy); local files instead |
| everything else | unchanged |

## Both

1. **Spec home**: put this repository where both projects can reference it (a submodule, or a copy
   checked by a test that compares hashes).
2. **Cross-tool test**: run the app and the plugin as two devices against one bare git remote. Each adds
   comments, replies and marks on the same review (including a drag-selected region across two hunks and a
   two-sided region), syncs both ways, and the two folded states must be equal and equal to the expected
   shape. `tools/sync-experiment.mjs` shows the git side of this with the reference implementation.
3. **Refuse what you do not know**: both check `schemaVersion` and refuse a larger one.
