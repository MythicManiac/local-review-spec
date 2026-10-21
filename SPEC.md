# Local Review state format, version 2

This document specifies how review state is stored in a git repository so that more than one tool (a
desktop app, an IDE plugin) can read and write the same reviews through the same git remote.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are used as in RFC 2119.

Companion documents:

- [ALGORITHMS.md](ALGORITHMS.md): the line model, content hashes, relocation of reviewed regions,
  locating a comment's code again. Normative.
- [DECISIONS.md](DECISIONS.md): every design choice and why. Informative.
- [CONFORMANCE.md](CONFORMANCE.md): what the two existing tools must change. Informative.
- `schema/`: JSON Schemas for `group.json`, `review.json` and event lines.
- `examples/`: a reference state directory with expected results, and `tools/`: a reference
  implementation that produces them.

## 1. Model in one page

- A **group** is a git repository. It holds any number of **reviews**, one folder each.
- A **review** compares two points of a code repository, pinned to commit ids. It has a small immutable
  `review.json` and, beside it, one append-only **log** per **device**.
- Everything that happens to a review is an **event** appended to the writing device's log: a comment is
  created, edited, resolved, deleted; a region is marked reviewed; the review is retargeted. Nothing is
  ever rewritten or deleted.
- The current state is the **fold** of all events of all logs in a fixed order. Two devices that have
  seen the same events compute the same state.
- Because a device only ever writes its own log, devices never conflict. Syncing is `git fetch`, `merge`,
  `push`.
- A **comment** (called an annotation in the event vocabulary) is bound to code by **line ranges**, not
  to hunks. A **reviewed mark** is bound to code by line ranges plus a hash of the lines (a **region**),
  not to hunks either. Hunks are only a convenient way for a tool to choose a range.

## 2. Layout

```
<group>/                              a git repository, branch main, remote origin (optional)
  group.json                          required
  .gitattributes                      required, must contain the lines in 2.1
  .gitignore                          required, must contain the lines in 2.1
  reviews/
    <review-id>/
      review.json                     required
      events/
        <device-id>.jsonl             one log per device
        <device-id>.lock              a writer's lock; ignored by git
      local/                          device-local data; ignored by git (section 10)
      exports/                        optional reports; not state; ignored by readers
```

Readers MUST ignore every file and folder they do not know, and no tool may delete or modify them. A
tool MAY add files elsewhere in a review folder; it MUST NOT add files to `events/` other than logs
and its own lock file.

### 2.1 Repository files

`.gitattributes` MUST contain these lines:

```
* -text
*.jsonl merge=union
```

`.gitignore` MUST contain these lines:

```
*.lock
*.tmp
/reviews/*/local/
```

Either file MAY contain other lines before or after them (a tool's own patterns, or lines a group got from
an older tool). Lines are compared exactly after removing one trailing `\r`, and a required line may sit
anywhere in the file. A line appended by a tool comes last, so nothing that was already in the file
overrides it; a pattern the user wrote after a required line is the user's choice and is not touched.

Why: `* -text` keeps log bytes exact on machines with `core.autocrlf=true` (verified, see
`tools/sync-experiment.mjs`); `merge=union` is git's built-in driver that keeps both sides' lines when
the same log was appended to on two machines; the ignore rules keep locks, temporary files and
device-local data out of history.

**Creating a group.** A tool MUST write both files containing exactly the lines above, in this order, each
line ending in `\n`.

**Opening a group.** A tool MUST check both files. If a file is missing it MUST create it as for a new
group. If a file lacks some required lines it MUST append the missing ones, in the order above, at the end
(first adding `\n` if the file does not end with one) and commit the change. It MUST NOT remove, reorder or
rewrite any other line. The point is groups made by older tools, which have a `.gitignore` of only
`*.tmp` and no `.gitattributes`: without the missing lines, lock files and device-local data would be
committed and synced. Two devices that append the same lines independently merge without conflict; if they
also added different lines of their own at the same place, 9.3 says how that conflict is resolved
(`tools/sync-experiment.mjs`, experiments 5a and 5b).

