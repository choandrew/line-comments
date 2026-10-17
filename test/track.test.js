// @ts-check
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { git, locate } = require('../src/track');

const ADD = ['def add(a, b):', '    total = a + b', '    return total', ''];
const MUL = ['def mul(a, b):', '    total = a * b', '    return total', ''];

/** A repo with src/app.py committed; returns its root and that commit. */
function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'line-comments-'));
  git(root, 'init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/app.py'), [...ADD, ...MUL].join('\n'));
  return { root, commit: commit(root) };
}

/** @param {string} root */
function commit(root) {
  git(root, 'add', '-A');
  git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'c');
  return git(root, 'rev-parse', 'HEAD');
}

/** mul's `return total`: the same text as add's, so only history tells them apart. */
const anchorOn = (/** @type {string} */ c) => ({ path: 'src/app.py', line: 7, text: '    return total', commit: c, archived: false });

test('a thread follows its line when commits on main add lines above it', () => {
  // Catches: threads left on the old line number, or jumping to the first identical line (add's return).
  const { root, commit: c } = repo();
  fs.writeFileSync(path.join(root, 'src/app.py'), ['import math', '', ...ADD, ...MUL].join('\n'));
  commit(root);
  assert.deepEqual(locate(root, anchorOn(c)), { path: 'src/app.py', line: 8, stale: false });
});

test('a thread follows its file through a rename', () => {
  // Catches: threads vanishing when main renames the file.
  const { root, commit: c } = repo();
  git(root, 'mv', 'src/app.py', 'src/calc.py');
  fs.writeFileSync(path.join(root, 'src/calc.py'), ['"""Calc."""', ...ADD, ...MUL].join('\n'));
  commit(root);
  assert.deepEqual(locate(root, anchorOn(c)), { path: 'src/calc.py', line: 7, stale: false });
});

test('a thread is marked stale when its own line is rewritten', () => {
  // Catches: a comment silently attaching to code it was not written about.
  const { root, commit: c } = repo();
  fs.writeFileSync(path.join(root, 'src/app.py'), [...ADD, 'def mul(a, b):', '    return a * b', ''].join('\n'));
  commit(root);
  assert.equal(locate(root, anchorOn(c)).stale, true);
});

test('a thread from a commit this clone lacks falls back to the nearest matching text', () => {
  // Catches: a coworker on a newer main making threads disappear or throw for someone who has not pulled.
  const { root } = repo();
  assert.deepEqual(locate(root, anchorOn('b'.repeat(40))), { path: 'src/app.py', line: 6, stale: false });
});

test('a thread follows its line when the same commit edits lines right around it', () => {
  // Catches: a thread going stale just because its line sits inside a larger edit.
  const { root, commit: c } = repo();
  fs.writeFileSync(path.join(root, 'src/app.py'), [...ADD, 'def mul(a, b):', '    # product', '    total = a * b  # x', '    return total', ''].join('\n'));
  commit(root);
  assert.deepEqual(locate(root, anchorOn(c)), { path: 'src/app.py', line: 7, stale: false });
});
