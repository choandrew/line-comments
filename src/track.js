// @ts-check
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

/**
 * @typedef {import('./store').Anchor} Anchor
 * @typedef {{ path: string, line: number, stale: boolean }} Located `line` is 0-based
 * @typedef {{ start: number, removed: number, newStart: number, added: number }} Hunk
 * @typedef {{ file: string, lines: string[], hunks: Hunk[] | undefined }} FileState hunks undefined: no history
 */

/** @param {string} root @param {string[]} args @returns {Promise<string>} */
function git(root, ...args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }, (err, out, errOut) => {
      if (err) reject(new Error(`git ${args[0]}: ${(errOut || err.message).trim()}`));
      else resolve(out.trim());
    });
  });
}

// At most this many git processes at once, so a cold start over many files doesn't flood the machine.
const GIT_PARALLEL = 8;

/**
 * Locates threads in the working tree. Replays git's diff from the commit each comment was written on,
 * following renames and the lines added or removed above it. When the diff edits that line, only the
 * edit's own new lines are searched for its text; when the commit is not in this clone, the whole file
 * is. Not found means stale. Diffs are cached per commit and file until HEAD or the file changes, so
 * a sync where nothing moved runs no git at all.
 */
function tracker() {
  /** @type {Map<string, Promise<FileState>>} */
  let files = new Map();

  /**
   * @param {string} root @param {string} head HEAD's sha, part of every cache key
   * @param {Anchor[]} anchors @returns {Promise<Located[]>}
   */
  async function locateAll(root, head, anchors) {
    /** @type {Map<string, Promise<FileState>>} */
    const used = new Map();
    /** @type {(() => Promise<void>)[]} */
    const queue = [];
    const states = anchors.map((a) => {
      const st = stamp(path.join(root, a.path));
      const key = `${a.commit}\0${a.path}\0${head}\0${st}`;
      // A missing path means a rename, whose new file's edits the key can't see, so it isn't reused.
      let state = used.get(key) ?? (st === '-' ? undefined : files.get(key));
      if (!state) state = new Promise((resolve) => queue.push(() => load(root, a).then(resolve)));
      used.set(key, state);
      return state;
    });
    // Only entries this call used survive, so the cache never outgrows the threads on screen.
    files = used;
    await Promise.all(
      Array.from({ length: GIT_PARALLEL }, async () => {
        for (let job = queue.shift(); job; job = queue.shift()) await job();
      }),
    );
    return Promise.all(anchors.map(async (a, i) => place(a, await states[i])));
  }

  /** Forgets every cached diff, for an explicit refresh. */
  const clear = () => (files = new Map());

  return { locateAll, clear };
}

/** @param {string} root @param {Anchor} a @returns {Promise<FileState>} */
async function load(root, a) {
  let file = a.path;
  /** @type {Hunk[] | undefined} */
  let hunks;
  try {
    if (!fs.existsSync(path.join(root, file))) file = (await renamedTo(root, a)) ?? file;
    hunks = parseHunks(await git(root, 'diff', '-M', '-U0', '--no-color', '--no-ext-diff', a.commit, '--', a.path, file));
  } catch {
    // The commit is missing locally (pull main) or was rewritten; place() falls back to the text.
  }
  const full = path.join(root, file);
  const lines = fs.existsSync(full) ? (await fs.promises.readFile(full, 'utf8')).split(/\r?\n/) : [];
  return { file, lines, hunks };
}

/** @param {Anchor} a @param {FileState} s @returns {Located} */
function place(a, s) {
  const now = s.hunks ? shift(s.hunks, a.line) : { from: 1, to: Infinity, near: a.line };
  const clamp = (/** @type {number} */ i) => Math.max(0, Math.min(i, s.lines.length - 1));
  const at = clamp(now.near - 1);
  let best = -1;
  for (let i = clamp(now.from - 1); i < Math.min(now.to, s.lines.length + 1) - 1; i++) {
    if (s.lines[i] === a.text && (best < 0 || Math.abs(i - at) < Math.abs(best - at))) best = i;
  }
  return best >= 0 ? { path: s.file, line: best, stale: false } : { path: s.file, line: at, stale: true };
}

/** A file's mtime and size, or `-` when missing; in the cache key so a saved edit re-diffs. @param {string} file */
function stamp(file) {
  try {
    const st = fs.statSync(file);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return '-';
  }
}

/** The file's path now, if git sees it renamed since the anchor's commit. @param {string} root @param {Anchor} a */
async function renamedTo(root, a) {
  // -z output is status, path[, new path] for renames and copies, all NUL-separated.
  const t = (await git(root, 'diff', '-M', '--name-status', '-z', a.commit)).split('\0');
  for (let i = 0; i < t.length; i += /^[RC]/.test(t[i]) ? 3 : 2) {
    if (t[i].startsWith('R') && t[i + 1] === a.path) return t[i + 2];
  }
  return undefined;
}

/** @param {string} diff a `-U0` diff @returns {Hunk[]} */
function parseHunks(diff) {
  return [...diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].map((m) => ({
    start: Number(m[1]),
    removed: m[2] === undefined ? 1 : Number(m[2]),
    newStart: Number(m[3]),
    added: m[4] === undefined ? 1 : Number(m[4]),
  }));
}

/**
 * 1-based new lines [from, to) where old `line` can be after the hunks: just its shifted position,
 * or the replacement lines when a hunk edits it. `near` is where to look first.
 * @param {Hunk[]} hunks @param {number} line @returns {{ from: number, to: number, near: number }}
 */
function shift(hunks, line) {
  let offset = 0;
  for (const { start, removed, newStart, added } of hunks) {
    // A pure insertion (removed 0) goes after old line `start`; otherwise it replaces start..start+removed-1.
    if (removed === 0 ? line <= start : line < start) break;
    if (line < start + removed) return { from: newStart, to: newStart + added, near: newStart + (line - start) };
    offset += added - removed;
  }
  return { from: line + offset, to: line + offset + 1, near: line + offset };
}

module.exports = { git, tracker };