A tool MAY also write the three ignore patterns to the clone's `.git/info/exclude`, which is never synced,
so that the clone is protected before an appended `.gitignore` arrives from another device.

### 2.2 Review discovery

A review is a folder `reviews/<id>/` containing a readable `review.json`. A folder whose `review.json`
is missing or invalid is reported to the user and skipped; it is never modified. A `review.json` whose
`schemaVersion` is below 2 was written by an older tool in its own layout (see CONFORMANCE.md): it is
reported as an older format, skipped, and never modified, even when it sits where a version 2 review would.

## 3. Values

| Kind      | Rule                                                                                                     |
| --------- | -------------------------------------------------------------------------------------------------------- |
| Id        | A string matching `^[A-Za-z0-9_-]{1,64}$`. Group, review, device, event, annotation and reply ids. Opaque. A ULID is recommended for everything generated by this format; a reader MUST accept any matching string (an older tool's `20261014-1530-my-review` is valid). |
| Time      | An integer: milliseconds since the Unix epoch, UTC.                                                      |
| Commit id | 40 or 64 lowercase hexadecimal characters, in full.                                                      |
| Path      | A repository-relative path as git prints it, with `/` separators, as UTF-8. The path is data: a tool MUST NOT use it to read anywhere but inside the reviewed repository. |
| Side      | `old` (the base side of the diff) or `new` (the head side).                                              |
| Line      | A 1-based line number, interpreted with the line model in ALGORITHMS.md section 1.                       |
| Hash      | 64 lowercase hexadecimal characters: SHA-256 of a run of lines (ALGORITHMS.md section 1).                |
| Text      | UTF-8 strings. `body` fields are Markdown.                                                               |

A review folder name MUST equal the review's `id`. A path in a path-typed field MUST NOT be empty.

## 4. `group.json` and `review.json`

Both are JSON, written once when the group or review is created, and never rewritten. (The one exception
is a tool converting an older tool's `group.json`, which sits at the same path; CONFORMANCE.md says how.)
Readers ignore unknown properties. Both carry `schemaVersion`, which is `2` for this format; a tool that
meets a larger number MUST refuse the group or review, saying that a newer version of the format wrote it,
and MUST NOT change it. See `schema/group.schema.json` and `schema/review.schema.json`.

```json
{ "schemaVersion": 2, "id": "01M4XB…", "name": "Example Group", "createdAt": 1791873600000 }
```

`name` is optional; the folder name is the fallback. A tool MUST NOT keep a group's `id` as its only
handle on the group, because the id can change when two groups are joined (9.3).

```json
{
  "schemaVersion": 2,
  "id": "01M4XBCYR0AQJREYKYGS5WNERF",
  "title": "Add calc module",
  "createdAt": 1791986400000,
  "createdBy": "<device-id>",
  "repo": { "displayName": "calc-demo", "originUrl": "https://…/calc-demo.git", "rootCommit": "<sha>" },
  "baseRef": "master",
  "headRef": "feature/calc",
  "mode": "mergeBase",
  "pin": { "baseSha": "<sha>", "baseTipSha": "<sha>", "headSha": "<sha>" }
}
```

- `pin.baseSha` is the left side of the diff: the merge-base of base and head in `mergeBase` mode, the
  base tip in `direct` mode. `pin.baseTipSha` is what the base ref resolved to. `pin.headSha` is the head.
- `title` and `pin` are the values at creation. `reviewRenamed` and `reviewRetargeted` events supersede
  them (section 7).
- `repo.rootCommit` is the lexicographically smallest root commit reachable from the head, or null.
  `repo.originUrl` is the origin URL or null.
- A machine path MUST NOT be stored in a synced file.

### 4.1 Finding the clone of a reviewed repository

To decide which local repository a review refers to, a tool compares, in this order, and stops at the
first comparison both sides can make: `rootCommit` (equal), then `originUrl` after normalisation (equal),
then `displayName` (equal). The normalisation is: trim whitespace, remove a trailing `/`, remove a
trailing `.git`, lowercase. Where a clone lives is device-local knowledge and is never written to the
group.

## 5. Device logs

`reviews/<id>/events/<device-id>.jsonl` holds one JSON object per line, UTF-8, each terminated by `\n`.

```json
{"v":1,"id":"01M4…","ts":1791986460000,"dev":"01M3…","seq":1,"ev":{"type":"annotationCreated", …}}
```

| Field | Meaning                                                                                              |
| ----- | ---------------------------------------------------------------------------------------------------- |
| `v`   | Version of the envelope: `1`. It is not the version of the event vocabulary.                          |
| `id`  | A unique id across all logs of the review. A second event with the same id is ignored.               |
| `ts`  | Time in milliseconds. Strictly increasing within one log.                                            |
| `dev` | The writing device; equals the file name's `<device-id>`.                                            |
| `seq` | 1, 2, 3 … within one log. It orders events with equal time; readers MUST NOT require it contiguous.  |
| `ev`  | The event: an object with a `type` and the fields of that type (section 6).                          |

### 5.1 Devices

A **device** is one installation of one tool on one machine. Its id is generated once, kept in the tool's
own device-local configuration, and never synced. Two tools on the same machine MUST have two device ids;
a device id MUST NOT be copied to another machine, restored from a backup onto another machine, or
shared between tools. (If it happens anyway, the union merge in 2.1 and the fold in section 7 still
produce a correct state: no event is lost and none is applied twice.)

**Hosts.** One tool may run in several hosts on one machine (the same IDE plugin in two IDEs, or in two
versions of one IDE). A tool MAY give each host its own device id, or MAY keep one id per machine and share
it between its hosts. Hosts that share an id MUST take the lock of 5.2 step 1 for every review they write
to, and a host that cannot take it MUST treat that review as read-only until it can (it still reads and
shows the review, including what the other host wrote). Within one host, everything that writes to one
review (several windows or projects) MUST go through one holder of that lock. The id of a tool is never
shared with a different tool.

### 5.2 Writing

A writer MUST, for each event:

1. hold exclusive write access to its own log (an operating-system lock on `<device-id>.lock` or on the
   log itself); a second instance of the same device MUST be refused, not allowed to interleave;
2. start the event on a new line: if the file does not end in `\n` (a previous write was cut off), write
   `\n` first;
3. append the JSON object and `\n`, flush to the operating system, and `fsync`;
4. tell the user the change is saved **only after** the `fsync` returned.

A writer MUST NOT rewrite, truncate, reorder or delete lines of any log, its own included. Corrections
are new events. A writer MUST give every event a new unique `id` and a `ts` greater than that of its
previous event, even if the clock went backwards.

### 5.3 Reading

A reader MUST NOT fail because of the content of a log. It MUST handle, and count for reporting:

| Condition                                                           | Handling                                                     |
| ------------------------------------------------------------------- | ------------------------------------------------------------ |
| `\r\n` line ends, blank lines                                       | One trailing `\r` is dropped; blank lines are skipped        |
| The last line has no `\n` and is not valid JSON (a torn write)      | Ignored; counted as a torn tail                              |
| Any other line that is not valid JSON                               | Skipped; reported with file and line number                  |
| Valid JSON that is not a valid envelope                             | Skipped; counted                                             |
| An `id` seen before (in any log)                                    | Skipped; counted as a duplicate                              |
| An event type from the legacy list (6.1)                            | Skipped; counted as legacy                                   |
| An event type this reader does not know, or an event whose required field is missing or has an unknown enum value | Skipped; counted as unknown. The line stays in the file untouched |
| An event that refers to an annotation or reply that does not exist  | Skipped; counted as an orphan                                |
| Unknown properties in a known event or in the envelope              | Ignored                                                      |

A reader MUST NOT modify a log in response to any of these. It SHOULD make the counts visible to the
user, since a non-zero count means data the reader could not use.

## 6. Events

All events have the envelope above and an `ev` object whose `type` is one of the following. Fields marked
optional may be absent. `schema/event.schema.json` is the formal definition.

| `type`                    | Fields                                                              | Effect (section 7)                                     |
| ------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------ |
| `reviewRenamed`           | `title`                                                             | Sets the title                                         |
| `reviewStatusChanged`     | `status`: `open`, `done`, `archived`                                | Sets the review status                                 |
| `reviewRetargeted`        | `pin`                                                               | Sets the current pin                                   |
| `annotationCreated`       | `annotationId`, `kind`, `tags`, `body`, `anchor`; optional `ruleText` | Creates a comment                                      |
| `annotationEdited`        | `annotationId`; optional `body`, `kind`, `tags`, `ruleText`         | Changes the fields present; `ruleText: null` clears it |
| `annotationStatusChanged` | `annotationId`, `status`: `open`, `resolved`, `wontFix`; optional `note` | Sets status and note together                     |
| `annotationReanchored`    | `annotationId`, `anchor`; optional `method`: `picked`, `suggestion` | Replaces the anchor                                    |
| `annotationDeleted`       | `annotationId`                                                      | Tombstones the comment                                 |
| `annotationRestored`      | `annotationId`                                                      | Removes the tombstone                                  |
| `replyAdded`              | `annotationId`, `replyId`, `body`                                   | Adds a reply                                           |
| `replyEdited`             | `annotationId`, `replyId`, `body`                                   | Changes a reply's text                                 |
| `replyDeleted`            | `annotationId`, `replyId`                                           | Tombstones a reply                                     |
| `replyRestored`           | `annotationId`, `replyId`                                           | Removes the tombstone                                  |
| `fileReviewed`            | `path`, `changeKey`                                                 | Marks the whole file change reviewed                   |
| `fileUnreviewed`          | `path`                                                              | Clears that mark                                       |
| `regionReviewed`          | `path`, `ranges`                                                    | Marks lines reviewed                                   |
| `regionUnreviewed`        | `path`, `ranges`                                                    | Clears lines                                           |
| `ruleDecided`             | `annotationIds`, `targetPath`, `decision`: `applied`, `dismissed`   | Records what became of rule candidates                 |

### 6.1 Legacy types

`draftSaved`, `draftDiscarded`, `positionSaved`, `hunkReviewed` and `hunkUnreviewed` were written by the
app before this format. They have no meaning in it and are ignored whatever their content (drafts and
position are device-local now, section 10; hunk marks are replaced by regions). A tool that wrote them
MAY convert them, but only the tool that understands them can: a hunk hash cannot be turned into lines.

### 6.2 Comments

- `kind`: `changeRequest`, `question`, `comment`.
- `tags`: an array of unique strings. The tag **`rule_candidate`** flags a comment as a recurring problem
  that should become a rule in an agent-instruction file such as `AGENTS.md`.
- `ruleText`: an optional rule the reviewer wrote. It is independent of the tag: a tag without text asks a
  tool (or a model) to draft the rule; text without the tag is allowed and means the reviewer wrote it
  but did not flag it for collection.
- `ruleDecided` removes comments from the "waiting" set of a tool's rules inbox. A comment is waiting when
  it has the tag and no decision.
- `wontFix` is a closed status like `resolved`; a tool that has no use for the difference shows both as
  closed. `note` explains a status change and belongs to it: a later status change without a note clears
  the note.

### 6.3 Anchors

An anchor says where a comment sits. It has a `scope`:

| `scope`   | Fields                                | Meaning                                                           |
| --------- | ------------------------------------- | ----------------------------------------------------------------- |
| `review`  | none                                  | About the review as a whole. No code is involved.                 |
| `file`    | `path`, optional `oldPath`, `pin`     | About one changed file as a whole.                                |
| `lines`   | `path`, optional `oldPath`, `pin`, `ranges` | About lines of one changed file.                            |

- `path` is the file's identity in the diff: its new path, or its old path if the file was deleted.
  `oldPath` is present only if the old side has a different path (a rename).
- `pin` is the three commits the anchor's line numbers are valid for. It is stored on the comment so the
  comment still says what it was written about after the review moves on.
- `ranges` has one or two entries, at most one per side:

  ```json
  { "side": "new", "startLine": 13, "endLine": 15,
    "snapshot": { "lines": ["…"], "before": ["…"], "after": ["…"] } }
  ```

  `endLine` is inclusive and not before `startLine`. `snapshot.lines` is exactly the text of those lines
  when the comment was written; `before` and `after` are up to 3 lines of context each side. A comment
  can therefore cover a drag selection across several hunks (one range on one side), or a selection that
  spans removed and added lines (one range on each side). The two ranges are independent: each is
  checked and located on its own side.

- A `lines` anchor MUST only be made on a text file (ALGORITHMS.md section 1.3), with line numbers inside
  the file. A tool MAY limit the length of a range it creates (the app's limit is 500 lines); readers
  MUST accept any length.

An anchor is **bound to hunks nowhere**. A tool may derive a range from a hunk, but the stored anchor does
not mention hunks and does not depend on how any tool computes them.

### 6.4 Reviewed marks

There are two kinds of mark, and they are independent facts.

**File marks** (`fileReviewed`, `fileUnreviewed`) say the whole change to a file was reviewed. They are
the only way to review a file with no lines to select (a binary file, a mode change, a deletion, a
rename without edits). `changeKey` is `oldMode:newMode:oldBlob:newBlob` as git reports the file's
change (`000000` and an all-zero blob id for an absent side). The mark is valid while the file's change
has the same `changeKey`, and stale otherwise.

**Region marks** (`regionReviewed`, `regionUnreviewed`) say some lines are reviewed. Each of their one or
two `ranges` is:

```json
{ "side": "new", "startLine": 9, "endLine": 11, "blob": "<git blob id>", "hash": "<sha-256>" }
```

`blob` is the git blob id of that side's file; the line numbers are valid for exactly that content.
`hash` is the hash of those lines. A mark follows its lines when the file changes; section 8 and
ALGORITHMS.md section 3 say how.

A mark is **not** attached to a hunk. A tool that offers "mark this hunk reviewed" computes the changed
lines of the hunk by its own means and emits one range per non-empty side. A tool that shows hunk
progress shows a hunk as reviewed when every changed line of it is covered. Hunks differ between tools
and between diff settings (whitespace, context), and that does not matter, because only line ranges are
stored.

`fileUnreviewed` clears the file mark only; it does not touch region marks. A tool whose "unreview file"
should also clear regions emits the region events as well. Likewise a tool MAY emit `fileReviewed`
automatically when its regions cover every changed line of a file; it never has to.

## 7. The fold

The state of a review is a pure function of `review.json` and the set of events in all its logs.

**Order.** Events are sorted by `ts`, then `dev`, then `seq` (numbers numerically, strings by their UTF-8
bytes), then `id`. Events with an `id` already seen are dropped, keeping the first in this order. Events
that are legacy (6.1) or not valid events (5.3) are then dropped and counted.

**Phases.** Valid events are applied in three passes over that order:

1. every `annotationCreated`: the first for an annotation id creates the annotation;
2. every `replyAdded`: the first for a reply id creates the reply (the annotation must exist, else orphan);
3. all remaining events, one at a time, **last writer wins** per field.

Creations come first so that an edit stamped by a slow clock with a time before its target's creation is
not lost. A creation for an id that already exists (a later `annotationCreated` for the same
`annotationId`, or `replyAdded` for the same `replyId`) is not a new thing: in pass 3 it applies as an edit
of `kind`, `tags`, `body`, `ruleText` and `anchor` (for a reply, `body`) at its own place in the order. This
makes re-importing the same review from another source idempotent.

**Effects.**

| Event                                  | Effect                                                              |
| -------------------------------------- | ------------------------------------------------------------------- |
| `reviewRenamed`, `reviewStatusChanged`, `reviewRetargeted` | Set title, status, current pin                  |
| `annotationEdited`                     | Each present field replaces the old one                             |
| `annotationStatusChanged`              | Sets `status` and `note` (an absent note clears it)                 |
| `annotationReanchored`                 | Replaces the anchor                                                 |
| `annotationDeleted` / `Restored`       | Sets / clears the tombstone; the last one in order wins             |
| `replyEdited`, `replyDeleted`, `replyRestored` | As above for a reply                                        |
| `fileReviewed` / `fileUnreviewed`      | Sets or removes the file mark for the path                          |
| `regionReviewed` / `regionUnreviewed`  | Appended, in order, to the region events (evaluated in section 8)   |
| `ruleDecided`                          | Sets the decision on each listed comment that exists                |

A tombstoned comment is hidden by default and restorable; its replies and history are kept.

**Reference state.** Implementations MAY use any internal representation. For testing, the reference
implementation produces this shape (see `examples/expected/`): `review` (the `review.json` fields, with
the title, status and pin after events), `annotations` sorted by creation time then id (each with `id`,
`kind`, `tags`, `body`, `ruleText`, `status`, `statusNote`, `deleted`, `createdAt` and `createdBy` from the
creating event, `updatedAt` as the latest time of any event that addressed it, `anchor`, `ruleDecision`,
and `replies`), `fileMarks`, `regionEvents`, and a `report` of the counts in 5.3.

## 8. Evaluating against the code

Marks and anchors are checked against the files at the review's **current pin**. This needs the reviewed
repository. A tool that does not have it on the current device MUST show marks and anchor states as
unverified, never as valid or stale.

**Change set.** The change set is the files changed between `pin.baseSha` and `pin.headSha`, as
`git diff --raw -z -M --no-abbrev --no-ext-diff <baseSha> <headSha> --` reports them, each with its
modes, blob ids and, for a rename, both paths. The identity `path` of a file is its new path, or its old
path if deleted. The **new side** of a file is the blob `newBlob` (absent if the file was deleted); the
**old side** is `oldBlob` (absent if the file was added).

**File marks.** A mark is `valid` if the path is in the change set and its `changeKey` equals the mark's;
`stale` if the path is in the change set with a different key; `gone` if the path is not in the change set.

**Region marks.** Marks are evaluated per path and side by the algorithm in ALGORITHMS.md section 3. The
result is, for each path and side, the line ranges that are **reviewed** now (in the current file's line
numbers) and the ranges that are **stale** (reviewed once, but those lines no longer exist, or cannot be
placed unambiguously). A tool MUST NOT show a stale or ambiguous range as reviewed, and MUST NOT guess.

**Comments.** For each comment the state is computed, never stored:

| State       | When                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------ |
| `current`   | The scope is `review`, or the anchor's `pin` equals the review's current pin (all three commits) |
| `unchanged` | Otherwise, and the file is still in the change set, and for a `lines` anchor each range's `snapshot.lines` equals the lines at the same numbers of that side now |
| `outdated`  | Otherwise                                                                                        |

For an `outdated` `lines` anchor a tool computes a **suggestion** with ALGORITHMS.md section 4: a position
for each range. A suggestion exists only if every range was located. **A suggestion is never applied by
itself.** The tool shows it, and if the user accepts it, writes `annotationReanchored` with the suggested
ranges, a fresh snapshot and the current pin, and `method: "suggestion"`. If the user picks lines
themselves the method is `picked`. An outdated comment keeps its stored snapshot, shown as the code it was
written about.

## 9. Git and syncing

### 9.1 Repository

The branch is `main` and the remote, if any, is `origin`. Credentials and SSH configuration are the user's
git configuration; a tool MAY additionally let the user choose an SSH identity per group, stored in the
group's own `.git/config` (never in a synced file).

### 9.2 Commits

A tool commits its changes with `git add -A` and a commit using `--no-verify --no-gpg-sign`, debounced
after writes and when it closes. The author is the user's configured git identity if there is one, else
`Local Review <local-review@localhost>`. A failed commit never loses data (the files are already durable)
and MUST be reported. A tool MUST NOT commit while another tool's git operation holds `index.lock`; it
retries briefly.

### 9.3 Sync

Sync is: commit pending changes, `git fetch --prune origin`, `git merge --no-edit
--allow-unrelated-histories origin/main`, `git push origin HEAD:refs/heads/main`. If the push is rejected
because the remote moved, the tool repeats from the fetch, at most three times, and then reports the
failure. When to sync (automatically, on a button, on opening a review) is the tool's choice and is not
part of this format.

Merges are conflict-free by construction (devices write only their own logs, and `*.jsonl` uses the
union driver). A merge may still conflict in exactly these cases, which a tool MUST resolve as follows:

| Conflicted path   | Resolution                                                                              |
| ----------------- | --------------------------------------------------------------------------------------- |
| `group.json`      | Two groups created apart were joined. Keep the file with the smaller `createdAt`; on a tie the smaller `id` by UTF-8 bytes. A `createdAt` that is not an integer (an ISO-8601 string from an older tool) is converted; if it cannot be, it loses. Both devices make the same choice. |
| `.gitattributes`, `.gitignore` | Write the required lines of 2.1 in their order, then every other line of either version (blank lines and duplicates removed), sorted by UTF-8 bytes; every line ends in `\n`. Both devices write the same bytes. (Such a conflict arises when two devices each added different lines at the end of the same file, for example while bringing an older group up to 2.1.) |
| anything else     | `git merge --abort`. Report the path and leave the user's data exactly as it was. A tool MUST NOT choose a winner and MUST NOT keep a loser as a side file: there is no case in which dropping or hiding one side is correct. |

After a successful pull a tool re-reads the reviews that changed and updates what the user sees.

### 9.4 More than one tool on one machine

Two tools MAY share one clone of a group on one machine. Each has its own device id and writes only its
own log, so their writes do not collide. Each SHOULD watch `reviews/<id>/events/` for changes and re-read
when another process has appended.

### 9.5 The reviewed repository

A tool does not need to write to the reviewed repository. A tool that must keep pinned commits from being
collected after a branch is rebased or deleted MAY create refs named `refs/local-review/<review-id>/<commit id>`
there, and no other refs; other tools recognize that namespace and leave it alone.

## 10. Device-local data

Unsent comment drafts, the reading position, and anything else a tool keeps per device live in
`reviews/<id>/local/<device-id>/`. The folder is ignored by git (2.1) and never synced. Its content is
private to the tool that wrote it and is not specified; other tools MUST NOT read or modify it. A tool
saving a draft MUST still `fsync` it before reporting it saved.

## 11. Evolution

- A new event type, a new optional field, or a new enum value is additive: a reader that does not know it
  skips the event and counts it (5.3) and nothing breaks. Writers add such things freely, and SHOULD say
  in their documentation which readers will not see them.
- A change to the meaning of an existing event, field or rule is breaking and bumps `schemaVersion` in
  `group.json` and `review.json`. A tool refuses what it does not understand (section 4).
- The envelope version `v` only changes if the line framing changes.
- A plugin or app that predates a version can neither read nor protect itself against it, so breaking
  changes should be rare and announced.

## 12. Conformance

A **conforming reader** implements sections 3 to 8 and passes `tools/selftest.mjs`'s equivalent for its
language: the fold of `examples/state` equals `examples/expected/*.json`. A **conforming writer** also
implements 5.2, 6 and 9.2, and emits only what `schema/` allows. A **conforming tool** is both and meets
section 9 and 10.

Test vectors for the algorithms are in `tools/selftest.mjs`. They are small, hand-derived, and are the
authoritative answer where the prose is ambiguous.
