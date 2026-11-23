// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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
  /** True when p is a directory: on disk, or implied by a file beneath it in the tree as the edits leave it. */
  isDir(p: string): boolean {
    try {
      if (statSync(p).isDirectory()) return true;
    } catch {
      /* not on disk */
    }
    const pre = `${p}/`;
    for (const [k, v] of this.orig) if (v !== null && k.startsWith(pre)) return true;
    for (const [k, v] of this.now) if (v !== null && k.startsWith(pre)) return true;
    return false;
  }
  /** A path an edit creates or moves onto is taken when it holds a file, or a directory. */
  taken(p: string): boolean {
    return this.get(p) !== null || this.isDir(p);
  }
}

type Edit = (tree: Tree, moves: Array<readonly [string, string]>) => void;

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
      if (tree.taken(p)) throw new Fail('exists', p);
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

// ---- Sections 5 to 8: matching lines at three tiers, and the unified, SEARCH/REPLACE and V4A readers. ----

interface FileLines {
  lines: string[];
  brk: '\n' | '\r\n';
  fin: boolean;
}

function toLines(text: string): FileLines {
  if (text === '') return { lines: [], brk: '\n', fin: false };
  const nl = text.indexOf('\n');
  const brk: '\n' | '\r\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(brk);
  const fin = text.endsWith(brk);
  if (fin) parts.pop();
  return { lines: parts, brk, fin };
}

function toText(fl: FileLines): string {
  if (fl.lines.length === 0) return '';
  return fl.lines.join(fl.brk) + (fl.fin ? fl.brk : '');
}

const trimTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const trimSpaces = (s: string): string => s.replace(/^ +| +$/g, '');
const trimBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0]!;

function eqLine(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimTrail(a) === trimTrail(b);
  return trimBoth(a) === trimBoth(b);
}

function matchAt(lines: string[], at: number, o: string[], tier: number): boolean {
  for (let j = 0; j < o.length; j++) if (!eqLine(lines[at + j]!, o[j]!, tier)) return false;
  return true;
}

interface TierHit {
  tier: number;
  occ: number[];
}

/** The first tier at which o occurs in lines (at or after `from`, and where `pred` holds), with every occurrence there. */
function findTier(lines: string[], o: string[], strict: boolean, from = 0, pred?: (at: number) => boolean): TierHit | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const occ: number[] = [];
    for (let i = from; i + o.length <= lines.length; i++) {
      if (pred !== undefined && !pred(i)) continue;
      if (matchAt(lines, i, o, tier)) occ.push(i);
    }
    if (occ.length > 0) return { tier, occ };
  }
  return null;
}

type NItem = { ctx: number } | { add: string };

/** The lines a match writes: context lines are the file's own, new lines are as written (re-indented at tier 2). */
function buildN(items: NItem[], o: string[], fileLines: string[], at: number, tier: number): string[] {
  const f = leadWs(fileLines[at]!);
  const p = leadWs(o[0]!);
  const out: string[] = [];
  for (const it of items) {
    if ('ctx' in it) out.push(fileLines[at + it.ctx]!);
    else if (tier === 2) {
      const s = it.add;
      if (s === '' || s.trim() === '') out.push(s);
      else if (s.startsWith(p)) out.push(f + s.slice(p.length));
      else out.push(s);
    } else out.push(it.add);
  }
  return out;
}

interface BodyItem {
  t: ' ' | '-' | '+';
  text: string;
  bs: boolean;
  emptyLine: boolean;
  wsLine?: number;
}

/** Split body items into the old lines O and the new-line recipe N (context items point into O). */
function hunkON(items: BodyItem[]): { o: string[]; n: NItem[] } {
  const o: string[] = [];
  const n: NItem[] = [];
  for (const it of items) {
    if (it.t === ' ') {
      n.push({ ctx: o.length });
      o.push(it.text);
    } else if (it.t === '-') o.push(it.text);
    else n.push({ add: it.text });
  }
  return { o, n };
}

// ---- Section 6: unified diffs ----

interface Hunk {
  a: number;
  aRaw: string;
  items: BodyItem[];
}

