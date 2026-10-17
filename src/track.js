// @ts-check
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/** @typedef {import('./store').Anchor} Anchor */

/** @param {string} root @param {string[]} args @returns {string} */
function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/**
 * Where an anchored line is in the working tree now. Replays git's diff from the commit the comment
 * was written on, following renames and the lines added or removed above it. When the diff edits
 * that line, only the edit's own new lines are searched for its text; when the commit is not in this
 * clone, the whole file is. Not found means stale.
 * @param {string} root @param {Anchor} anchor
 * @returns {{ path: string, line: number, stale: boolean }} `line` is 0-based
 */
function locate(root, anchor) {
  let file = anchor.path;
  /** @type {Shifted} */
  let now;
  try {
    if (!fs.existsSync(path.join(root, file))) file = renamedTo(root, anchor) ?? file;
    now = shift(git(root, 'diff', '-M', '-U0', '--no-color', '--no-ext-diff', anchor.commit, '--', anchor.path, file), anchor.line);
  } catch {
    // The commit is missing locally (pull main) or was rewritten.
    now = { from: 1, to: Infinity, near: anchor.line };
  }
  const full = path.join(root, file);
  const lines = fs.existsSync(full) ? fs.readFileSync(full, 'utf8').split(/\r?\n/) : [];
  const clamp = (/** @type {number} */ i) => Math.max(0, Math.min(i, lines.length - 1));
  const at = clamp(now.near - 1);
  let best = -1;
  for (let i = clamp(now.from - 1); i < Math.min(now.to, lines.length + 1) - 1; i++) {
    if (lines[i] === anchor.text && (best < 0 || Math.abs(i - at) < Math.abs(best - at))) best = i;
  }
  return best >= 0 ? { path: file, line: best, stale: false } : { path: file, line: at, stale: true };
}

/** The file's path now, if git sees it renamed since the anchor's commit. @param {string} root @param {Anchor} anchor */
function renamedTo(root, anchor) {
  // -z output is status, path[, new path] for renames and copies, all NUL-separated.
  const t = git(root, 'diff', '-M', '--name-status', '-z', anchor.commit).split('\0');
  for (let i = 0; i < t.length; i += /^[RC]/.test(t[i]) ? 3 : 2) {
    if (t[i].startsWith('R') && t[i + 1] === anchor.path) return t[i + 2];
  }
  return undefined;
}

/**
 * 1-based new lines [from, to) where old `line` can be after a `-U0` diff: just its shifted position,
 * or the replacement lines when the diff edits it. `near` is where to look first.
 * @typedef {{ from: number, to: number, near: number }} Shifted
 * @param {string} diff @param {number} line @returns {Shifted}
 */
function shift(diff, line) {
  let offset = 0;
  for (const m of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1]);
    const removed = m[2] === undefined ? 1 : Number(m[2]);
    const newStart = Number(m[3]);
    const added = m[4] === undefined ? 1 : Number(m[4]);
    // A pure insertion (removed 0) goes after old line `start`; otherwise it replaces start..start+removed-1.
    if (removed === 0 ? line <= start : line < start) break;
    if (line < start + removed) return { from: newStart, to: newStart + added, near: newStart + (line - start) };
    offset += added - removed;
  }
  return { from: line + offset, to: line + offset + 1, near: line + offset };
}

module.exports = { git, locate };
