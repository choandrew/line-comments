// @ts-check
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const blob = require('./blob');
const store = require('./store');
const { git, locate } = require('./track');

/**
 * @typedef {ReturnType<typeof store.open>} Store
 * @typedef {{ root: string, store: Store, id: string }} Ref
 * @typedef {{ text: string, tooltip: string, command?: vscode.Command }} Problem
 */

const DEFAULT_LOCATION = '~/.line-comments';
// shortcut: S3 has no change notifications, so remote locations are polled; upgrade to SeaweedFS's
// filer subscription if 10 s feels slow.
const POLL_MS = 10_000;

/** @param {vscode.ExtensionContext} context */
function activate(context) {
  const controller = vscode.comments.createCommentController('line-comments', 'Line Comments');
  const archivedButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  archivedButton.command = 'lineComments.toggleArchived';
  const notice = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  /** @type {Map<string, Store>} workspace folder -> its store, when configured and on the default branch */
  let active = new Map();
  /** @type {Map<string, Store>} by location, endpoint and repo, so caches survive across syncs */
  const stores = new Map();
  /** @type {Map<string, vscode.CommentThread>} keyed by store key and thread id */
  const shown = new Map();
  /** @type {Map<vscode.CommentThread, Ref>} */
  const refs = new Map();
  /** @type {vscode.Disposable[]} */
  let watchers = [];
  /** @type {Set<string>} */
  let errors = new Set();
  let showArchived = false;
  let remote = false;

  /** @type {vscode.CommentingRangeProvider} */
  const ranges = {
    provideCommentingRanges: (doc) => {
      const root = rootOf(doc.uri);
      if (root === undefined || !active.has(root)) return [];
      return [new vscode.Range(0, 0, doc.lineCount - 1, 0)];
    },
  };
  controller.commentingRangeProvider = ranges;

  /**
   * The store for a workspace folder, or the problem stopping one.
   * @param {string} root @returns {Promise<{ store: Store, key: string, remote: boolean } | { problem: Problem }>}
   */
  async function storeFor(root) {
    const config = vscode.workspace.getConfiguration('lineComments', vscode.Uri.file(root));
    const location = setting(config, 'location');
    const repo = repoId(root);
    if (location.startsWith('s3://')) {
      const endpoint = setting(config, 's3.endpoint');
      const region = setting(config, 's3.region');
      const url = new URL(location);
      const prefix = url.pathname.replace(/^\/+|\/+$/g, '');
      const saved = await context.secrets.get(secretKey(endpoint));
      if (saved === undefined) {
        return {
          problem: {
            text: '$(key) Line Comments: set S3 credentials',
            tooltip: `Enter the access key for ${endpoint}`,
            command: { title: 'Set S3 credentials', command: 'lineComments.setS3Credentials' },
          },
        };
      }
      const { accessKeyId, secretAccessKey } = JSON.parse(saved);
      const cfg = { endpoint, region, bucket: url.hostname, accessKeyId, secretAccessKey };
      const key = `${location}\0${endpoint}\0${repo}`;
      return { store: cached(key, () => blob.bucket(cfg, prefix ? `${prefix}/` : ''), repo), key, remote: true };
    }
    const dir = expand(root, location);
    if (location === DEFAULT_LOCATION) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`lineComments.location ${dir} is not a folder`);
    const key = `${dir}\0\0${repo}`;
    return { store: cached(key, () => blob.folder(dir), repo), key, remote: false };
  }

  /** @param {string} key @param {() => blob.Blob} make @param {string} repo */
  function cached(key, make, repo) {
    let s = stores.get(key);
    if (!s) stores.set(key, (s = store.open(make(), `${repo}/`)));
    return s;
  }

  /** Re-reads config, branches and every thread, then updates what VS Code shows. */
  async function syncOnce() {
    /** @type {string[]} */
    const failures = [];
    /** @type {Problem | undefined} */
    let problem;
    /** @type {Map<string, Store>} */
    const next = new Map();
    /** @type {Map<string, string>} */
    const keys = new Map();
    remote = false;
    for (const root of roots()) {
      try {
        const { branch, main } = branches(root);
        if (branch !== main) {
          problem ??= {
            text: `$(git-branch) Line Comments: ${main} only`,
            tooltip: `Comments refer to ${main}'s lines, so they show only while ${path.basename(root)} is on ${main}`,
          };
          continue;
        }
        const found = await storeFor(root);
        if ('problem' in found) {
          problem ??= found.problem;
          continue;
        }
        next.set(root, found.store);
        keys.set(root, found.key);
        remote ||= found.remote;
      } catch (e) {
        failures.push(message(e));
      }
    }
    const changed = next.size !== active.size || [...next.keys()].some((r) => !active.has(r));
    active = next;
    // VS Code caches commenting ranges per editor; assigning the provider again makes it re-ask.
    if (changed) controller.commentingRangeProvider = ranges;

    const seen = new Set();
    let archived = 0;
    for (const [root, s] of active) {
      let loaded;
      try {
        loaded = await s.readAll();
      } catch (e) {
        failures.push(message(e));
        // An unreachable store keeps what is on screen rather than wiping it.
        for (const [key] of shown) if (key.startsWith(`${keys.get(root)}\0`)) seen.add(key);
        continue;
      }
      for (const item of loaded) {
        if ('error' in item) {
          failures.push(item.error);
          continue;
        }
        if (item.thread.archived) archived++;
        if (item.thread.archived && !showArchived) continue;
        const key = `${keys.get(root)}\0${item.id}`;
        seen.add(key);
        render(key, { root, store: s, id: item.id }, item.thread);
      }
    }
    for (const [key, thread] of shown) {
      if (seen.has(key)) continue;
      thread.dispose();
      shown.delete(key);
      refs.delete(thread);
    }

    // Each distinct problem notifies once, not on every sync while it persists.
    for (const f of failures) if (!errors.has(f)) showError(f);
    errors = new Set(failures);

    if (problem) Object.assign(notice, { command: undefined }, problem).show();
    else notice.hide();
    archivedButton.text = showArchived ? '$(eye-closed) Hide archived threads' : `$(archive) ${archived} archived`;
    archivedButton.tooltip = showArchived ? 'Hide archived comment threads' : 'Show archived comment threads';
    if (active.size > 0 && (archived > 0 || showArchived)) archivedButton.show();
    else archivedButton.hide();
  }

  // One sync at a time; requests that arrive during a sync collapse into one more run.
  let syncing = false;
  let again = false;
  async function sync() {
    if (syncing) {
      again = true;
      return;
    }
    syncing = true;
    try {
      do {
        again = false;
        await syncOnce();
      } while (again);
    } finally {
      syncing = false;
    }
  }

  /** @type {NodeJS.Timeout | undefined} */
  let pending;
  // A pull or checkout fires many file events at once; sync once they settle.
  const resync = () => {
    clearTimeout(pending);
    pending = setTimeout(guard(sync), 150);
  };

  /** Watches each repo's HEAD and reflog, and each comment folder on disk. */
  function rewatch() {
    for (const w of watchers) w.dispose();
    watchers = [];
    stores.clear();
    /** @param {string} base @param {string} glob */
    const watch = (base, glob) => {
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(base), glob));
      watchers.push(w, w.onDidCreate(resync), w.onDidChange(resync), w.onDidDelete(resync));
    };
    for (const root of roots()) {
      try {
        // logs/HEAD gains a line on every checkout, commit, pull or reset, so it catches main moving.
        watch(git(root, 'rev-parse', '--path-format=absolute', '--git-dir'), '{HEAD,logs/HEAD}');
        const location = setting(vscode.workspace.getConfiguration('lineComments', vscode.Uri.file(root)), 'location');
        if (!location.startsWith('s3://')) watch(path.join(expand(root, location), ...repoId(root).split('/')), '**/*.json');
      } catch {
        // syncOnce() reports the same failure.
      }
    }
    resync();
  }

  /** @param {string} key @param {Ref} ref @param {store.Thread} thread */
  function render(key, ref, thread) {
    const now = locate(ref.root, thread);
    const uri = vscode.Uri.file(path.join(ref.root, now.path));
    const range = new vscode.Range(now.line, 0, now.line, 0);
    let t = shown.get(key);
    if (t && t.uri.fsPath !== uri.fsPath) {
      // A thread's file is fixed at creation, so a renamed file needs a new thread.
      t.dispose();
      refs.delete(t);
      t = undefined;
    }
    if (!t) {
      t = controller.createCommentThread(uri, range, []);
      t.collapsibleState = thread.archived
        ? vscode.CommentThreadCollapsibleState.Collapsed
        : vscode.CommentThreadCollapsibleState.Expanded;
      shown.set(key, t);
    }
    refs.set(t, ref);
    t.range = range;
    t.comments = thread.comments.map((c) => ({
      body: new vscode.MarkdownString(c.body),
      mode: vscode.CommentMode.Preview,
      author: { name: c.author },
      timestamp: new Date(c.at),
    }));
    t.contextValue = thread.archived ? 'archived' : 'open';
    t.state = thread.archived ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;
    const count = `${thread.comments.length} comment${thread.comments.length === 1 ? '' : 's'}`;
    t.label = [thread.archived && 'Archived', count, now.stale && `line since changed from: ${thread.text.trim()}`]
      .filter(Boolean)
      .join(' · ');
  }

  /** @param {vscode.CommentReply} reply */
  async function comment({ thread, text }) {
    const root = rootOf(thread.uri);
    const s = root === undefined ? undefined : active.get(root);
    if (root === undefined || s === undefined) throw new Error('commenting is off here; see the status bar');
    let author;
    try {
      author = git(root, 'config', 'user.name');
    } catch {
      author = ''; // git exits 1 when the name is unset
    }
    if (author === '') throw new Error('set your name with: git config --global user.name "Your Name"');
    const entry = { author, body: text, at: new Date().toISOString() };
    const ref = refs.get(thread);
    if (ref) {
      await ref.store.reply(ref.id, entry);
    } else {
      const doc = await vscode.workspace.openTextDocument(thread.uri);
      const line = thread.range.start.line;
      const rel = path.relative(root, thread.uri.fsPath).split(path.sep).join('/');
      const commit = git(root, 'rev-parse', 'HEAD');
      await s.create({ path: rel, line: line + 1, text: doc.lineAt(line).text, commit }, entry);
      thread.dispose();
    }
    await sync();
  }

  /** @param {boolean} archived @returns {(thread: vscode.CommentThread) => Promise<void>} */
  const archive = (archived) => async (thread) => {
    const r = ref(thread);
    await r.store.setArchived(r.id, archived);
    await sync();
  };

  /** @param {vscode.CommentThread} thread */
  async function remove(thread) {
    const choice = await vscode.window.showWarningMessage(
      'Delete this thread and all its comments?',
      { modal: true, detail: 'Archive keeps the thread and only hides it.' },
      'Delete',
    );
    if (choice !== 'Delete') return;
    const r = ref(thread);
    await r.store.remove(r.id);
    await sync();
  }

  async function toggleArchived() {
    showArchived = !showArchived;
    await sync();
  }

  async function setS3Credentials() {
    const config = (/** @type {string} */ r) => vscode.workspace.getConfiguration('lineComments', vscode.Uri.file(r));
    const root = roots().find((r) => setting(config(r), 'location').startsWith('s3://'));
    if (root === undefined) throw new Error('set lineComments.location to an s3:// URL first');
    const endpoint = setting(config(root), 's3.endpoint');
    const accessKeyId = await vscode.window.showInputBox({ title: `S3 access key ID for ${endpoint}`, ignoreFocusOut: true });
    if (!accessKeyId) return;
    const secretAccessKey = await vscode.window.showInputBox({
      title: `S3 secret access key for ${endpoint}`,
      password: true,
      ignoreFocusOut: true,
    });
    if (!secretAccessKey) return;
    await context.secrets.store(secretKey(endpoint), JSON.stringify({ accessKeyId, secretAccessKey }));
  }

  /** @param {vscode.CommentThread} thread @returns {Ref} */
  function ref(thread) {
    const r = refs.get(thread);
    if (!r) throw new Error('this thread is not saved yet');
    return r;
  }

  const poll = setInterval(() => remote && resync(), POLL_MS);

  context.subscriptions.push(
    controller,
    archivedButton,
    notice,
    { dispose: () => watchers.forEach((w) => w.dispose()) },
    { dispose: () => clearTimeout(pending) },
    { dispose: () => clearInterval(poll) },
    vscode.workspace.onDidSaveTextDocument(resync),
    vscode.workspace.onDidChangeWorkspaceFolders(rewatch),
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('lineComments') && rewatch()),
    context.secrets.onDidChange(rewatch),
    vscode.commands.registerCommand('lineComments.comment', guard(comment)),
    vscode.commands.registerCommand('lineComments.archive', guard(archive(true))),
    vscode.commands.registerCommand('lineComments.unarchive', guard(archive(false))),
    vscode.commands.registerCommand('lineComments.delete', guard(remove)),
    vscode.commands.registerCommand('lineComments.toggleArchived', guard(toggleArchived)),
    vscode.commands.registerCommand('lineComments.setS3Credentials', guard(setS3Credentials)),
  );
  rewatch();
}

