// @ts-check
const path = require('path');
const { git } = require('./track');

/** The repo's `owner/name` from its origin URL; it keys the repo's threads in a shared location. @param {string} root */
async function repoId(root) {
  const url = await git(root, 'remote', 'get-url', 'origin');
  // https://host/owner/repo, git@host:owner/repo, or a local path, which may hold `..`.
  const tail = url.replace(/^[\w+.-]+:\/\/[^/]*/, '').replace(/^[^/@]+@[^:]+:/, '').replace(/(\.git)?\/*$/, '');
  const parts = path.posix.normalize(`/${tail}`).split('/').filter(Boolean).slice(-2);
  if (parts.length !== 2 || !parts.every((p) => /^[\w.-]+$/.test(p) && p !== '.' && p !== '..')) {
    throw new Error(`cannot tell owner/repo from origin ${url}`);
  }
  return parts.join('/');
}

module.exports = { repoId };
