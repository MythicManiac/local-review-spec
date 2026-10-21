# Vectors

Small, hand-written test cases for the algorithms, as JSON, so that an implementation in any language runs
exactly the same cases. They are normative where the prose is ambiguous (ALGORITHMS.md: "where this text and
a test vector disagree, the test vector wins").

They are data, not generated: the expected values were derived by hand from the spec (the hash digests with
`sha256sum`), so a bug in the reference implementation cannot hide in them. `tools/selftest.mjs` loads every
file here and runs the reference implementation against it; it was checked by breaking the reference
implementation six ways, each of which the vectors caught.

| File | Algorithm | Input → output |
| ---- | --------- | -------------- |
| `lines.json` | ALGORITHMS 1.1, 1.3: the lines of a blob, or "not text" | bytes → array of lines, or `null` |
| `hash.json` | ALGORITHMS 1.2: hash of lines | lines → SHA-256 hex |
| `trim.json` | ALGORITHMS 1.4: the whitespace set | string → `trim` and `trimEnd` results |
| `intervals.json` | ALGORITHMS 2: coverage intervals | list, range, `add`/`subtract` → list |
| `relocate-mark.json` | ALGORITHMS 3.1: where a reviewed region is now | original lines, mark, current lines → `[start, end]` or `null` |
| `locate.json` | ALGORITHMS 4: where a comment's code is now | anchor range, current lines → `[start, end]` or `null` |
| `repo-files.json` | SPEC 2.1 and 9.3: the `.gitignore` / `.gitattributes` rules | file text(s) → file text |

## Format

Every file is an object with `vector` (its name), `spec` (where the rule is), `about` (how to read the
cases), and `cases` (or, for `repo-files.json`, `append` and `merge`). A case has a `name` and its inputs
and `expected` result, with the field names above.

- **Bytes** (`lines.json`) are a list of parts that are concatenated: `{"utf8": "text"}` is that text as
  UTF-8, `{"hex": "efbbbf"}` is raw bytes, `{"fill": "61", "count": 8000}` is that byte repeated. The result
  is `lines` (an array, or `null` for "not text") or, when the lines are too long to write, `lineCount`.
- **Ranges** are 1-based and inclusive, `[start, end]`. `null` means "cannot be placed" or "no suggestion".
- **Text** in `repo-files.json` is given with explicit `\n` and `\r\n`. A case with `"symmetric": true` must
  give the same result with `ours` and `theirs` swapped.
- JSON strings can carry any code point; `\ud83d\ude00` is U+1F600 (a surrogate pair in the file, one
  character in the string).

## Using them

An implementation reads each file, runs each case through its own implementation, and compares. The
reference runner is the first section of `tools/selftest.mjs`; it is about forty lines. The cases for the
event log itself (folding, evaluation) are not here: they are the example in `examples/`, whose expected
results are in `examples/expected/`.

## Adding a vector

Add a case to the right file with an expected value derived **by hand** from the spec, and a `name` that says
what rule it shows. Do not copy the output of an implementation. If a case shows that the prose is unclear,
fix the prose too. Adding a case that every conforming implementation already passes is always allowed;
adding or changing one that makes a conforming implementation fail is a change to the format (see
CHANGE_CONTROL.md).
