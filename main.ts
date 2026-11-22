// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`. It implements all of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, three-tier line matching (section 5), unified diffs
// (section 6), SEARCH/REPLACE blocks (section 7), V4A patches (section 8), JSON edits (section 9)
// and the all-or-nothing write (section 10).
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands
// over to runner.ts (the last lines below): keep that hand-over and runner.ts as they are, and
// write the CLI.

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

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
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

/** Successful moves, recorded so the output can print `R <old> -> <new>` lines (section 2). */
const movePairs: Array<[string, string]> = [];

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
// Section 3 helpers: a file as lines, its line break, and whether it ends
// with one. Section 5: matching lines at three tiers.
// ---------------------------------------------------------------------------

interface FileText {
  lines: string[];
  br: string;
  final: boolean;
}

function parseFileText(text: string): FileText {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function serializeFileText(f: FileText): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

const rstrip = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rstrip(a) === rstrip(b);
  return stripBoth(a) === stripBoth(b);
}

/** Positions i where O matches lines[i .. i+O.length). */
function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(o[j]!, lines[i + j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/**
 * The first tier (0, then 1, then 2; only 0 with --strict) at which O occurs at
 * or after `from`, and its occurrences there. With `eofOnly`, only occurrences
 * that end at the file's last line count.
 */
function findOcc(
  lines: string[],
  o: string[],
  strict: boolean,
  from: number,
  eofOnly: boolean,
): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    let occ = occurrences(lines, o, t, from);
    if (eofOnly) occ = occ.filter((i) => i + o.length === lines.length);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of N: a context line (written as the file's own matched line, oIdx
 *  is its index in O) or a new line (written as the patch wrote it, re-indented
 *  at tier 2). */
interface NItem {
  text: string;
  ctx: boolean;
  oIdx: number;
}

/** Build the replacement lines for an occurrence of O at `at`. */
function buildNew(o: string[], n: NItem[], fileLines: string[], at: number, tier: number): string[] {
  const p = o.length > 0 ? leadWs(o[0]!) : '';
  const f = o.length > 0 ? leadWs(fileLines[at]!) : '';
  return n.map((it) => {
    if (it.ctx) return fileLines[at + it.oIdx]!;
    if (tier === 2 && it.text !== '' && it.text.trim() !== '' && it.text.startsWith(p)) return f + it.text.slice(p.length);
    return it.text;
  });
}

/**
 * Split a hunk/chunk body (lines starting with ' ', '-', '+' or empty, plus
 * '\' lines for unified diffs) into old lines O and new lines N.
 */
interface BodyParts {
  o: string[];
  n: NItem[];
  /** a `\` line follows the body's last context or `+` line */
  noBreakAtEnd: boolean;
  /** a `\` line follows the body's last `+` line */
  noBreakAfterLastPlus: boolean;
}

function parseBodyLines(body: string[]): BodyParts {
  const o: string[] = [];
  const n: NItem[] = [];
  let lastCtxPlus = -1;
  let lastPlus = -1;
  const backslash = new Set<number>();
  body.forEach((line, idx) => {
    if (line.startsWith('\\')) {
      backslash.add(idx);
      return;
    }
    if (line === '') {
      o.push('');
      n.push({ text: '', ctx: true, oIdx: o.length - 1 });
      lastCtxPlus = idx;
      return;
    }
    const text = line.slice(1);
    if (line[0] === ' ') {
      o.push(text);
      n.push({ text, ctx: true, oIdx: o.length - 1 });
      lastCtxPlus = idx;
    } else if (line[0] === '-') {
      o.push(text);
    } else if (line[0] === '+') {
      n.push({ text, ctx: false, oIdx: -1 });
      lastCtxPlus = idx;
      lastPlus = idx;
    }
  });
  return {
    o,
    n,
    noBreakAtEnd: lastCtxPlus >= 0 && backslash.has(lastCtxPlus + 1),
    noBreakAfterLastPlus: lastPlus >= 0 && backslash.has(lastPlus + 1),
  };
}

// ---------------------------------------------------------------------------
// Section 6: unified diffs.
// ---------------------------------------------------------------------------

interface UHunk {
  a: number;
  body: string[];
}

interface USection {
  pairOld: string | null;
  pairNew: string | null;
  renOld: string | null;
  renNew: string | null;
  diffOld: string | null;
  diffNew: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: UHunk[];
}

function emptyUSection(): USection {
  return {
    pairOld: null,
    pairNew: null,
    renOld: null,
    renNew: null,
    diffOld: null,
    diffNew: null,
    isCreate: false,
    isDelete: false,
    hunks: [],
  };
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/;
const DIFF_RE = /^diff --git a\/(\S+) b\/(\S+)[ \t]*$/;

/** The path of a `--- ` / `+++ ` header line, with any leading a/ or b/ removed. */
function headerPath(line: string): string {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let state: 'outside' | 'header' | 'between' | 'body' = 'outside';
  let hunk: UHunk | null = null;

  const startSection = (s: USection): void => {
    sections.push(s);
    cur = s;
    state = 'header';
  };
  const startHunk = (line: string, num: number): void => {
    const m = HUNK_RE.exec(line);
    if (m === null) throw new Exit2(`error: parse ${num}`);
    hunk = { a: Number(m[1]), body: [] };
    state = 'body';
  };
  const endHunk = (): void => {
    if (hunk !== null) {
      while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1] === '') hunk.body.pop();
      cur!.hunks.push(hunk);
      hunk = null;
    }
    state = 'between';
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const num = i + 1;
    if (state === 'body') {
      if (line.startsWith('diff --git ')) {
        endHunk();
        continue;
      }
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        endHunk();
        continue;
      }
      if (line === '' || line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line.startsWith('\\')) {
        hunk!.body.push(line);
        i++;
        continue;
      }
      endHunk();
      continue;
    }
    if (line.startsWith('diff --git ')) {
      const m = DIFF_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${num}`);
      const s = emptyUSection();
      s.diffOld = m[1]!;
      s.diffNew = m[2]!;
      startSection(s);
      i++;
      continue;
    }
    if (state === 'outside') {
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        const s = emptyUSection();
        s.pairOld = headerPath(line);
        s.pairNew = headerPath(lines[i + 1]!);
        startSection(s);
        i += 2;
        continue;
      }
      if (line.startsWith('@@')) throw new Exit2(`error: parse ${num}`);
      i++;
      continue;
    }
    if (state === 'header') {
      if (line.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          if (cur!.pairOld === null) {
            cur!.pairOld = headerPath(line);
            cur!.pairNew = headerPath(lines[i + 1]!);
          }
          i += 2;
          continue;
        }
        throw new Exit2(`error: parse ${num + 1}`);
      }
      if (line.startsWith('rename from ')) {
        if (cur!.renOld === null) cur!.renOld = line.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        if (cur!.renNew === null) cur!.renNew = line.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur!.isCreate = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur!.isDelete = true;
        i++;
        continue;
      }
      if (line.startsWith('@@')) {
        startHunk(line, num);
        i++;
        continue;
      }
      i++;
      continue;
    }
    // between hunks of a section
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const s = emptyUSection();
      s.pairOld = headerPath(line);
      s.pairNew = headerPath(lines[i + 1]!);
      startSection(s);
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      startHunk(line, num);
      i++;
      continue;
    }
    i++;
  }
  if (state === 'body') endHunk();
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

/** Apply a section's hunks in order to a file's text; throws Fail on no-match. */
function applyUnifiedHunks(text: string, hunks: UHunk[], strict: boolean, path: string): string {
  const f = parseFileText(text);
  let d = 0;
  for (const h of hunks) {
    const parts = parseBodyLines(h.body);
    if (parts.o.length === 0) {
      const oldLen = f.lines.length;
      const at = Math.min(Math.max(h.a + d, 0), oldLen);
      const ins = parts.n.map((it) => it.text);
      f.lines.splice(at, 0, ...ins);
      if (at === oldLen && ins.length > 0) f.final = !parts.noBreakAtEnd;
      d += parts.n.length;
      continue;
    }
    const found = findOcc(f.lines, parts.o, strict, 0, false);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.occ[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of found.occ) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const oldLen = f.lines.length;
    const touchesEnd = best + parts.o.length === oldLen;
    const seg = buildNew(parts.o, parts.n, f.lines, best, found.tier);
    f.lines.splice(best, parts.o.length, ...seg);
    if (touchesEnd) {
      if (parts.n.length === 0) f.final = f.lines.length > 0;
      else f.final = !parts.noBreakAtEnd;
    }
    d += parts.n.length - parts.o.length;
  }
  return serializeFileText(f);
}

function unifiedSectionEdit(s: USection, strict: boolean): Edit {
  const oldP = s.pairOld ?? s.renOld ?? s.diffOld;
  const newP = s.pairNew ?? s.renNew ?? s.diffNew;
  const isCreate = s.isCreate || oldP === '/dev/null';
  const isDelete = !isCreate && (s.isDelete || newP === '/dev/null');
  if (oldP === null || newP === null) return () => {};
  if (isCreate) {
    const p = newP;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let finalBreak = false;
      for (const h of s.hunks) {
        const parts = parseBodyLines(h.body);
        for (const it of parts.n) if (!it.ctx) plus.push(it.text);
        if (parts.n.some((it) => !it.ctx)) finalBreak = !parts.noBreakAfterLastPlus;
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (finalBreak ? '\n' : ''));
    };
  }
  if (isDelete) {
    const p = oldP;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
    };
  }
  if (oldP !== newP) {
    const op = oldP;
    const np = newP;
    return (tree) => {
      if (!safe(op)) throw new Fail('unsafe', op);
      if (!safe(np)) throw new Fail('unsafe', np);
      const before = tree.get(op);
      if (before === null) throw new Fail('missing', op);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const out = applyUnifiedHunks(before, s.hunks, strict, op);
      tree.now.set(op, null);
      tree.now.set(np, out);
      movePairs.push([op, np]);
    };
  }
  const p = oldP;
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    tree.now.set(p, applyUnifiedHunks(before, s.hunks, strict, p));
  };
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks.
// ---------------------------------------------------------------------------

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const blocks: SRBlock[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchNum = i + 1;
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchNum}`);
    const oldLines = lines.slice(i + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchNum}`);
    blocks.push({ path, oldLines, newLines });
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return blocks.map((b) => srEdit(b, strict));
}

function srEdit(b: SRBlock, strict: boolean): Edit {
  return (tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const f = parseFileText(before);
    const found = findOcc(f.lines, b.oldLines, strict, 0, false);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.occ.length > 1) throw new Fail('ambiguous', b.path);
    const at = found.occ[0]!;
    const nItems: NItem[] = b.newLines.map((t) => ({ text: t, ctx: false, oIdx: -1 }));
    const seg = buildNew(b.oldLines, nItems, f.lines, at, found.tier);
    f.lines.splice(at, b.oldLines.length, ...seg);
    tree.now.set(b.path, serializeFileText(f));
  };
}

// ---------------------------------------------------------------------------
// Section 8: V4A patches.
// ---------------------------------------------------------------------------

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: string[];
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  num: number;
  lines: string[];
  lineNums: number[];
  moveTo: string | null;
  chunks: VChunk[];
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
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
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice('*** Add File: '.length).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice('*** Delete File: '.length).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const secNum = i + 1;
    i++;
    const raw: string[] = [];
    const rawNums: number[] = [];
    while (i < last && !isSectionStart(lines[i]!)) {
      raw.push(lines[i]!);
      rawNums.push(i + 1);
      i++;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!)) {
      raw.pop();
      rawNums.pop();
    }
    const sec: VSection = { kind, path, num: secNum, lines: raw, lineNums: rawNums, moveTo: null, chunks: [] };
    if (kind === 'add') {
      for (let k = 0; k < raw.length; k++) {
        const l = raw[k]!;
        if (l === '' || l.startsWith('+')) continue;
        throw new Exit2(`error: parse ${rawNums[k]}`);
      }
    } else if (kind === 'delete') {
      for (let k = 0; k < raw.length; k++) {
        if (!blank(raw[k]!)) throw new Exit2(`error: parse ${rawNums[k]}`);
      }
    } else {
      let j = 0;
      if (j < raw.length && raw[j]!.startsWith('*** Move to: ')) {
        sec.moveTo = raw[j]!.slice('*** Move to: '.length).trim();
        j++;
      }
      let cur: VChunk | null = null;
      let seenChunk = false;
      let eofClosed = false;
      const closeChunk = (): void => {
        if (cur !== null) {
          sec.chunks.push(cur);
          cur = null;
        }
      };
      while (j < raw.length) {
        const l = raw[j]!;
        const ln = rawNums[j]!;
        const isEof = l.trim() === '*** End of File' && !l.startsWith(' ') && !l.startsWith('-') && !l.startsWith('+');
        if (l.startsWith('@@')) {
          closeChunk();
          eofClosed = false;
          const anchor = l.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
          seenChunk = true;
          j++;
          continue;
        }
        if (isEof) {
          if (cur === null) throw new Exit2(`error: parse ${ln}`);
          cur.eof = true;
          closeChunk();
          eofClosed = true;
          j++;
          continue;
        }
        if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (cur === null) {
            if (seenChunk || eofClosed) throw new Exit2(`error: parse ${ln}`);
            cur = { anchor: null, eof: false, body: [] };
            seenChunk = true;
          }
          cur.body.push(l);
          j++;
          continue;
        }
        throw new Exit2(`error: parse ${ln}`);
      }
      closeChunk();
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${sec.num}`);
    }
    sections.push(sec);
  }
  return sections.map((s) => v4aEdit(s, strict));
}

