#!/usr/bin/env node
// @ts-check
// Prints a repo's open line comment threads, placed in the working tree the way the extension places them.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseArgs } = require('util');
const blob = require('../src/blob');
const store = require('../src/store');
const { git, tracker } = require('../src/track');
const { repoId } = require('../src/repo');

const USAGE = 'usage: line-comments open [--location <folder or s3://bucket/prefix>] [--endpoint <s3 url>]';
const DEFAULT_LOCATION = '~/.line-comments';
const EDITORS = ['Code', 'Cursor'];

/** @param {string[]} argv @returns {Promise<number>} exit code */
async function main(argv) {
  if (argv[0] !== 'open') {
    console.error(USAGE);
    return 2;
  }
  const { values: flags } = parseArgs({ args: argv.slice(1), options: { location: { type: 'string' }, endpoint: { type: 'string' } } });
  const root = await git(process.cwd(), 'rev-parse', '--show-toplevel');
  const repoSettings = path.join(root, '.vscode', 'settings.json');
  /**
   * The given value, else the repo's settings, else the user settings of VS Code and Cursor, which must agree.
   * @param {string} key @param {string | undefined} given
   */
  const setting = (key, given) => {
    if (given !== undefined) return given;
    const read = (/** @type {string} */ file) => {
      const value = fs.existsSync(file) ? jsonc(file)[`lineComments.${key}`] : undefined;
      if (value !== undefined && (typeof value !== 'string' || value === '')) throw new Error(`${file}: lineComments.${key} must be a non-empty string`);
      return value === undefined ? [] : [{ file, value }];
    };
    const [repo] = read(repoSettings);
    if (repo) return repo.value;
    const user = EDITORS.flatMap((editor) => read(userSettings(editor)));
    if (new Set(user.map((u) => u.value)).size > 1) {
      throw new Error(`lineComments.${key} differs between ${user.map((u) => u.file).join(' and ')}; pass it as a flag`);
    }
    return user[0]?.value;
  };

  let out;
  try {
    out = await git(root, 'rev-parse', 'HEAD', '--abbrev-ref', 'HEAD', 'origin/HEAD');
  } catch (e) {
    if (/origin\/HEAD/.test(String(e))) throw new Error('no origin/HEAD; run: git remote set-head origin --auto');
    throw e;
  }
  const [sha, branch, origin] = out.split('\n');
  const main = origin.replace(/^origin\//, '');
  if (branch !== main) console.error(`line-comments: on ${branch}, not ${main}; lines are placed against your working tree`);

  const location = setting('location', flags.location ?? process.env.LINE_COMMENTS_LOCATION) ?? DEFAULT_LOCATION;
  const repo = await repoId(root);
  const where = location.startsWith('s3://')
    ? bucket(location, setting('s3.endpoint', flags.endpoint ?? process.env.LINE_COMMENTS_S3_ENDPOINT), setting('s3.region', undefined))
    : folder(root, location);
  const loaded = await store.open(where, `${repo}/`).readAll();
  const open = loaded.flatMap((l) => ('thread' in l && !l.thread.archived ? [l.thread] : []));
  const placed = await tracker().locateAll(root, sha, open);
  const order = open.map((t, i) => ({ t, at: placed[i] }));
  order.sort((a, b) => (a.at.path < b.at.path ? -1 : a.at.path > b.at.path ? 1 : a.at.line - b.at.line));
  for (const { t, at } of order) {
    const [first, ...replies] = t.comments;
    const mark = at.stale ? ` (line changed since: ${t.text.trim()})` : '';
    console.log(`${at.path}:${at.line + 1}: ${show(first, '  ', mark)}`);
    for (const r of replies) console.log(`  ${show(r, '    ', '')}`);
  }
  const errors = loaded.flatMap((l) => ('error' in l ? [l.error] : []));
  for (const e of errors) console.error(`line-comments: ${e}`);
  return errors.length > 0 ? 1 : 0;
}

/** @param {string} location @param {string | undefined} endpoint @param {string | undefined} region */
function bucket(location, endpoint, region = 'us-east-1') {
  if (endpoint === undefined) throw new Error(`${location} needs --endpoint, LINE_COMMENTS_S3_ENDPOINT or lineComments.s3.endpoint`);
  const { AWS_ACCESS_KEY_ID: accessKeyId, AWS_SECRET_ACCESS_KEY: secretAccessKey } = process.env;
  const credentials = accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined;
  const url = new URL(location);
  const prefix = url.pathname.replace(/^\/+|\/+$/g, '');
  return blob.bucket({ endpoint, region, bucket: url.hostname, credentials }, prefix ? `${prefix}/` : '');
}

/** `~` and paths relative to the repo root work, as in the extension. @param {string} root @param {string} location */
function folder(root, location) {
  const dir = path.resolve(root, location.replace(/^~(?=$|[\\/])/, os.homedir()));
  // The extension creates the default folder on first use; before that it simply holds no threads.
  if (location !== DEFAULT_LOCATION && !fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`location ${dir} is not a folder`);
  }
  return blob.folder(dir);
}

/** @param {store.Comment} c @param {string} pad for the body's later lines @param {string} mark after its first line */
function show(c, pad, mark) {
  const [head, ...more] = c.body.split('\n');
  return [`[${c.author}] ${head}${mark}`, ...more.map((l) => pad + l)].join('\n');
}

/** @param {string} editor its folder under the OS's app-data folder */
function userSettings(editor) {
  const rel = [editor, 'User', 'settings.json'];
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', ...rel);
  if (process.platform === 'win32') return path.join(/** @type {string} */ (process.env.APPDATA), ...rel);
  return path.join(os.homedir(), '.config', ...rel);
}

/** VS Code's settings format: JSON plus comments and trailing commas. Strings match first so their contents stay. @param {string} file */
function jsonc(file) {
  const text = fs
    .readFileSync(file, 'utf8')
    .replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_, s) => s ?? ' ')
    .replace(/("(?:[^"\\]|\\.)*")|,(?=\s*[}\]])/g, (_, s) => s ?? '');
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${file}: ${e instanceof Error ? e.message : e}`);
  }
}

main(process.argv.slice(2)).then(
  (code) => (process.exitCode = code),
  (e) => {
    console.error(`line-comments: ${e instanceof Error ? e.message : e}`);
    process.exitCode = 1;
  },
);
