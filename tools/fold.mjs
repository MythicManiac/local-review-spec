#!/usr/bin/env node
// Folds a review folder with the reference implementation and prints JSON.
//
//   node tools/fold.mjs <review-dir>                          fold only (needs no file contents)
//   node tools/fold.mjs <review-dir> --content <content-dir>  fold, then evaluate against the contents
//
// <content-dir> holds changesets.json and blobs/, as produced by tools/make-fixture.mjs.

import { readReview, fold, evaluate, loadContent } from "./lib.mjs";

const args = process.argv.slice(2);
const dir = args[0];
if (!dir) {
  console.error("usage: node tools/fold.mjs <review-dir> [--content <content-dir>]");
  process.exit(2);
}
const ci = args.indexOf("--content");
const state = fold(readReview(dir));
const result = { fold: state };
if (ci !== -1) result.evaluated = evaluate(state, loadContent(args[ci + 1]));
console.log(JSON.stringify(result, null, 2));