/** First line at or after `from` equal to the anchor, at the first tier with one. */
function findAnchor(lines: string[], anchor: string, strict: boolean, from: number): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let k = from; k < lines.length; k++) {
      if (lineEq(anchor, lines[k]!, t)) return k;
    }
  }
  return null;
}

function v4aEdit(s: VSection, strict: boolean): Edit {
  return (tree) => {
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (s.kind === 'add') {
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      const content = s.lines.map((l) => (l === '' ? '' : l.slice(1)));
      tree.now.set(s.path, content.length === 0 ? '' : content.join('\n') + '\n');
      return;
    }
    if (s.kind === 'delete') {
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
      return;
    }
    if (s.moveTo !== null && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
    const before = tree.get(s.path);
    if (before === null) throw new Fail('missing', s.path);
    if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    const f = parseFileText(before);
    let cursor = 0;
    for (const ch of s.chunks) {
      if (ch.anchor !== null) {
        const foundA = findAnchor(f.lines, ch.anchor, strict, cursor);
        if (foundA === null) throw new Fail('no-match', s.path);
        cursor = foundA + 1;
      }
      const parts = parseBodyLines(ch.body);
      if (parts.o.length === 0) {
        const at = ch.eof ? f.lines.length : cursor;
        const ins = parts.n.map((it) => it.text);
        f.lines.splice(at, 0, ...ins);
        cursor = at + ins.length;
        continue;
      }
      const found = findOcc(f.lines, parts.o, strict, cursor, ch.eof);
      if (found === null) throw new Fail('no-match', s.path);
      const at = found.occ[0]!;
      const seg = buildNew(parts.o, parts.n, f.lines, at, found.tier);
      f.lines.splice(at, parts.o.length, ...seg);
      cursor = at + seg.length;
    }
    const out = serializeFileText(f);
    if (s.moveTo !== null) {
      tree.now.set(s.path, null);
      tree.now.set(s.moveTo, out);
      movePairs.push([s.path, s.moveTo]);
    } else {
      tree.now.set(s.path, out);
    }
  };
}

// ---------------------------------------------------------------------------
// Section 1: the command line. Section 2: output and exit codes.
// Section 10: order and atomicity.
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  movePairs.length = 0;
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
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed = [...tree.now.keys()]
    .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
    .filter((p) => tree.original(p) !== tree.now.get(p));
  // A successful move replaces its D and A lines with one R line (section 2).
  const dropped = new Set<string>();
  const rEntries: Array<{ key: string; line: string }> = [];
  for (const [op, np] of movePairs) {
    const oldWas = tree.original(op);
    const newWas = tree.original(np);
    const oldNow = tree.now.has(op) ? tree.now.get(op)! : tree.original(op);
    const newNow = tree.now.has(np) ? tree.now.get(np)! : tree.original(np);
    if (oldWas !== null && oldNow === null && newWas === null && newNow !== null) {
      rEntries.push({ key: np, line: `R ${op} -> ${np}` });
      dropped.add(`D ${op}`);
      dropped.add(`A ${np}`);
    }
  }
  const entries: Array<{ key: string; line: string }> = [];
  for (const p of changed) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    const line = `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`;
    if (dropped.has(line)) continue;
    entries.push({ key: p, line });
  }
  entries.push(...rEntries);
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = entries.map((e) => e.line);
  if (!check) {
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
