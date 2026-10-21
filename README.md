# Local Review: shared state format

A specification, and a runnable reference, for storing code-review state in a git repository so that
different tools (the standalone **Local Review** app, the **Local Diff Review** IDE plugin) can read and
write the same reviews through the same git remote.

Status: **draft 4**, written before either tool implements it. Nothing here has been run by those tools.
What has been run is the reference implementation in `tools/`, against the example in `examples/`.
Draft 4 fixed the `.gitignore`/`.gitattributes` conflict rule (git applies the last matching line), added a
check that git honours the required rules, put the writer's lock on the `.lock` file only, and removed
everything that existed only to read the app's earlier format (it held no real data). See "Changes since
draft 3" in DECISIONS.md.

## What it is, in short

- A **group** is a git repository holding many **reviews**, one folder each.
- A review is a small immutable `review.json` plus one **append-only log per device**
  (`events/<device-id>.jsonl`). The state is the fold of all events. Devices never write the same file,
  so syncing never conflicts.
- **Comments** are bound to code by line ranges, up to one range per side, so a comment can cover a
  drag selection across hunks, or a selection spanning removed and added lines.
- **Reviewed marks** are line ranges plus a hash of the lines (**regions**), so progress survives edits
  elsewhere in the file and does not depend on how any tool computes hunks. A whole-file mark covers files
  with no lines to select.
- When the review moves to new commits, nothing moves by itself: outdated comments get a **suggested**
  position that the user accepts or ignores.
- Drafts and the reading position are device-local and never synced.

## Read in this order

| File | What |
| ---- | ---- |
| [SPEC.md](SPEC.md) | The format: layout, files, events, the fold, evaluation, git and sync. Normative. |
| [ALGORITHMS.md](ALGORITHMS.md) | Line model, hashing, relocating a reviewed region, locating a comment's code. Normative. |
| [DECISIONS.md](DECISIONS.md) | Every choice and why; what the user decided; where the two tools differed and which won. |
| [CONFORMANCE.md](CONFORMANCE.md) | What the app and the plugin each have to change; the mapping from each tool's current files. |
| `schema/` | JSON Schemas: `group`, `review`, `event` (envelope and every event type). |
| `examples/` | A reference state directory and the expected results. See [examples/README.md](examples/README.md). |
| `tools/` | The reference implementation and the tests. |

## Try it

Needs Node 20 or newer (and git, only to rebuild the fixture or run the sync experiment). No packages.

```
node tools/selftest.mjs                       # 55 checks: algorithms, text and repository-file rules, the example, expected/ is current
node tools/sync-experiment.mjs                # real git: 10 experiments (union merge, joining groups, autocrlf, older groups, effective rules)
node tools/fold.mjs examples/state/reviews/<id> --content examples/content    # fold and evaluate a review
```

`examples/ids.json` names the review ids. To regenerate everything (it is deterministic):

```
node tools/make-fixture.mjs                   # the reviewed repo: commits, blobs, changesets
node tools/make-example.mjs                   # the state directory and examples/expected/
```

## Layout of this repository

```
SPEC.md  ALGORITHMS.md  DECISIONS.md  CONFORMANCE.md
schema/      group.schema.json  review.schema.json  event.schema.json
examples/
  state/       a group directory, exactly as it would sit on disk (two reviews)
  content/     the reviewed repository, as data: commits, changesets, blobs, a git bundle
  expected/    what a conforming implementation computes from state/ (+ content/)
  ids.json     the ids used in the example
tools/
  lib.mjs  fold.mjs                reference fold and evaluator
  make-fixture.mjs  make-example.mjs  generators
  selftest.mjs  sync-experiment.mjs  tests
  repocheck.mjs                    asks git whether the required .gitignore/.gitattributes rules are honoured
```

## What is not specified

User interface, gestures and wording; when to sync; export formats; how a model drafts agent rules; where a
tool keeps its configuration; authentication. Those stay with each tool.

## License

Apache License 2.0, see [LICENSE](LICENSE). The specification, the examples and the reference implementation may be copied into
the projects that implement the format (the standalone app, the IDE plugin) under that license.
