# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/makemoney8888/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/makemoney8888/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend applies an edit that an AI model wrote to a tree of text files. Models write edits in
four formats, and mend reads them all: a unified diff (often with wrong line numbers),
SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as JSON. Every file is
changed or nothing is. `SPEC.md` is the whole specification.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

The working directory is the root of the tree. PATCH is the path of the patch file, relative to
the working directory; when it is absent or is `-`, the patch is read from standard input.

- `--format=NAME` reads the patch in one format: `unified`, `search-replace`, `v4a` or `json`;
  `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code as without it, and no file
  is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

## Matching

A hunk, block or chunk names old lines that are replaced by new lines. The old lines are found
in the file at the first of three tiers at which they occur at least once:

- tier 0: every line equal;
- tier 1: every line equal once trailing spaces and tabs are removed from both;
- tier 2: every line equal once leading and trailing spaces and tabs are removed from both.

With `--strict` only tier 0 is tried. A context line is always written as the file's own matched
line, never the patch's, and at tier 2 the new lines are re-indented from the old lines' indent
to the file's. A unified hunk takes the occurrence nearest to the line number it names, so wrong
line numbers still land; a SEARCH/REPLACE block fails as ambiguous when its old lines occur more
than once; a V4A chunk walks a cursor through the file from its anchor.

## Output and exit codes

- Exit 2, one line: `error: usage`, `error: no-patch`, `error: format`, or `error: parse <N>`.
- Exit 1, one `error: <code> <path>` line per failed edit, then `failed: <k> of <n> edits`.
  No file is written.
- Exit 0, one line per changed path (`A`, `D`, `M`, or `R <old> -> <new>` for a move), then
  `ok: <n> files` (or `ok: 1 file`).

## The files

- `main.ts`: the CLI. Node 22 and its standard library alone, run as
  `node main.ts [options] [PATCH]`. Its last lines hand a trial over to `runner.ts` when
  `MAKEFUN_ENV_URL` is set: keep them.
- `runner.ts`: keep it as it is. In a trial it reads the checks from the env, runs
  `node main.ts` on each one in a fresh directory, and posts what it did.
- `check.ts`: the practice set on your own machine. The kit carries it at
  `program/generator/practice.json`:

      node check.ts ../program/generator/practice.json

  It prints every check main.ts gets wrong, with what differed, and the practice score.
- `SPEC.md`: the specification.
- `LICENSE`: MIT.

## A check

A check is one run: its arguments, its standard input (or none) and the files it starts with. It
passes when the exit code, everything written to stdout and every file afterwards are exactly
what SPEC.md says. Standard error is never compared. Each run has 10 seconds.
