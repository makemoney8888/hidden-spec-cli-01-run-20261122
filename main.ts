// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// It reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks, the V4A patch
// format, JSON edits), finds each edit's lines at the first of three matching tiers (exact,
// trailing whitespace ignored, both ends ignored), and writes every change or none. SPEC.md is
// the whole contract; the sections below follow it in order.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file
// hands over to runner.ts (the last lines below): keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file's text as lines: its break, its lines, whether it ends with a break. */
interface FileText {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileText {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { br, lines, final };
}

function joinFile(f: FileText): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

const rstripWs = (s: string): string => s.replace(/[ \t]+$/, '');
const stripWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

/** Line equality at a matching tier (SPEC.md section 5). */
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rstripWs(a) === rstripWs(b);
  return stripWs(a) === stripWs(b);
}

interface Occ {
  tier: number;
  pos: number[];
}

/**
 * The occurrences of O in `lines` at the first tier where one exists, at or after `from`.
 * With `eof`, only occurrences ending at the file's last line count.
 */
function findOcc(O: string[], lines: string[], strict: boolean, from = 0, eof = false): Occ | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos: number[] = [];
    for (let i = from; i + O.length <= lines.length; i++) {
      if (eof && i + O.length !== lines.length) continue;
      let ok = true;
      for (let j = 0; j < O.length; j++) {
        if (!lineEq(O[j]!, lines[i + j]!, t)) {
          ok = false;
          break;
        }
      }
      if (ok) pos.push(i);
    }
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** The first line at or after `from` equal to a single line, at the first tier where one is. */
function findSingle(anchor: string, lines: string[], strict: boolean, from: number): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < lines.length; i++) {
      if (lineEq(anchor, lines[i]!, t)) return i;
    }
  }
  return null;
}

/**
 * The lines N writes when it replaces O at `at`: a context line is the file's own matched line,
 * never the patch's (`nCtx[k]` is its index into O, or -1 for a new line); at tier 2 every other
 * line is re-indented from O's first line to the file's.
 */
