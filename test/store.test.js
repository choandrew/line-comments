// @ts-check
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../src/store');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'line-comments-'));
const anchor = { path: 'src/app.py', line: 3, text: '    total = a + b', commit: 'a'.repeat(40) };
/** @param {string} body @param {string} at */
const comment = (body, at) => ({ author: 'Ada', body, at });

test('replies from several people read back as one thread in time order', () => {
  // Catches: replies stored in one shared file (sync conflicts) or returned out of order.
  const dir = tmp();
  const id = store.create(dir, anchor, comment('first', '2026-01-01T10:00:00.000Z'));
  store.reply(dir, id, comment('third', '2026-01-01T12:00:00.000Z'));
  store.reply(dir, id, { author: 'Grace', body: 'second', at: '2026-01-01T06:00:00-05:00' });

  assert.deepEqual(store.list(dir), [id]);
  const thread = store.read(dir, id);
  assert.deepEqual(thread.comments.map((c) => c.body), ['first', 'second', 'third']);
  assert.equal(thread.archived, false);
  assert.equal(fs.readdirSync(path.join(dir, id)).length, 4);
});

test('archive and unarchive keep every comment, delete removes the thread', () => {
  // Catches: archive losing comments, or delete leaving a thread behind.
  const dir = tmp();
  const id = store.create(dir, anchor, comment('hi', '2026-01-01T10:00:00.000Z'));
  store.setArchived(dir, id, true);
  assert.equal(store.read(dir, id).archived, true);
  assert.equal(store.read(dir, id).comments.length, 1);
  store.setArchived(dir, id, false);
  assert.equal(store.read(dir, id).archived, false);
  store.remove(dir, id);
  assert.deepEqual(store.list(dir), []);
});

test('malformed thread files are rejected with the file and field named', () => {
  // Catches: hand-edited or agent-written files silently rendering wrong, or a path escaping the repo.
  const dir = tmp();
  const id = store.create(dir, anchor, comment('hi', '2026-01-01T10:00:00.000Z'));
  const file = path.join(dir, id, 'thread.json');
  fs.writeFileSync(file, JSON.stringify({ ...anchor, path: '../secrets', archived: false }));
  assert.throws(() => store.read(dir, id), /thread\.json: invalid or missing "path"/);
  fs.writeFileSync(file, JSON.stringify(anchor));
  assert.throws(() => store.read(dir, id), /invalid or missing "archived"/);
});
