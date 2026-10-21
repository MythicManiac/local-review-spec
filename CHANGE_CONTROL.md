# Change control

What "frozen" means for this specification, and how it changes from here.

## Two stages

- **Baseline (now).** The text two implementations are built against. It is frozen, but not final: no tool
  has run it yet, and every earlier draft changed because someone checked it against real code. Expect
  findings. The baseline is identified by a git tag (`baseline-1`), by `SPEC_VERSION`, and by
  `MANIFEST.sha256`.
- **2.0 (later).** Declared when both tools pass the cross-tool test (below) with no open findings. After a
  tool has released data in this format, SPEC.md section 11 governs: additive changes are fine, breaking
  changes bump `schemaVersion`.

## What is frozen

The **normative files**, listed with their hashes in `MANIFEST.sha256`: `SPEC.md`, `ALGORITHMS.md`,
`schema/`, `vectors/*.json`, and the example's data (`examples/state`, `examples/expected`,
`examples/content`, `examples/ids.json`).

Not frozen (informative, edit freely, say so in DECISIONS.md when it matters): `README.md`,
`DECISIONS.md`, `CONFORMANCE.md`, `CHANGE_CONTROL.md`, `FINDINGS.md`, `vectors/README.md`,
`examples/README.md`, and everything in `tools/` (the reference implementation changes only to match the
spec; if the two disagree, the vectors and the prose win and the code has a bug).

## Three kinds of change

| Kind | What it is | Who decides | Result |
| ---- | ---------- | ----------- | ------ |
| **Erratum** | Wording, a typo, a contradiction between sections, a missing sentence. No conforming implementation would behave differently, and no vector or example result changes | One developer proposes, the other acknowledges | Edit, regenerate the manifest, tag `baseline-1.1`, `baseline-1.2`, … |
| **Addition to the tests** | A new vector or example case that every conforming implementation already passes | Either developer | As above |
| **Behaviour change** | Anything that makes a conforming implementation fail a vector or example, changes what a tool writes or accepts, or adds a requirement | **Both developers agree**, and the user | A new baseline (`baseline-2`), a new draft entry in DECISIONS.md, regenerated examples, both tools re-run. If either tool has released data in this format, SPEC.md section 11 applies as well |

When in doubt, treat it as a behaviour change.

## How a finding becomes a change

1. A developer who finds a problem while implementing records it in `FINDINGS.md` (what, where, which tool),
   with the smallest example that shows it. Prefer a vector or an experiment to a paragraph.
2. Findings are triaged together after each tool has run the example, not patched one at a time.
3. Each finding is classified as above, decided, and either fixed in a new tag or closed with the reason.
4. `MANIFEST.sha256` is regenerated (`node tools/manifest.mjs --write`) only as part of an accepted change.
   `tools/selftest.mjs` fails if a normative file differs from the manifest, so a change cannot slip in
   unnoticed.

## What each implementation records

- The baseline tag it targets (a line in its own documentation or a constant in its tests).
- A test that runs `node tools/manifest.mjs --root <its copy of the spec>`, or compares the same hashes,
  so it fails when its copy and the tag drift apart.
- The vectors and the example comparison, run in its own language (SPEC.md section 12).

## Exit criteria for 2.0

- Both tools fold and evaluate `examples/` to the expected JSON and pass every case in `vectors/`.
- The cross-tool test passes: the app and the plugin as two devices against one bare remote; each adds
  comments, replies and marks on one review (including a drag-selected region across two hunks and a
  two-sided region), syncs both ways, and the two folded states are equal and equal to the expected shape.
- `FINDINGS.md` has no open item.

## Numbers

Three things carry a number and mean different things. `schemaVersion: 2` is in the data and is what a
reader checks (it changes only for a breaking change). `baseline-N` names a frozen text (it changes with
every accepted behaviour change, before release). "Draft N" is the history of how the text got here and is
kept in DECISIONS.md.
