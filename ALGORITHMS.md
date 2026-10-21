# Algorithms

Normative. Every tool that evaluates marks or anchors implements these so that the same state gives the
same answer in every tool. The reference implementation is `tools/lib.mjs`; the hand-derived test vectors
are in `tools/selftest.mjs`. Where this text and a test vector disagree, the test vector wins and this
text has a bug.

## 1. Line model and hashing

### 1.1 Lines

The lines of a text file (1.3) are obtained from its content, the bytes of the git blob:

1. decode as UTF-8; if the content starts with the byte order mark (EF BB BF), drop it: it is not part of
   line 1;
2. split at every LF and nothing else (U+2028, U+0085 and the like are ordinary characters; a CR alone
   cannot occur in text, 1.3);
3. remove one CR from the end of each piece, if there is one;
4. if the content ended with LF, the final empty piece is **not** a line.

So `"a\nb\n"` and `"a\r\nb"` both have the lines `a`, `b`; `""` has no lines; `"\n"` has one empty line.
A line number is the 1-based index into that sequence. There is no line after a final newline: an anchor
or a region cannot refer to it, whatever an editor displays there. (Monaco shows an empty last line; a tool
built on it must not offer it for annotation.)

A tool MUST derive the lines of a side from the blob's bytes by these rules, never from the document of an
editor or diff viewer: those apply their own charset detection, byte order mark handling and line
splitting, and a snapshot or hash computed from them would differ from another tool's. A tool whose viewer
shows different line numbers than these rules give for a file MUST NOT offer line comments or region marks
on that file (it can still offer a file comment and a file mark).

### 1.2 Hash of lines

`hashLines(lines)` is the SHA-256, as 64 lowercase hexadecimal characters, of the bytes obtained by
writing each line in UTF-8 followed by one `\n`. A different split of the same characters gives a
different hash (`["a","b"]` is not `["ab"]`). No normalisation of whitespace or case is applied.

### 1.3 Text files

A file is **text** if all of these hold for its content (the bytes of the git blob):

1. it has no NUL byte in its first 8000 bytes;
2. the whole content is well-formed UTF-8 as defined by RFC 3629 and the Unicode Standard: no overlong
   forms, no encoded surrogates, nothing above U+10FFFF. A byte order mark at the start is allowed;
3. every CR (U+000D) is directly followed by LF. (CRLF line ends are fine; a CR alone is not.)

Only text files have lines. Anchors with `lines` scope and region marks exist only for text files. Any
other file is reviewed with a file mark and commented on with a `file` anchor, like a binary.

Why rules 2 and 3: with invalid UTF-8, decoders disagree on how many replacement characters one broken
sequence becomes, so there is no single line model; and editors disagree on whether a lone CR ends a line
(IntelliJ and Monaco split on it, git does not), so the same file would have different line numbers in
different tools. A file that is not text under these rules has no line numbers to disagree about.

### 1.4 Whitespace for matching

Where a rule says "trim", the whitespace set is exactly U+0009, U+000B, U+000C and U+0020. (The plugin and
the app use different notions of "whitespace" in their languages; this fixes one.) No other character, not
even a no-break space, is trimmed. `trimEnd` removes it from the end only.

## 2. Intervals

Region coverage is kept as a list of disjoint, sorted, inclusive integer intervals `[start, end]`.
**Adding** `[s, e]` merges it with every interval it overlaps **or touches** (`[1,3]` and `[4,6]` become
`[1,6]`). **Subtracting** `[s, e]` removes those lines, splitting an interval if the removed run is in its
middle (`[9,11]` minus `[10,10]` is `[9,9]`, `[11,11]`).

## 3. Region marks

A region mark is a `regionReviewed` or `regionUnreviewed` event with one or two **mark ranges**
`{side, startLine, endLine, blob, hash}` for a path. Its meaning is "the lines with this content". It is
evaluated against the current file, so the mark follows its lines when the file changes.

### 3.1 Resolving one range

Given a mark range `r` and the lines `L` of the current file's same side (or none, if that side does not
exist or is not text), with `n = r.endLine - r.startLine + 1`:

1. If `L` is none, `r` does not resolve.
2. **Same place.** If `r.endLine <= len(L)` and `hashLines(L[r.startLine .. r.endLine]) == r.hash`, `r`
   resolves to `[r.startLine, r.endLine]`.
3. **Elsewhere.** Otherwise look at every window of `n` consecutive lines of `L`. If **exactly one** has
   hash `r.hash`, `r` resolves to that window. If none does, or more than one does, `r` does not resolve.

The same-place test comes first so that text which repeats elsewhere in the file (a blank line, `}`) is
still correctly found where it was. The uniqueness requirement in step 3 is deliberate: a mark that is
wrongly shown as reviewed is worse than one shown as stale, so an ambiguous mark is never placed by guessing
a "nearest" occurrence. (A tool is free to offer the user such a guess as a *suggestion*, but a suggestion
is not a mark.)

Resolution looks only at the current content. It does not matter whether `r.blob` equals the current blob;
equal blobs always resolve at step 2.

### 3.2 Evaluating all marks of a path and side

Take the `regionReviewed` / `regionUnreviewed` events of the review in fold order. Every range of every
event contributes a step for its path and side. For one path and side, keep:

- `covered`: intervals in the **current** file's line numbers, initially empty;
- `stale`: for each blob id, intervals in **that blob's** line numbers, initially empty.

For each step `(type, r)` in order:

