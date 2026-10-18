// @ts-check
// Where thread files live: a local or synced folder, or a prefix in an S3 bucket. Keys are '/'-separated.
const fs = require('fs');
const path = require('path');
const s3 = require('./s3');

/** @typedef {import('./s3').S3Config} S3Config */

/**
 * @typedef {object} Blob
 * @property {(prefix: string) => Promise<Map<string, string>>} list key -> version, which changes whenever the content does
 * @property {(key: string) => Promise<string>} get
 * @property {(key: string, text: string) => Promise<void>} put
 * @property {(key: string) => Promise<void>} del
 */

/** Rejects `.` and `..` segments, which would escape the folder or be rewritten in an S3 URL. @param {string} key */
function checked(key) {
  if (key.split('/').some((p) => p === '.' || p === '..')) throw new Error(`invalid key ${key}`);
  return key;
}

/** @param {string} dir @returns {Blob} */
function folder(dir) {
  const file = (/** @type {string} */ key) => path.join(dir, ...checked(key).split('/'));
  return {
    async list(prefix) {
      /** @type {Map<string, string>} */
      const out = new Map();
      const start = file(prefix);
      if (!fs.existsSync(start)) return out;
      for (const rel of fs.readdirSync(start, { recursive: true, encoding: 'utf8' })) {
        const stat = fs.statSync(path.join(start, rel));
        if (stat.isFile()) out.set(prefix + rel.split(path.sep).join('/'), `${stat.mtimeMs}:${stat.size}`);
      }
      return out;
    },
    get: (key) => fs.promises.readFile(file(key), 'utf8'),
    async put(key, text) {
      await fs.promises.mkdir(path.dirname(file(key)), { recursive: true });
      await fs.promises.writeFile(file(key), text);
    },
    async del(key) {
      await fs.promises.rm(file(key));
      const parent = path.dirname(file(key));
      if ((await fs.promises.readdir(parent)).length === 0) await fs.promises.rmdir(parent);
    },
  };
}

/** @param {S3Config} cfg @param {string} root key prefix inside the bucket, '' or ending in '/' @returns {Blob} */
function bucket(cfg, root) {
  return {
    async list(prefix) {
      const out = new Map();
      for (const [key, etag] of await s3.list(cfg, checked(root + prefix))) out.set(key.slice(root.length), etag);
      return out;
    },
    get: (key) => s3.get(cfg, checked(root + key)),
    put: (key, text) => s3.put(cfg, checked(root + key), text),
    del: (key) => s3.del(cfg, checked(root + key)),
  };
}

module.exports = { folder, bucket };
