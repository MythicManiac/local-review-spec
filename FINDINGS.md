# Findings

Problems found while implementing or testing against the baseline. See CHANGE_CONTROL.md for how a finding
becomes a change. Add a row when you find one; keep the example small, and prefer a vector or an experiment
to a description.

| # | Date | Found by | Where (file and section) | What and the smallest example | Kind (erratum, test addition, behaviour change) | Status |
| - | ---- | -------- | ------------------------ | ----------------------------- | ----------------------------------------------- | ------ |
| 1 | 2026-10-21 | IDE plugin | SPEC 5.2 step 3 and 5.3 | After a crash mid-append, the next writer closes the cut-off line with `\n` (step 3). From then on every reader counts that fragment as a corrupt line (5.3: "any other line that is not valid JSON"), for ever, and a tool that shows non-zero counts to the user (5.3: SHOULD) shows a warning on a log that has been healthy since. Smallest example: a log `{"v":1,"id":"A","ts":1,"dev":"D","seq":1,"ev":{"type":"reviewRenamed","title":"x"}}\n{"v":1,"id":"CUT","ts":2\n{"v":1,"id":"B","ts":3,"dev":"D","seq":2,"ev":{"type":"reviewRenamed","title":"y"}}\n` reports `corruptLines: [{file, line: 2}]`. A reader cannot tell this from real damage. Not a conformance problem and not blocking: the plugin shows it as a warning notification when a review is opened. Question for triage: whether a tool should be told it MAY present a single invalid line that is followed by a valid event of the same log as a recovered write rather than as damage, or leave it as is. | informative (no behaviour change) unless the answer is to count recovered fragments separately | open |