interface USection {
  gitOld?: string;
  gitNew?: string;
  pairOld?: string | null;
  pairNew?: string | null;
  renFrom?: string;
  renTo?: string;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
}

const cleanUPath = (raw: string): string | null => {
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
};

const headerPath = (line: string): string => {
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  return t.trim();
};

function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): FileLines {
  const fl = toLines(text);
  let d = 0;
  for (const h of hunks) {
    const { o, n } = hunkON(h.items);
    if (o.length === 0) {
      const built = n.map((it) => ('add' in it ? it.add : ''));
      let pos = h.a + d;
      if (pos < 0) pos = 0;
      if (pos > fl.lines.length) pos = fl.lines.length;
      const atEnd = pos === fl.lines.length;
      fl.lines.splice(pos, 0, ...built);
      if (atEnd) fl.fin = !(h.items.length > 0 && h.items[h.items.length - 1]!.bs);
      d += built.length;
      continue;
    }
    const hit = findTier(fl.lines, o, strict);
    if (hit === null) throw new Fail('no-match', path);
    const target = BigInt(h.aRaw) - 1n + BigInt(d);
    let at = hit.occ[0]!;
    for (const cand of hit.occ) {
      const dc = BigInt(cand) - target;
      const da = BigInt(at) - target;
      if ((dc < 0n ? -dc : dc) < (da < 0n ? -da : da)) at = cand;
    }
    const built = buildN(n, o, fl.lines, at, hit.tier);
    const runsToEnd = at + o.length === fl.lines.length;
    fl.lines.splice(at, o.length, ...built);
    if (runsToEnd) {
      let bs: boolean | null = null;
      for (const it of h.items) if (it.t !== '-') bs = it.bs;
      fl.fin = bs === null ? true : !bs;
    }
    d += built.length - o.length;
  }
  return fl;
}

function unifiedEdit(s: USection, strict: boolean): Edit {
  let oldP: string | null | undefined = s.pairOld !== undefined ? s.pairOld : s.renFrom !== undefined ? s.renFrom : s.gitOld;
  let newP: string | null | undefined = s.pairNew !== undefined ? s.pairNew : s.renTo !== undefined ? s.renTo : s.gitNew;
  const namedOld = oldP;
  const namedNew = newP;
  if (s.newFile) oldP = null;
  if (s.delFile) newP = null;
  return (tree, moves) => {
    if (typeof namedOld === 'string' && !safe(namedOld)) throw new Fail('unsafe', namedOld);
    if (typeof namedNew === 'string' && !safe(namedNew)) throw new Fail('unsafe', namedNew);
    if (oldP === null) {
      const np = newP!;
      if (np === null || np === undefined) throw new Fail('unsafe', '');
      if (!safe(np)) throw new Fail('unsafe', np);
      if (tree.taken(np)) throw new Fail('exists', np);
      const plus: string[] = [];
      let lastPlusBs = false;
      for (const h of s.hunks)
        for (const it of h.items)
          if (it.t === '+') {
            plus.push(it.text);
            lastPlusBs = it.bs;
          }
      tree.now.set(np, toText({ lines: plus, brk: '\n', fin: !lastPlusBs }));
      return;
    }
    if (newP === null) {
      const op = oldP!;
      if (!safe(op)) throw new Fail('unsafe', op);
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    const op = oldP!;
    const np = newP!;
    if (!safe(op)) throw new Fail('unsafe', op);
    if (!safe(np)) throw new Fail('unsafe', np);
    const before = tree.get(op);
    if (before === null) throw new Fail('missing', op);
    if (op !== np && tree.taken(np)) throw new Fail('exists', np);
    const fl = applyHunks(before, s.hunks, strict, op);
    if (op !== np) {
      tree.now.set(np, toText(fl));
      tree.now.set(op, null);
      moves.push([op, np] as const);
    } else tree.now.set(op, toText(fl));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let inHeader = false;
  let i = 0;
  const isPairAt = (k: number): boolean => (lines[k] ?? '').startsWith('--- ') && (lines[k + 1] ?? '').startsWith('+++ ');
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/([\s\S]*?) b\/([\s\S]+)$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = { gitOld: m[1]!, gitNew: m[2]!, newFile: false, delFile: false, hunks: [] };
      sections.push(cur);
      inHeader = true;
      i++;
      continue;
    }
    if (isPairAt(i)) {
      if (cur === null || !inHeader || cur.pairOld !== undefined) {
        cur = { newFile: false, delFile: false, hunks: [] };
        sections.push(cur);
      }
      cur.pairOld = cleanUPath(headerPath(l));
      cur.pairNew = cleanUPath(headerPath(lines[i + 1]!));
      inHeader = true;
      i += 2;
      continue;
    }
    if (l.startsWith('--- ') && cur !== null && inHeader) throw new Exit2(`error: parse ${i + 2}`);
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseInt(m[1]!, 10);
      const aRaw = m[1]!;
      i++;
      const items: BodyItem[] = [];
      while (i < lines.length) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ') || isPairAt(i)) break;
        const c = bl.charAt(0);
        if (bl === '') {
          items.push({ t: ' ', text: '', bs: false, emptyLine: true });
          i++;
        } else if (c === ' ') {
          items.push({ t: ' ', text: bl.slice(1), bs: false, emptyLine: false });
          i++;
        } else if (c === '-') {
          items.push({ t: '-', text: bl.slice(1), bs: false, emptyLine: false });
          i++;
        } else if (c === '+') {
          items.push({ t: '+', text: bl.slice(1), bs: false, emptyLine: false });
          i++;
        } else if (c === '\\') {
          const last = items[items.length - 1];
          if (last !== undefined) last.bs = true;
          i++;
        } else break;
      }
      while (items.length > 0 && items[items.length - 1]!.emptyLine && !items[items.length - 1]!.bs) items.pop();
      cur.hunks.push({ a, aRaw, items });
      inHeader = false;
      continue;
    }
    if (cur !== null && inHeader) {
      if (l.startsWith('rename from ')) {
        cur.renFrom = l.slice(12);
        i++;
        continue;
      }
      if (l.startsWith('rename to ')) {
        cur.renTo = l.slice(10);
        i++;
        continue;
      }
      if (l === 'new file mode' || l.startsWith('new file mode ')) {
        cur.newFile = true;
        i++;
        continue;
      }
      if (l === 'deleted file mode' || l.startsWith('deleted file mode ')) {
        cur.delFile = true;
        i++;
        continue;
      }
    }
    i++;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedEdit(s, strict));
}

