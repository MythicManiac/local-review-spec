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
| Same-file conflict | abort and report | keep the loser as `<file>.conflict-<hash>` | `group.json` resolved by rule, anything else aborts and reports | With logs there is no same-file conflict to resolve. A side file nobody reads is a silent loss, so it is not offered. |
| Unreadable file | report, never move | rename to `*.corrupt` | report, never move | Moving the user's data changes history on every device. |
| When to sync | manual button | background plus manual | not specified | A policy of the tool, not of the format. Both are safe. |
| SSH key per group | none | per group, stored in the group's git config | optional, in the group's git config | A convenience that does not touch the format. |

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
- **Ambiguity is stale, not nearest.** The user chose "exact relocation (unique, nearest)". The spec keeps
  unique and drops "nearest" **for marks**, because a mark placed on a guessed occurrence reports code as
  reviewed that the reviewer never looked at. "Nearest" is kept where a human confirms the result
  (comment suggestions, ALGORITHMS 4). If you want nearest for marks too, it is one rule in ALGORITHMS 3.1,
  at the cost described there.
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
