# The example

`state/` is a group directory as it would sit on disk after two tools used it. Point an implementation at
`state/reviews/<id>/` and the reviewed repository in `content/`, compute the state, and compare with
`expected/`.

## Contents

```
state/                          the group (a real group would be a git repository; this is its working tree)
  group.json  .gitattributes  .gitignore
  reviews/
    01M4XBCYR0AQJREYKYGS5WNERF/     the main review: both devices, every feature, a retarget in the middle
      review.json
      events/<app device>.jsonl       written by "the app"
      events/<plugin device>.jsonl    written by "the plugin"
    20261014-1530-edge-cases/       log mechanics only: damage, duplicates, unknown events
content/                        the reviewed repository, without needing git
  commits.json                    master, and the feature branch at round one and round two
  changesets.json                 per pin (`base..head`): the changed files with modes and blob ids
  blobs/<blob id>                 the bytes of every blob a changeset mentions
  fixture.bundle                  the repository itself, for tests that want real git
expected/
  main.json                       { fold, evaluated } for the main review
  edge-cases.json                 { fold } for the edge-case review
ids.json                        the ids above, and the annotation ids by name
```

`state/` has no `local/` or `exports/` folders: `local/` is ignored by the group's `.gitignore`, which
also applies when this directory is committed here.

## The reviewed repository

Three commits, built with fixed dates so the ids are the same everywhere (`tools/make-fixture.mjs`):
`master`, then `feature/calc` at round one (adds `mul` and `div`, renames `util_old.ts` to `util.ts`,
deletes `legacy.ts`, adds `extra.ts`, edits the README and a binary file), then at round two (adds a
header, which shifts every line of `calc.ts` down, and guards the division).

`calc.ts` at round one has 18 lines; the interesting ones are 1-3 `add`, 5-7 `sub`, 9-11 `mul`, 13-15 `div`,
17 `VERSION`. At round two the header moves everything down by 2 and the guard adds a line, so `VERSION` is
line 20.

## The main review, scenario by scenario

The review is created at round one, then **retargeted to round two** in the middle. Comments and marks
made before the retarget refer to round one; those made after refer to round two.

| What | Where to look | Expected |
| ---- | ------------- | -------- |
| Two devices write one review | both `events/` files | one state; order by `(ts, dev, seq, id)` |
| A comment on `div` with the `rule_candidate` tag and a rule text; edited by the other device; a conversation; a reply that was written and removed | `Division by zero…` | body edited; 3 replies, the last tombstoned; rule decision `applied` to `AGENTS.md`; **outdated, no suggestion** (the lines changed) |
| A comment whose lines only moved | `Looks fine.` (mul 9-11) | **outdated, suggestion new 11-13** |
| A comment with a range on each side | `Why bump the minor version?` (old 9 and new 17) | resolved with a note; **outdated, suggestion old 9-9 and new 20-20** (ranges located independently) |
| A comment on a file the retarget did not touch | `Nit: link the docs page.` | **unchanged** |
| A comment on a whole file, a rule candidate without a decision | `Is this helper used anywhere?` | scope `file`; **unchanged** |
| A review-level comment | `Please describe how to run the demo…` | scope `review`, no path; **current** |
| A comment on the old side of a renamed file | `Is noop still needed?` | path `src/util.ts`, `oldPath` `src/util_old.ts`; `wontFix` with a note; **unchanged** |
| A comment that was moved by accepting a suggestion | `sub could reuse add…` | re-anchored after the retarget with method `suggestion`; **current** |
| A comment on a deleted file, then deleted | `Remove the legacy flag.` | tombstoned (`deleted: true`) |
| A comment deleted, then restored | `Add a doc comment.` | not deleted; **outdated, suggestion new 3-5** |
| Review title, status handed back and forth | review level | title `Add calc module (round 2)`, status `done` |

Marks, all on `src/calc.ts` unless stated:

| Mark | Expected after the retarget |
| ---- | --------------------------- |
| `add` (1-3) reviewed at round one | still reviewed, **relocated to 3-5** |
| `mul` (9-11) reviewed, then its middle line (10) unreviewed | reviewed lines **11 and 13** (the split follows the move) |
| `div` (13-15) reviewed at round one | **stale**: the lines were edited |
| `VERSION` (17) reviewed alone | relocated to 20 |
| the blank line 8 reviewed | **stale**: a blank line is not unique, so it is not guessed |
| a hunk's two ranges, old 9 and new 17, in one event | old side reviewed at 9, new side at 20 |
| `div` reviewed again at round two (15-18) | reviewed at 15-18, alongside the old stale range |
| `util.ts` 1-3 | unchanged, still reviewed |
| file mark on `README.md` (set, cleared, set again) | **valid** |
| file mark on `src/calc.ts` | **stale** (the change differs) |
| file mark on `assets/logo.bin` (binary) | **valid** |
| file mark on `src/legacy.ts`, then cleared | no mark |

## The edge-case review

Nothing about code. Each line below is deliberate:

| Case | Where | Expected |
| ---- | ----- | -------- |
| The same event in two logs | `dup-0000000001` in two files | applied once; 1 duplicate |
| CRLF line ends | the second device's log | read normally |
| A type no reader knows; a known type with an extra field; a known type with an unknown enum value | second log | unknown type and bad enum counted (2) and ignored; the extra field ignored, the event applied |
| An event addressed to something that does not exist | `annotationDeleted` for `no-such-annotation` | 1 orphan |
| An edit timestamped before the creation it edits | `eb-0001` | still applied |
| The same annotation created again later | `eb-0009` | applies as an edit: body `re-imported`, kind `question` |
| A damaged line in the middle, a line that is not an envelope, a cut-off last line | third log | 1 corrupt line, 1 invalid envelope, 1 torn tail; the events around them are applied |

## Using it

An implementation passes when, for the main review, its folded state matches `expected/main.json`'s `fold`
and, with `content/`, its evaluation matches `expected/main.json`'s `evaluated`; and for the edge-case
review its fold and its counts match `expected/edge-cases.json`. The state shape is in SPEC 7; an
implementation may represent it differently as long as the same facts come out.

`node tools/selftest.mjs` makes the same assertions about the reference implementation, written by hand
from the spec rather than copied from the output, plus vectors for the algorithms.
