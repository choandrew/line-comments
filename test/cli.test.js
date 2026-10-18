// @ts-check
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const blob = require('../src/blob');
const store = require('../src/store');

const CLI = path.join(__dirname, '..', 'bin', 'line-comments.js');
const APP = ['def add(a, b):', '    total = a + b', '    return total', '', 'def mul(a, b):', '    total = a * b', '    return total', ''];

/** @param {string} root @param {string[]} args */
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'line-comments-'));

/** A clone of owner/proj.git with src/app.py and docs/notes.md committed; returns its root and that commit. */
function clone() {
  const top = tmp();
  const seed = path.join(top, 'seed');
  fs.mkdirSync(path.join(seed, 'src'), { recursive: true });
  fs.mkdirSync(path.join(seed, 'docs'));
  fs.writeFileSync(path.join(seed, 'src/app.py'), APP.join('\n'));
  fs.writeFileSync(path.join(seed, 'docs/notes.md'), 'Teh notes\n');
  git(seed, 'init', '-q', '-b', 'main');
  commit(seed);
  git(top, 'clone', '-q', '--bare', 'seed', 'owner/proj.git');
  git(top, 'clone', '-q', 'owner/proj.git', 'work');
  const root = path.join(top, 'work');
  return { root, commit: git(root, 'rev-parse', 'HEAD') };
}

/** @param {string} root */
function commit(root) {
  git(root, 'add', '-A');
  git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'c');
}

/** @param {string} root @param {NodeJS.ProcessEnv} env */
const run = (root, env) => execFileSync(process.execPath, [CLI, 'open'], { cwd: root, encoding: 'utf8', env, stdio: 'pipe' });

/** @param {string} author @param {string} body @param {number} minute */
const by = (author, body, minute) => ({ author, body, at: `2026-01-01T10:0${minute}:00.000Z` });

test('open threads print re-anchored to the working tree, sorted, with replies and stale marks', async () => {
  // Catches: the CLI printing stored line numbers instead of tracked ones, listing archived threads, or dropping replies.
  const { root, commit: c } = clone();
  const dir = tmp();
  const s = store.open(blob.folder(dir), 'owner/proj/');
  const moved = await s.create({ path: 'src/app.py', line: 7, text: '    return total', commit: c }, by('Ada', 'Name this product?', 0));
  await s.reply(moved, by('Grace', 'Keeps a breakpoint spot.\nAnd a print.', 1));
  await s.create({ path: 'src/app.py', line: 2, text: '    total = a + b', commit: c }, by('Ada', 'Return directly?', 0));
  await s.create({ path: 'docs/notes.md', line: 1, text: 'Teh notes', commit: c }, by('Ada', 'Typo.', 0));
  const archived = await s.create({ path: 'src/app.py', line: 6, text: '    total = a * b', commit: c }, by('Ada', 'Done.', 0));
  await s.setArchived(archived, true);
  fs.writeFileSync(path.join(root, 'src/app.py'), ['import math', '', 'def add(a, b):', '    return a + b', '', ...APP.slice(4)].join('\n'));
  commit(root);
  assert.equal(
    run(root, { ...process.env, LINE_COMMENTS_LOCATION: dir }),
    [
      'docs/notes.md:1: [Ada] Typo.',
      'src/app.py:4: [Ada] Return directly? (line changed since: total = a + b)',
      'src/app.py:8: [Ada] Name this product?',
      '  [Grace] Keeps a breakpoint spot.',
      '    And a print.',
      '',
    ].join('\n'),
  );
});

test('the location comes from the repo settings file, which may hold comments and trailing commas', async () => {
  // Catches: JSONC settings failing to parse, or comment markers inside strings being stripped.
  const { root, commit: c } = clone();
  const dir = tmp();
  await store.open(blob.folder(dir), 'owner/proj/').create({ path: 'src/app.py', line: 3, text: '    return total', commit: c }, by('Ada', 'Hi', 0));
  fs.mkdirSync(path.join(root, '.vscode'));
  const settings = `{
    // where threads live
    "lineComments.location": ${JSON.stringify(`${dir}//`)}, /* trailing slashes, not a comment */
    "other": "a \\" // b /* c */",
    "list": [1, 2,],
  }`;
  fs.writeFileSync(path.join(root, '.vscode/settings.json'), settings);
  const env = { ...process.env };
  delete env.LINE_COMMENTS_LOCATION;
  assert.equal(run(root, env), 'src/app.py:3: [Ada] Hi\n');
});

test("the location comes from Cursor's user settings, and VS Code and Cursor disagreeing is an error", async () => {
  // Catches: a Cursor-only user's settings being ignored, or the CLI silently picking one of two different stores.
  const { root, commit: c } = clone();
  const dir = tmp();
  await store.open(blob.folder(dir), 'owner/proj/').create({ path: 'src/app.py', line: 3, text: '    return total', commit: c }, by('Ada', 'Hi', 0));
  const home = tmp();
  /** @param {string} editor @param {string} location */
  const settle = (editor, location) => {
    const user = path.join(home, ...(process.platform === 'darwin' ? ['Library', 'Application Support'] : ['.config']), editor, 'User');
    fs.mkdirSync(user, { recursive: true });
    fs.writeFileSync(path.join(user, 'settings.json'), JSON.stringify({ 'lineComments.location': location }));
  };
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env, HOME: home };
  delete env.LINE_COMMENTS_LOCATION;
  settle('Cursor', dir);
  assert.equal(run(root, env), 'src/app.py:3: [Ada] Hi\n');
  settle('Code', tmp());
  assert.throws(() => run(root, env), /lineComments\.location differs between/);
});
