// @ts-check
// Runs against a folder always, and against S3 when these name buckets (the ci workflow starts both):
// LINE_COMMENTS_TEST_S3       a store that needs a key, e.g. http://test-key:test-secret@localhost:18333/test
// LINE_COMMENTS_TEST_S3_OPEN  a store that allows anonymous access, e.g. http://localhost:18334/test
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const blob = require('../src/blob');
const s3 = require('../src/s3');
const store = require('../src/store');

const anchor = { path: 'src/app.py', line: 3, text: '    total = a + b', commit: 'a'.repeat(40) };
/** @param {string} body @param {string} at */
const comment = (body, at) => ({ author: 'Ada', body, at });

/** @type {Record<string, () => blob.Blob>} each call gets a fresh, empty place */
const backends = { folder: () => blob.folder(fs.mkdtempSync(path.join(os.tmpdir(), 'line-comments-'))) };
const s3url = process.env.LINE_COMMENTS_TEST_S3;
const openUrl = process.env.LINE_COMMENTS_TEST_S3_OPEN;
if (s3url) backends.s3 = () => blob.bucket(s3config(s3url), `run-${crypto.randomUUID()}/`);
if (openUrl) backends['s3 anonymous'] = () => blob.bucket(s3config(openUrl), `run-${crypto.randomUUID()}/`);

/** Credentials come from the URL's user and password, if any. @param {string} url @param {string} [secret] */
function s3config(url, secret) {
  const u = new URL(url);
  const credentials = u.username
    ? { accessKeyId: decodeURIComponent(u.username), secretAccessKey: secret ?? decodeURIComponent(u.password) }
    : undefined;
  return { endpoint: u.origin, region: 'us-east-1', bucket: u.pathname.slice(1), credentials };
}

for (const [backend, fresh] of Object.entries(backends)) {
  test(`${backend}: replies from several people read back as one thread in time order`, async () => {
    // Catches: replies stored in one shared file (sync conflicts) or returned out of order.
    const s = store.open(fresh(), 'owner/repo/');
    const id = await s.create(anchor, comment('first', '2026-01-01T10:00:00.000Z'));
    await s.reply(id, comment('third', '2026-01-01T12:00:00.000Z'));
    await s.reply(id, { author: 'Grace', body: 'second', at: '2026-01-01T06:00:00-05:00' });
    const [loaded, ...rest] = await s.readAll();
    assert.equal(rest.length, 0);
    assert.ok('thread' in loaded, JSON.stringify(loaded));
    assert.deepEqual(loaded.thread.comments.map((c) => c.body), ['first', 'second', 'third']);
    assert.equal(loaded.thread.archived, false);
  });

  test(`${backend}: archive and unarchive keep every comment, delete removes the thread`, async () => {
    // Catches: archive losing comments, or delete leaving a thread behind.
    const b = fresh();
    const s = store.open(b, 'owner/repo/');
    const id = await s.create(anchor, comment('hi', '2026-01-01T10:00:00.000Z'));
    await s.setArchived(id, true);
    const [archived] = await s.readAll();
    assert.ok('thread' in archived && archived.thread.archived && archived.thread.comments.length === 1);
    await s.setArchived(id, false);
    const [open] = await s.readAll();
    assert.ok('thread' in open && !open.thread.archived);
    await s.remove(id);
    assert.deepEqual(await s.readAll(), []);
    assert.equal((await b.list('owner/repo/')).size, 0);
  });

  test(`${backend}: repos sharing a location see only their own threads`, async () => {
    // Catches: one user-level location mixing threads from different repos.
    const b = fresh();
    await store.open(b, 'owner/one/').create(anchor, comment('one', '2026-01-01T10:00:00.000Z'));
    await store.open(b, 'owner/one-two/').create(anchor, comment('two', '2026-01-01T10:00:00.000Z'));
    const loaded = await store.open(b, 'owner/one/').readAll();
    assert.deepEqual(loaded.map((l) => 'thread' in l && l.thread.comments[0].body), ['one']);
  });

  test(`${backend}: a malformed thread file is reported by name without hiding the others`, async () => {
    // Catches: one hand-edited or agent-written file blanking every thread, or a path escaping the repo.
    const b = fresh();
    const s = store.open(b, 'owner/repo/');
    const good = await s.create(anchor, comment('ok', '2026-01-01T10:00:00.000Z'));
    const bad = await s.create(anchor, comment('bad', '2026-01-01T10:00:00.000Z'));
    await b.put(`owner/repo/${bad}/thread.json`, JSON.stringify({ ...anchor, path: '../secrets', archived: false }));
    const loaded = await s.readAll();
    assert.deepEqual(
      loaded.map((l) => ('error' in l ? l.error : l.id)).sort(),
      [good, `owner/repo/${bad}/thread.json: invalid or missing "path"`].sort(),
    );
  });
}

if (s3url) {
  test('s3: listing follows continuation tokens past one page', async () => {
    // Catches: threads past the first 1,000 objects silently missing.
    const b = backends.s3();
    const keys = Array.from({ length: 1005 }, (_, i) => `owner/repo/t/${String(i).padStart(4, '0')}.json`);
    for (let i = 0; i < keys.length; i += 50) await Promise.all(keys.slice(i, i + 50).map((k) => b.put(k, '{}')));
    assert.equal((await b.list('owner/repo/')).size, keys.length);
  });

  test('s3: a wrong secret fails loudly', async () => {
    // Catches: bad credentials looking like an empty, comment-free repo.
    const b = blob.bucket(s3config(s3url, 'wrong'), 'x/');
    await assert.rejects(b.list(''), /HTTP 403/);
  });

  test('s3: a store that needs a key refuses anonymous requests with status 403', async () => {
    // Catches: the side bar never offering Set S3 Credentials because the refusal is not recognizable.
    const u = new URL(s3url);
    u.username = '';
    u.password = '';
    const b = blob.bucket(s3config(u.toString()), 'x/');
    await assert.rejects(b.list(''), (e) => e instanceof s3.S3Error && e.status === 403);
  });
}