- if `r` resolves to `[s, e]`: for `reviewed`, add `[s, e]` to `covered`; for `unreviewed`, subtract it;
- if `r` does not resolve: for `reviewed`, add `[r.startLine, r.endLine]` to `stale[r.blob]`; for
  `unreviewed`, subtract it from `stale[r.blob]`.

The result is `covered` (reviewed now) and `stale` (reviewed once, cannot be placed now), the latter
reported as `{blob, startLine, endLine}`. A range that was reviewed and then unreviewed with the same
lines of the same blob leaves nothing in either list.

Effects to be aware of:

- Reviewing a region again after the file changed (a new blob) adds to `covered` and leaves the old stale
  range in `stale` until the user clears it, because it describes content that no longer exists. A tool
  SHOULD NOT show that as a problem: stale ranges are history, not work to do. (The example shows both.)
- A line can be reviewed by one range and cleared by another. Only the order decides.
- A file marked reviewed with a file mark and a file with regions are separate facts (SPEC 6.4).
- Evaluation is a function of the events and the current content only. It writes nothing.

### 3.3 Cost

The definition hashes every window of length `n`, which is quadratic in the worst case. An implementation
SHOULD compute it faster, for example by hashing each line once and comparing sequences, or by hashing
windows with a rolling hash and confirming candidates; it MUST give the same result.

## 4. Locating a comment's code again

Used to compute a **suggestion** for an outdated comment. Given one anchor range `r`
(`side`, `startLine`, `endLine`, `snapshot`) and the lines `L` of the current file's same side, with
`n = len(r.snapshot.lines)`:

1. If `n == 0` or `len(L) < n`, there is no result.
2. A window is `L[i .. i+n-1]`, starting at line `i+1`. For each pass below, collect the windows that
   match; if there are any, the **best** of them is the result and later passes are not tried. The passes:
   1. **Exact**: every line equals the snapshot line after `trimEnd`.
   2. **Trimmed**: every line equals the snapshot line after `trim`.
   3. **Fuzzy**, only if `n >= 3`: at least 70% of the lines (count divided by `n`) equal the snapshot
      line at the same offset after `trim`.
3. **Best** among the matching windows: the highest context score; then the smallest distance
   `|startLine_of_window - r.startLine|`; then the smallest start line.
4. The **context score** of a window counts the context lines that match after `trim`: the snapshot's
   `before` lines compared against the lines immediately above the window, nearest first and moving away
   (the last `before` line against the line right above the window); and the snapshot's `after` lines
   against the lines immediately below it, nearest first. One point per match.
5. The result is the window's `[start, start + n - 1]` in the current file's numbering.

An anchor with two ranges is located per range. A suggestion exists only if **both** ranges were located;
otherwise there is none. A suggestion never moves a comment by itself (SPEC section 8).

This is the search the IDE plugin already uses (exact, then whitespace-insensitive, then 70% similar,
ranked by context and proximity), with its ties and its whitespace made exact.

### 4.1 Rename and path changes

A suggestion is looked for in the file with the same identity `path` in the current change set. If the
file was renamed or deleted since the comment's pin, a tool MAY map the path with git's rename detection
between the commits (`git diff -M --name-status`) and suggest the new path; the reference implementation
does not, and reports no suggestion. A suggestion carries its own `path` for this reason.

## 5. Comment state

For a comment in a review whose current pin is `P`, with the change set `C` for `P`:

```
if scope == review                               -> current
if anchor.pin == P (all three commit ids)        -> current
if anchor.path is not in C                       -> outdated, no suggestion
if scope == file                                 -> unchanged
for scope == lines, for each range r:
    same := the side's lines have len >= r.endLine and
            L[r.startLine .. r.endLine] equals r.snapshot.lines, line for line
if every range is same                           -> unchanged
else                                             -> outdated, with a suggestion if section 4 finds every range
```

A range counts as `same` if its lines are exactly equal, character for character, with no trimming. The
test is "is this text still at these numbers", not "is it similar".

## 6. Deriving ranges (informative)

This section is not needed to read state. It says how tools should turn what the user does into ranges, so
that the same gesture produces the same range in every tool.

- **Drag selection in a side-by-side diff.** The selection is inside one editor, so it is one range on
  that side, from the first selected line to the last. If the selection ends at column 1 of a line, that
  line is not included. It may span several hunks and unchanged lines in between; nothing about hunks
  limits it.
- **Selection in a unified diff.** Each displayed line belongs to the old side (removed), the new side
  (added), or both (unchanged). Take the selected lines in order. The old range spans the first to the
  last selected line that exists on the old side; the new range does the same on the new side. An
  unchanged line contributes to both. The two ranges are contiguous on their own sides because the
  selection is contiguous on screen. Create a range for each side that has at least one line, at most two.
- **A single click on a gutter marker** is a range of one line on the side of that gutter.
- **Marking a hunk reviewed.** Take the hunk as the tool computes it. Its changed lines on the old side
  form one range, its changed lines on the new side form another; omit a side that has none (a pure
  addition has no old range). Emit one `regionReviewed` with those ranges, each with its side's current
  `blob` and `hash`. Context lines are not part of the mark.
- **Marking a selection reviewed** is the same with the ranges of the selection.
- **Un-marking** emits `regionUnreviewed` with the ranges of the lines the user un-marked. The ranges are
  in the numbering of the current files and carry the current blobs, so they take effect on exactly what
  the user sees.
- **Showing hunk progress.** A hunk is reviewed when every changed line of it, on each side, is in
  `covered`. Show "n of m changed lines reviewed" or a hunk-level checkbox as the interface needs; none of
  it is stored.