// ---- Section 7: SEARCH/REPLACE blocks ----

function srEdits(lines: string[], strict: boolean): Edit[] {
  const trimTrailWs = (s: string): string => s.replace(/\s+$/, '');
  interface Block {
    path: string;
    old: string[];
    neu: string[];
  }
  const blocks: Block[] = [];
  let prevPath: string | undefined;
  let prevEnd = 0;
  let i = 0;
  while (i < lines.length) {
    if (trimTrailWs(lines[i]!) !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const at = i;
    let path: string | undefined;
    for (let j = at - 1; j >= prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === undefined) path = prevPath;
    if (path === undefined) throw new Exit2(`error: parse ${at + 1}`);
    let k = at + 1;
    while (k < lines.length && trimTrailWs(lines[k]!) !== '=======') k++;
    if (k >= lines.length) throw new Exit2(`error: parse ${at + 1}`);
    let m = k + 1;
    while (m < lines.length && trimTrailWs(lines[m]!) !== '>>>>>>> REPLACE') m++;
    if (m >= lines.length) throw new Exit2(`error: parse ${at + 1}`);
    blocks.push({ path, old: lines.slice(at + 1, k), neu: lines.slice(k + 1, m) });
    prevPath = path;
    prevEnd = m + 1;
    i = m + 1;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map(
    (b) =>
      (tree: Tree): void => {
        if (!safe(b.path)) throw new Fail('unsafe', b.path);
        if (b.old.length === 0) {
          if (tree.taken(b.path)) throw new Fail('exists', b.path);
          tree.now.set(b.path, toText({ lines: [...b.neu], brk: '\n', fin: true }));
          return;
        }
        const before = tree.get(b.path);
        if (before === null) throw new Fail('missing', b.path);
        const fl = toLines(before);
        const hit = findTier(fl.lines, b.old, strict);
        if (hit === null) throw new Fail('no-match', b.path);
        if (hit.occ.length > 1) throw new Fail('ambiguous', b.path);
        const at = hit.occ[0]!;
        const built = buildN(
          b.neu.map((s) => ({ add: s })),
          b.old,
          fl.lines,
          at,
          hit.tier,
        );
        fl.lines.splice(at, b.old.length, ...built);
        tree.now.set(b.path, toText(fl));
      },
  );
}

// ---- Section 8: V4A patches ----

interface VChunk {
  anchor: string | null;
  items: BodyItem[];
  eof: boolean;
  implicit: boolean;
}

type VSection =
  | { kind: 'add'; path: string; fileLines: string[] }
  | { kind: 'del'; path: string }
  | { kind: 'upd'; path: string; moveTo?: string; chunks: VChunk[] };

function v4aEdit(s: VSection, strict: boolean): Edit {
  return (tree, moves) => {
    if (s.kind === 'add') {
      if (!safe(s.path)) throw new Fail('unsafe', s.path);
      if (tree.taken(s.path)) throw new Fail('exists', s.path);
      tree.now.set(s.path, toText({ lines: [...s.fileLines], brk: '\n', fin: true }));
      return;
    }
    if (s.kind === 'del') {
      if (!safe(s.path)) throw new Fail('unsafe', s.path);
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
      return;
    }
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (s.moveTo !== undefined && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
    const before = tree.get(s.path);
    if (before === null) throw new Fail('missing', s.path);
    if (s.moveTo !== undefined && tree.taken(s.moveTo)) throw new Fail('exists', s.moveTo);
    const fl = toLines(before);
    let cursor = 0;
    for (const chunk of s.chunks) {
      if (chunk.anchor !== null) {
        const tiers = strict ? [0] : [0, 1, 2];
        let found = -1;
        for (const tier of tiers) {
          for (let k = cursor; k < fl.lines.length; k++) {
            if (eqLine(fl.lines[k]!, chunk.anchor, tier)) {
              found = k;
              break;
            }
          }
          if (found >= 0) break;
        }
        if (found < 0) throw new Fail('no-match', s.path);
        cursor = found + 1;
      }
      const { o, n } = hunkON(chunk.items);
      if (o.length === 0) {
        const built = n.map((it) => ('add' in it ? it.add : ''));
        const pos = chunk.eof ? fl.lines.length : Math.min(cursor, fl.lines.length);
        fl.lines.splice(pos, 0, ...built);
        cursor = pos + built.length;
        continue;
      }
      const hit = findTier(fl.lines, o, strict, cursor, chunk.eof ? (at) => at + o.length === fl.lines.length : undefined);
      if (hit === null) throw new Fail('no-match', s.path);
      const at = hit.occ[0]!;
      const built = buildN(n, o, fl.lines, at, hit.tier);
      fl.lines.splice(at, o.length, ...built);
      cursor = at + built.length;
    }
    if (s.moveTo !== undefined) {
      tree.now.set(s.moveTo, toText(fl));
      tree.now.set(s.path, null);
      moves.push([s.path, s.moveTo] as const);
    } else tree.now.set(s.path, toText(fl));
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last > first && blank(lines[last]!)) last--;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isStart = (l: string): boolean => l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (l.startsWith('*** Add File: ')) {
      const path = trimSpaces(l.slice(14));
      i++;
      const body: { text: string; emptyLine: boolean; wsLine?: number }[] = [];
      while (i < last && !isStart(lines[i]!)) {
        const bl = lines[i]!;
        if (bl.startsWith('+')) {
          body.push({ text: bl.slice(1), emptyLine: false });
          i++;
        } else if (bl.trim() === '') {
          body.push({ text: '', emptyLine: true, wsLine: bl === '' ? undefined : i + 1 });
          i++;
        } else throw new Exit2(`error: parse ${i + 1}`);
      }
      while (body.length > 0 && body[body.length - 1]!.emptyLine) body.pop();
      for (const b of body) if (b.wsLine !== undefined) throw new Exit2(`error: parse ${b.wsLine}`);
      sections.push({ kind: 'add', path, fileLines: body.map((b) => b.text) });
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const path = trimSpaces(l.slice(17));
      i++;
      while (i < last && !isStart(lines[i]!)) {
        if (!blank(lines[i]!)) throw new Exit2(`error: parse ${i + 1}`);
        i++;
      }
      sections.push({ kind: 'del', path });
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const path = trimSpaces(l.slice(17));
      const atLine = i + 1;
      i++;
      let moveTo: string | undefined;
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      let sawContent = false;
      const close = (): void => {
        if (cur !== null) {
          chunks.push(cur);
          cur = null;
        }
      };
      while (i < last && !isStart(lines[i]!)) {
        const bl = lines[i]!;
        const lineNo = i + 1;
        if (bl === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${lineNo}`);
          cur.eof = true;
          close();
          sawContent = true;
          i++;
          continue;
        }
        if (bl.startsWith('*** Move to: ')) {
          if (sawContent || moveTo !== undefined) throw new Exit2(`error: parse ${lineNo}`);
          moveTo = trimSpaces(bl.slice(13));
          sawContent = true;
          i++;
          continue;
        }
        if (bl.startsWith('@@')) {
          close();
          const anchor = trimSpaces(bl.slice(2));
          cur = { anchor: anchor === '' ? null : anchor, items: [], eof: false, implicit: false };
          sawContent = true;
          i++;
          continue;
        }
        const c = bl.charAt(0);
        const isBody = bl === '' || c === ' ' || c === '-' || c === '+';
        const isBlankOnly = !isBody && bl.trim() === '';
        if (isBody || isBlankOnly) {
          let item: BodyItem;
          if (bl === '') item = { t: ' ', text: '', bs: false, emptyLine: true };
          else if (isBlankOnly) item = { t: ' ', text: '', bs: false, emptyLine: true, wsLine: lineNo };
          else item = { t: c as ' ' | '-' | '+', text: bl.slice(1), bs: false, emptyLine: c === ' ' && bl.trim() === '' };
          if (cur !== null) cur.items.push(item);
          else if (chunks.length === 0) {
            cur = { anchor: null, items: [item], eof: false, implicit: true };
          } else if (bl === '' || isBlankOnly) {
            // A blank line after a closed chunk, before the next section: part of no chunk.
            i++;
            continue;
          } else throw new Exit2(`error: parse ${lineNo}`);
          sawContent = true;
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${lineNo}`);
      }
      close();
      const lastChunk = chunks[chunks.length - 1];
      if (lastChunk !== undefined && !lastChunk.eof)
        while (lastChunk.items.length > 0 && lastChunk.items[lastChunk.items.length - 1]!.emptyLine) lastChunk.items.pop();
      if (lastChunk !== undefined && lastChunk.implicit && lastChunk.items.every((it) => it.emptyLine)) chunks.pop();
      for (const ch of chunks) for (const it of ch.items) if (it.wsLine !== undefined) throw new Exit2(`error: parse ${it.wsLine}`);
      if (chunks.length === 0 && moveTo === undefined) throw new Exit2(`error: parse ${atLine}`);
      sections.push({ kind: 'upd', path, moveTo, chunks });
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => v4aEdit(s, strict));
}

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
  const moves: Array<readonly [string, string]> = [];
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = moves.length;
    try {
      edit(tree, moves);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const state = (p: string): string | null => (tree.now.has(p) ? tree.now.get(p)! : tree.original(p));
  const consumed = new Set<string>();
  const keyed: { key: string; line: string }[] = [];
  for (const [o, n] of moves) {
    if (consumed.has(o) || consumed.has(n)) continue;
    if (tree.original(o) !== null && state(o) === null && tree.original(n) === null && state(n) !== null) {
      keyed.push({ key: n, line: `R ${o} -> ${n}` });
      consumed.add(o);
      consumed.add(n);
    }
  }
  for (const p of tree.now.keys()) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    keyed.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  keyed.sort((x, y) => Buffer.compare(Buffer.from(x.key), Buffer.from(y.key)));
  const rows = keyed.map((r) => r.line);
  if (!check) {
    const changed = [...tree.now.keys()].filter((p) => tree.original(p) !== tree.now.get(p));
    for (const p of changed) if (tree.now.get(p) === null) rmSync(p, { force: true });
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
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
