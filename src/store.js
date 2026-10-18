// @ts-check
// A repo's threads under `base` in a blob: <thread-id>/thread.json holds the anchor and archive flag, and
// each comment is its own immutable <comment-id>.json, so people replying at once never conflict.
const crypto = require('crypto');

/**
 * @typedef {import('./blob').Blob} Blob
 * @typedef {{ author: string, body: string, at: string }} Comment
 * @typedef {{ path: string, line: number, text: string, commit: string, archived: boolean }} Anchor
 * @typedef {Anchor & { comments: Comment[] }} Thread
 * @typedef {{ id: string, thread: Thread } | { id: string, error: string }} Loaded
 */

const THREAD = 'thread.json';

/** @param {Blob} blob @param {string} base the repo's key prefix, ending in '/' */
function open(blob, base) {
  // Parsed files by key, reused while their version is unchanged, so a poll fetches only what changed.
  /** @type {Map<string, { version: string, value: unknown }>} */
  const cache = new Map();

  /** @param {string} key @param {string} version */
  async function load(key, version) {
    const hit = cache.get(key);
    if (hit?.version === version) return hit.value;
    const text = await blob.get(base + key);
    let value;
    try {
      value = JSON.parse(text);
    } catch (e) {
      throw new Error(`${base}${key}: ${e instanceof Error ? e.message : e}`);
    }
    cache.set(key, { version, value });
    return value;
  }

  /** @returns {Promise<Loaded[]>} */
  async function readAll() {
    const files = await blob.list(base);
    /** @type {Map<string, Map<string, string>>} thread id -> file name -> version */
    const threads = new Map();
    for (const [key, version] of files) {
      const [id, name, ...rest] = key.slice(base.length).split('/');
      if (name === undefined || rest.length > 0 || !name.endsWith('.json')) continue;
      threads.set(id, (threads.get(id) ?? new Map()).set(name, version));
    }
    for (const key of cache.keys()) if (!files.has(base + key)) cache.delete(key);
    const ids = [...threads.keys()].filter((id) => threads.get(id)?.has(THREAD)).sort();
    return Promise.all(
      ids.map(async (id) => {
        try {
          return { id, thread: await read(id, /** @type {Map<string, string>} */ (threads.get(id))) };
        } catch (e) {
          return { id, error: e instanceof Error ? e.message : String(e) };
        }
      }),
    );
  }

  /** @param {string} id @param {Map<string, string>} names @returns {Promise<Thread>} */
  async function read(id, names) {
    const anchor = parseAnchor(await load(`${id}/${THREAD}`, /** @type {string} */ (names.get(THREAD))), `${base}${id}/${THREAD}`);
    const comments = await Promise.all(
      [...names]
        .filter(([name]) => name !== THREAD)
        .map(async ([name, version]) => parseComment(await load(`${id}/${name}`, version), `${base}${id}/${name}`)),
    );
    if (comments.length === 0) throw new Error(`${base}${id} has no comments`);
    comments.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    return { ...anchor, comments };
  }

  /** @param {Omit<Anchor, 'archived'>} anchor @param {Comment} first @returns {Promise<string>} */
  async function create(anchor, first) {
    const id = crypto.randomUUID();
    // The comment goes first: readers only see a thread once thread.json exists.
    await reply(id, first);
    await put(`${id}/${THREAD}`, { ...anchor, archived: false });
    return id;
  }

  /** @param {string} id @param {Comment} comment */
  const reply = (id, comment) => put(`${id}/${crypto.randomUUID()}.json`, comment);

  /** @param {string} id @param {boolean} archived */
  async function setArchived(id, archived) {
    const key = `${id}/${THREAD}`;
    const anchor = parseAnchor(JSON.parse(await blob.get(base + key)), base + key);
    await put(key, { ...anchor, archived });
  }

  /** @param {string} id */
  async function remove(id) {
    // thread.json goes first, so a reader racing the delete never sees a thread missing its comments.
    await blob.del(`${base}${id}/${THREAD}`);
    for (const key of (await blob.list(`${base}${id}/`)).keys()) await blob.del(key);
  }

  /** @param {string} key @param {unknown} value */
  const put = (key, value) => blob.put(base + key, JSON.stringify(value, null, 2) + '\n');

  return { readAll, create, reply, setArchived, remove };
}

/** @param {any} v @param {string} file @returns {Anchor} */
function parseAnchor(v, file) {
  const p = v?.path;
  if (typeof p !== 'string' || p === '' || p.startsWith('/') || p.split(/[\\/]/).includes('..')) bad(file, 'path');
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

module.exports = { open };