/** @returns {string[]} */
function roots() {
  return (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file').map((f) => f.uri.fsPath);
}

/** @param {vscode.Uri} uri @returns {string | undefined} */
function rootOf(uri) {
  const folder = uri.scheme === 'file' ? vscode.workspace.getWorkspaceFolder(uri) : undefined;
  return folder?.uri.scheme === 'file' ? folder.uri.fsPath : undefined;
}

/** A required string setting. @param {vscode.WorkspaceConfiguration} config @param {string} name */
function setting(config, name) {
  const value = config.get(name);
  if (typeof value !== 'string' || value === '') throw new Error(`set lineComments.${name}`);
  return value;
}

/** `~` and paths relative to the workspace folder. @param {string} root @param {string} location */
function expand(root, location) {
  return path.resolve(root, location.replace(/^~(?=$|[\\/])/, os.homedir()));
}

/** The repo's `owner/name` from its origin URL; it keys the repo's threads in a shared location. @param {string} root */
function repoId(root) {
  const url = git(root, 'remote', 'get-url', 'origin');
  // https://host/owner/repo, git@host:owner/repo, or a local path, which may hold `..`.
  const tail = url.replace(/^[\w+.-]+:\/\/[^/]*/, '').replace(/^[^/@]+@[^:]+:/, '').replace(/(\.git)?\/*$/, '');
  const parts = path.posix.normalize(`/${tail}`).split('/').filter(Boolean).slice(-2);
  if (parts.length !== 2 || !parts.every((p) => /^[\w.-]+$/.test(p) && p !== '.' && p !== '..')) {
    throw new Error(`cannot tell owner/repo from origin ${url}`);
  }
  return parts.join('/');
}

/** @param {string} endpoint */
const secretKey = (endpoint) => `s3:${endpoint}`;

/** The checked-out branch and the default branch that origin/HEAD names. @param {string} root */
function branches(root) {
  const branch = git(root, 'rev-parse', '--abbrev-ref', 'HEAD');
  let main;
  try {
    main = git(root, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD').replace(/^origin\//, '');
  } catch {
    throw new Error(`${path.basename(root)} has no origin/HEAD; run: git remote set-head origin --auto`);
  }
  return { branch, main };
}

/**
 * @template {unknown[]} A
 * @param {(...args: A) => unknown} fn
 * @returns {(...args: A) => Promise<void>}
 */
function guard(fn) {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (e) {
      showError(message(e));
    }
  };
}

/** @param {unknown} e */
const message = (e) => (e instanceof Error ? e.message : String(e));

/** @param {string} text */
function showError(text) {
  vscode.window.showErrorMessage(`Line Comments: ${text}`);
}

module.exports = { activate };
