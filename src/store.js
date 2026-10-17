// @ts-check
// Threads live in <dir>/<thread-id>/: thread.json holds the anchor and archive flag, and each comment is
// its own immutable file, so people replying at once never conflict in a synced folder or in git.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * @typedef {{ author: string, body: string, at: string }} Comment
 * @typedef {{ path: string, line: number, text: string, commit: string, archived: boolean }} Anchor
 * @typedef {Anchor & { comments: Comment[] }} Thread
 */

const THREAD = 'thread.json';

/** @param {string} dir @returns {string[]} */
function list(dir) {
  return fs
    .readdirSync(dir)
    .filter((id) => fs.existsSync(path.join(dir, id, THREAD)))
    .sort();
}

/** @param {string} dir @param {string} id @returns {Thread} */
function read(dir, id) {
  const thread = path.join(dir, id);
  const file = path.join(thread, THREAD);
  const anchor = parseAnchor(readJson(file), file);
  const comments = fs
    .readdirSync(thread)
    .filter((f) => f.endsWith('.json') && f !== THREAD)
    .map((f) => parseComment(readJson(path.join(thread, f)), path.join(thread, f)))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (comments.length === 0) throw new Error(`${thread} has no comments`);
  return { ...anchor, comments };
}

/** @param {string} dir @param {Omit<Anchor, 'archived'>} anchor @param {Comment} first @returns {string} */
function create(dir, anchor, first) {
  const id = crypto.randomUUID();
  fs.mkdirSync(path.join(dir, id), { recursive: true });
  // The comment goes first: list() only sees a thread once thread.json exists.
  reply(dir, id, first);
  writeJson(path.join(dir, id, THREAD), { ...anchor, archived: false });
  return id;
}

/** @param {string} dir @param {string} id @param {Comment} comment */
function reply(dir, id, comment) {
  writeJson(path.join(dir, id, `${crypto.randomUUID()}.json`), comment);
}

/** @param {string} dir @param {string} id @param {boolean} archived */
function setArchived(dir, id, archived) {
  const file = path.join(dir, id, THREAD);
  writeJson(file, { ...parseAnchor(readJson(file), file), archived });
}

/** @param {string} dir @param {string} id */
function remove(dir, id) {
  fs.rmSync(path.join(dir, id), { recursive: true });
}

/** @param {string} file @returns {any} */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${file}: ${e instanceof Error ? e.message : e}`);
  }
}

/** @param {string} file @param {unknown} value */
function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

/** @param {any} v @param {string} file @returns {Anchor} */
function parseAnchor(v, file) {
  const p = v?.path;
  if (typeof p !== 'string' || p === '' || path.isAbsolute(p) || p.split(/[\\/]/).includes('..')) bad(file, 'path');
  if (!Number.isInteger(v.line) || v.line < 1) bad(file, 'line');
  if (typeof v.text !== 'string') bad(file, 'text');
  if (typeof v.commit !== 'string' || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(v.commit)) bad(file, 'commit');
  if (typeof v.archived !== 'boolean') bad(file, 'archived');
  return { path: p, line: v.line, text: v.text, commit: v.commit, archived: v.archived };
}

/** @param {any} v @param {string} file @returns {Comment} */
function parseComment(v, file) {
  for (const field of ['author', 'body', 'at']) if (typeof v?.[field] !== 'string' || v[field] === '') bad(file, field);
  if (Number.isNaN(Date.parse(v.at))) bad(file, 'at');
  return { author: v.author, body: v.body, at: v.at };
}

/** @param {string} file @param {string} field @returns {never} */
function bad(file, field) {
  throw new Error(`${file}: invalid or missing "${field}"`);
}

module.exports = { list, read, create, reply, setArchived, remove };