function replacementLines(N: string[], nCtx: number[], O: string[], fileLines: string[], at: number, tier: number): string[] {
  if (tier !== 2) {
    return N.map((l, k) => (nCtx[k]! >= 0 ? fileLines[at + nCtx[k]!]! : l));
  }
  const F = leadWs(fileLines[at] ?? '');
  const P = leadWs(O[0] ?? '');
  return N.map((l, k) => {
    if (nCtx[k]! >= 0) return fileLines[at + nCtx[k]!]!;
    if (l === '' || /^[ \t]+$/.test(l)) return l;
    if (l.startsWith(P)) return F + l.slice(P.length);
    return l;
  });
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, as [old, new] pairs, for the R output lines. */
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

interface Hunk {
  a: number;
  O: string[];
  N: string[];
  /** For each line of N: its index into O when it is a context line, else -1. */
  nCtx: number[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noBreak: boolean;
  /** A `\` line follows the hunk's last `+` line. */
  noBreakPlus: boolean;
  hasPlus: boolean;
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

/** The path after `--- ` or `+++ `: up to the first tab, trimmed, leading a/ or b/ removed. */
function diffPath(s: string): string {
  const t = s.split('\t')[0]!.trim();
  if (t.startsWith('a/') || t.startsWith('b/')) return t.slice(2);
  return t;
}

function parseHunkHeader(l: string, i: number): number {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
  if (m === null) throw new Exit2(`error: parse ${i + 1}`);
  return parseInt(m[1]!, 10);
}

function buildHunk(a: number, body: string[]): Hunk {
  const O: string[] = [];
  const N: string[] = [];
  const nCtx: number[] = [];
  let lastCP = -1;
  let lastPlus = -1;
  for (let k = 0; k < body.length; k++) {
    const c = body[k]![0];
    if (c === ' ' || c === '+') lastCP = k;
    if (c === '+') lastPlus = k;
  }
  const noBreak = lastCP >= 0 && body[lastCP + 1] !== undefined && body[lastCP + 1]![0] === '\\';
  const noBreakPlus = lastPlus >= 0 && body[lastPlus + 1] !== undefined && body[lastPlus + 1]![0] === '\\';
  let hasPlus = false;
  for (const l of body) {
    if (l === '') {
      O.push('');
      N.push('');
      nCtx.push(O.length - 1);
    } else if (l[0] === ' ') {
      const t = l.slice(1);
      O.push(t);
      N.push(t);
      nCtx.push(O.length - 1);
    } else if (l[0] === '-') {
      O.push(l.slice(1));
    } else if (l[0] === '+') {
      N.push(l.slice(1));
      nCtx.push(-1);
      hasPlus = true;
    }
    // A `\` line names no line of its own.
  }
  return { a, O, N, nCtx, noBreak, noBreakPlus, hasPlus };
}

/** A hunk's body lines from `start`; trailing empty lines are not part of it. */
function consumeBody(lines: string[], start: number): { body: string[]; next: number } {
  const body: string[] = [];
  let i = start;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
      body.push(l);
      i++;
    } else break;
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  return { body, next: i };
}

function parseUnified(lines: string[]): Section[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  let i = 0;
  const n = lines.length;
  const startSection = (oldP: string | null, newP: string | null): void => {
    const s: Section = { oldPath: oldP, newPath: newP, create: false, del: false, hunks: [] };
    sections.push(s);
    cur = s;
    inHeader = true;
  };
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection(m[1]!, m[2]!);
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader) {
        // A pair inside the current section's header names its paths.
        cur.oldPath = diffPath(l.slice(4));
        cur.newPath = diffPath(lines[i + 1]!.slice(4));
        i += 2;
        continue;
      }
      startSection(diffPath(l.slice(4)), diffPath(lines[i + 1]!.slice(4)));
      i += 2;
      continue;
    }
    if (cur === null) {
      if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i++;
      continue;
    }
    if (inHeader) {
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('+++ ')) {
        cur.newPath = diffPath(l.slice(4));
        i++;
        continue;
      }
      if (l.startsWith('rename from ')) {
        cur.oldPath = l.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (l.startsWith('rename to ')) {
        cur.newPath = l.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (l.startsWith('new file mode')) {
        cur.create = true;
        i++;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        cur.del = true;
        i++;
        continue;
      }
      if (l.startsWith('@@')) {
        const a = parseHunkHeader(l, i);
        inHeader = false;
        i++;
        const { body, next } = consumeBody(lines, i);
        i = next;
        cur.hunks.push(buildHunk(a, body));
        continue;
      }
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      const a = parseHunkHeader(l, i);
      i++;
      const { body, next } = consumeBody(lines, i);
      i = next;
      cur.hunks.push(buildHunk(a, body));
      continue;
    }
    i++;
  }
  // /dev/null names no file.
  for (const s of sections) {
    if (s.oldPath === '/dev/null') s.oldPath = null;
    if (s.newPath === '/dev/null') s.newPath = null;
  }
  return sections;
}

/** Apply a section's hunks in order to a file's lines (SPEC.md section 6). */
function applyHunks(f: FileText, hunks: Hunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const h of hunks) {
    if (h.O.length === 0) {
      let pos = h.a + d;
      if (pos < 0) pos = 0;
      if (pos > f.lines.length) pos = f.lines.length;
      const atEnd = pos === f.lines.length;
      f.lines.splice(pos, 0, ...h.N);
      if (atEnd) f.final = !h.noBreak;
      d += h.N.length;
      continue;
    }
    const occ = findOcc(h.O, f.lines, strict);
    if (occ === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = occ.pos[0]!;
    let bestDist = Math.abs(best - target);
    for (let k = 1; k < occ.pos.length; k++) {
      const p = occ.pos[k]!;
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const at = best;
    const touchesEnd = at + h.O.length === f.lines.length;
    const newLines = replacementLines(h.N, h.nCtx, h.O, f.lines, at, occ.tier);
    f.lines.splice(at, h.O.length, ...newLines);
    if (touchesEnd) f.final = !h.noBreak;
    d += h.N.length - h.O.length;
  }
}

function unifiedEdits(sections: Section[], strict: boolean): Edit[] {
  return sections.map((s) => (tree: Tree) => {
    const oldP = s.oldPath;
    const newP = s.newPath;
    if (oldP === null && newP === null) return;
    const isCreate = s.create || oldP === null;
    const isDelete = !isCreate && (s.del || newP === null);
    if (isCreate) {
      const p = newP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let noBreak = false;
      for (const h of s.hunks) {
        for (let k = 0; k < h.N.length; k++) {
          if (h.nCtx[k]! < 0) plus.push(h.N[k]!);
        }
        if (h.hasPlus) noBreak = h.noBreakPlus;
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (noBreak ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const p = oldP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const p = oldP!;
    if (!safe(p)) throw new Fail('unsafe', p);
    const isMove = newP !== null && newP !== p;
    if (isMove && !safe(newP!)) throw new Fail('unsafe', newP!);
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    if (isMove && tree.get(newP!) !== null) throw new Fail('exists', newP!);
    const f = splitFile(cur);
    applyHunks(f, s.hunks, strict, p);
    const text = joinFile(f);
    if (isMove) {
      tree.now.set(p, null);
      tree.now.set(newP!, text);
      tree.moves.push([p, newP!]);
    } else {
      tree.now.set(p, text);
    }
  });
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

interface SrBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[]): SrBlock[] {
  const blocks: SrBlock[] = [];
  let i = 0;
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i + 1;
    let j = i + 1;
    while (j < lines.length && lines[j]!.trimEnd() !== '=======') j++;
    if (j >= lines.length) throw new Exit2(`error: parse ${searchLine}`);
    let k = j + 1;
    while (k < lines.length && lines[k]!.trimEnd() !== '>>>>>>> REPLACE') k++;
    if (k >= lines.length) throw new Exit2(`error: parse ${searchLine}`);
    const oldLines = lines.slice(i + 1, j);
    const newLines = lines.slice(j + 1, k);
    let path: string | null = null;
    for (let m = i - 1; m > prevReplaceEnd; m--) {
      const t = lines[m]!.trim();
      if (t === '') continue;
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
      path = prevPath;
    }
    blocks.push({ path, oldLines, newLines });
    prevPath = path;
    prevReplaceEnd = k;
    i = k + 1;
  }
  return blocks;
}

function srEdits(blocks: SrBlock[], strict: boolean): Edit[] {
  return blocks.map((b) => (tree: Tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(b.path);
    if (cur === null) throw new Fail('missing', b.path);
    const f = splitFile(cur);
    const occ = findOcc(b.oldLines, f.lines, strict);
    if (occ === null) throw new Fail('no-match', b.path);
    if (occ.pos.length > 1) throw new Fail('ambiguous', b.path);
    const at = occ.pos[0]!;
    const newLines = replacementLines(b.newLines, b.newLines.map(() => -1), b.oldLines, f.lines, at, occ.tier);
    f.lines.splice(at, b.oldLines.length, ...newLines);
    tree.now.set(b.path, joinFile(f));
  });
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  O: string[];
  N: string[];
  /** For each line of N: its index into O when it is a context line, else -1. */
  nCtx: number[];
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  fileLines: string[];
  chunks: V4aChunk[];
}

const SECTION_START = /^\*\*\* (Add File|Delete File|Update File):(.*)$/;

function parseV4a(lines: string[]): V4aSection[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    const m = SECTION_START.exec(l);
    if (m === null) throw new Exit2(`error: parse ${i + 1}`);
    const kind = m[1] === 'Add File' ? 'add' : m[1] === 'Delete File' ? 'delete' : 'update';
    const path = m[2]!.trim();
    const updateLine = i + 1;
    i++;
    const startIdx = i;
    const raw: string[] = [];
    while (i < last) {
      const l2 = lines[i]!;
      if (SECTION_START.test(l2)) break;
      raw.push(l2);
      i++;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
    sections.push(interpretV4aSection(kind, path, raw, startIdx, updateLine));
  }
  return sections;
}

function interpretV4aSection(kind: 'add' | 'delete' | 'update', path: string, raw: string[], startIdx: number, updateLine: number): V4aSection {
  if (kind === 'add') {
    const fileLines: string[] = [];
    for (let k = 0; k < raw.length; k++) {
      const l = raw[k]!;
      if (l === '') fileLines.push('');
      else if (l[0] === '+') fileLines.push(l.slice(1));
      else throw new Exit2(`error: parse ${startIdx + k + 1}`);
    }
    return { kind, path, moveTo: null, fileLines, chunks: [] };
  }
  if (kind === 'delete') {
    if (raw.length > 0) throw new Exit2(`error: parse ${startIdx + 1}`);
    return { kind, path, moveTo: null, fileLines: [], chunks: [] };
  }
  let moveTo: string | null = null;
  let idx = 0;
  if (raw.length > 0 && raw[0]!.startsWith('*** Move to:')) {
    moveTo = raw[0]!.slice('*** Move to:'.length).trim();
    idx = 1;
  }
  const chunks: V4aChunk[] = [];
  let cur: V4aChunk | null = null;
  let firstChunk = true;
  const lineNo = (k: number): number => startIdx + k + 1;
  for (; idx < raw.length; idx++) {
    const l = raw[idx]!;
    if (l.startsWith('@@')) {
      cur = { anchor: l.slice(2).trim(), eof: false, O: [], N: [], nCtx: [] };
      chunks.push(cur);
      firstChunk = false;
      continue;
    }
    if (l === '*** End of File' || (l.startsWith('*** End of File') && l.slice('*** End of File'.length).trim() === '')) {
      if (cur === null) throw new Exit2(`error: parse ${lineNo(idx)}`);
      cur.eof = true;
      cur = null;
      continue;
    }
    if (l.startsWith('***')) throw new Exit2(`error: parse ${lineNo(idx)}`);
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      if (cur === null) {
        if (!firstChunk) throw new Exit2(`error: parse ${lineNo(idx)}`);
        cur = { anchor: null, eof: false, O: [], N: [], nCtx: [] };
        chunks.push(cur);
        firstChunk = false;
      }
      if (l === '') {
        cur.O.push('');
        cur.N.push('');
        cur.nCtx.push(cur.O.length - 1);
      } else if (l[0] === ' ') {
        const t = l.slice(1);
        cur.O.push(t);
        cur.N.push(t);
        cur.nCtx.push(cur.O.length - 1);
      } else if (l[0] === '-') {
        cur.O.push(l.slice(1));
      } else {
        cur.N.push(l.slice(1));
        cur.nCtx.push(-1);
      }
      continue;
    }
    throw new Exit2(`error: parse ${lineNo(idx)}`);
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
  return { kind, path, moveTo, fileLines: [], chunks };
}

function v4aEdits(sections: V4aSection[], strict: boolean): Edit[] {
  return sections.map((s) => (tree: Tree) => {
    if (s.kind === 'add') {
      if (!safe(s.path)) throw new Fail('unsafe', s.path);
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.now.set(s.path, s.fileLines.length === 0 ? '' : s.fileLines.join('\n') + '\n');
      return;
    }
    if (s.kind === 'delete') {
      if (!safe(s.path)) throw new Fail('unsafe', s.path);
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
      return;
    }
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (s.moveTo !== null && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
    const cur = tree.get(s.path);
    if (cur === null) throw new Fail('missing', s.path);
    if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    const f = splitFile(cur);
    let cursor = 0;
    for (const ch of s.chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        const at = findSingle(ch.anchor, f.lines, strict, cursor);
        if (at === null) throw new Fail('no-match', s.path);
        cursor = at + 1;
      }
      if (ch.O.length === 0) {
        const pos = ch.eof ? f.lines.length : cursor;
        f.lines.splice(pos, 0, ...ch.N);
        cursor = pos + ch.N.length;
        continue;
      }
      const occ = findOcc(ch.O, f.lines, strict, cursor, ch.eof);
      if (occ === null) throw new Fail('no-match', s.path);
      const at = occ.pos[0]!;
      const newLines = replacementLines(ch.N, ch.nCtx, ch.O, f.lines, at, occ.tier);
      f.lines.splice(at, ch.O.length, ...newLines);
      cursor = at + newLines.length;
    }
    const text = joinFile(f);
    if (s.moveTo !== null) {
      tree.now.set(s.path, null);
      tree.now.set(s.moveTo, text);
      tree.moves.push([s.path, s.moveTo]);
    } else {
      tree.now.set(s.path, text);
    }
  });
}

// ---------------------------------------------------------------------------
// Running (SPEC.md sections 1, 2, 10)
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(parseUnified(lines), strict);
    else if (kind === 'search-replace') edits = srEdits(parseSearchReplace(lines), strict);
    else edits = v4aEdits(parseV4a(lines), strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const covered = new Set<string>();
  const rows: Array<{ key: string; line: string }> = [];
  for (const [o, n] of tree.moves) {
    if (covered.has(o) || covered.has(n)) continue;
    if (tree.original(o) !== null && tree.get(o) === null && tree.original(n) === null && tree.get(n) !== null) {
      rows.push({ key: n, line: `R ${o} -> ${n}` });
      covered.add(o);
      covered.add(n);
    }
  }
  for (const p of tree.now.keys()) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  if (!check) {
    const changed = [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
    for (const p of changed) {
      if (tree.original(p) === tree.now.get(p)) continue;
      if (tree.now.get(p) === null) rmSync(p, { force: true });
    }
    for (const p of changed) {
      if (tree.original(p) === tree.now.get(p)) continue;
      const now = tree.now.get(p)!;
      if (now === null) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  const outLines = rows.map((r) => r.line);
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
