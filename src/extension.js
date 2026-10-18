// @ts-check
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const blob = require('./blob');
const { S3Error } = require('./s3');
const store = require('./store');
const { git, locate } = require('./track');

/**
 * @typedef {ReturnType<typeof store.open>} Store
 * @typedef {{ root: string, store: Store, id: string }} Ref
 * @typedef {{ state: 'credentials' | 'offMain', message: string }} Problem
 * @typedef {{ uri: vscode.Uri, line: number, thread: store.Thread }} Listed
 */

const DEFAULT_LOCATION = '~/.line-comments';
// shortcut: S3 has no change notifications, so remote locations are polled; upgrade to SeaweedFS's
// filer subscription if 10 s feels slow.
const POLL_MS = 10_000;

/** @param {vscode.ExtensionContext} context */
function activate(context) {
  const controller = vscode.comments.createCommentController('line-comments', 'Line Comments');
  /** @type {Listed[]} threads in the side bar, also the ones on screen */
  let listed = [];
  /** @type {vscode.EventEmitter<void>} */
  const treeChanged = new vscode.EventEmitter();
  /** @type {vscode.TreeDataProvider<string | Listed>} files (by URI string), then their threads */
  const tree = {
    onDidChangeTreeData: treeChanged.event,
    getChildren: (el) => {
      if (el === undefined) return [...new Set(listed.map((l) => l.uri.toString()))].sort();
      if (typeof el === 'string') return listed.filter((l) => l.uri.toString() === el).sort((a, b) => a.line - b.line);
      return [];
    },
    getTreeItem: (el) => (typeof el === 'string' ? fileItem(el) : threadItem(el)),
  };
  const view = vscode.window.createTreeView('lineComments.threads', { treeDataProvider: tree });
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
   * @param {string} root @returns {Promise<{ store: Store, key: string, remote: boolean, anonymous: boolean }>}
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
      // No saved key means anonymous requests, for stores that allow them.
      const credentials = saved === undefined ? undefined : JSON.parse(saved);
      const cfg = { endpoint, region, bucket: url.hostname, credentials };
      const key = `${location}\0${endpoint}\0${repo}`;
      const store = cached(key, () => blob.bucket(cfg, prefix ? `${prefix}/` : ''), repo);
      return { store, key, remote: true, anonymous: credentials === undefined };
    }
    const dir = expand(root, location);
    if (location === DEFAULT_LOCATION) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`lineComments.location ${dir} is not a folder`);
    const key = `${dir}\0\0${repo}`;
    return { store: cached(key, () => blob.folder(dir), repo), key, remote: false, anonymous: false };
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
    /** @type {Map<string, { store: Store, key: string, loaded: store.Loaded[] | undefined }>} */
    const next = new Map();
    remote = false;
    for (const root of roots()) {
      try {
        const found = await storeFor(root);
        const { branch, main } = branches(root);
        if (branch !== main) {
          problem ??= {
            state: 'offMain',
            message: `${path.basename(root)} is on ${branch}. Comments show only on ${main}, because their lines refer to it.`,
          };
          continue;
        }
        let loaded;
        try {
          loaded = await found.store.readAll();
        } catch (e) {
          if (found.anonymous && e instanceof S3Error && e.status === 403) {
            problem ??= { state: 'credentials', message: 'This S3 location needs an access key.' };
            continue;
          }
          // An unreachable store keeps what is on screen rather than wiping it.
          failures.push(message(e));
        }
        next.set(root, { store: found.store, key: found.key, loaded });
        remote ||= found.remote;
      } catch (e) {
        failures.push(message(e));
      }
    }
    const changed = next.size !== active.size || [...next.keys()].some((r) => !active.has(r));
    active = new Map([...next].map(([root, n]) => [root, n.store]));
    // VS Code caches commenting ranges per editor; assigning the provider again makes it re-ask.
    if (changed) controller.commentingRangeProvider = ranges;

    const seen = new Set();
    /** @type {Listed[]} */
    const nextListed = [];
    let archived = 0;
    for (const [root, { store: s, key: storeKey, loaded }] of next) {
      if (loaded === undefined) {
        for (const [key] of shown) if (key.startsWith(`${storeKey}\0`)) seen.add(key);
        nextListed.push(...listed.filter((l) => rootOf(l.uri) === root));
        continue;
      }
      for (const item of loaded) {
        if ('error' in item) {
          failures.push(item.error);
          continue;
        }
        if (item.thread.archived) archived++;
        if (item.thread.archived && !showArchived) continue;
        const key = `${storeKey}\0${item.id}`;
        seen.add(key);
        nextListed.push(render(key, { root, store: s, id: item.id }, item.thread));
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

    listed = nextListed;
    treeChanged.fire();
    const open = listed.filter((l) => !l.thread.archived).length;
    view.badge = open > 0 ? { value: open, tooltip: `${open} open comment thread${open === 1 ? '' : 's'}` } : undefined;
    view.description = showArchived ? 'showing archived' : archived > 0 ? `${archived} archived` : undefined;
    // The credentials state uses the view's welcome content, which carries a button and hides under a message.
    view.message = problem?.state === 'credentials' ? undefined : problem?.message ?? failures[0];
    const state = problem?.state ?? (active.size > 0 ? 'ready' : 'none');
    await vscode.commands.executeCommand('setContext', 'lineComments.state', state);
  }

  /** @param {string} uri */
  function fileItem(uri) {
    const item = new vscode.TreeItem(vscode.Uri.parse(uri), vscode.TreeItemCollapsibleState.Expanded);
    item.description = true;
    return item;
  }

  /** @param {Listed} l */
  function threadItem(l) {
    const [first, ...replies] = l.thread.comments;
    const item = new vscode.TreeItem(first.body.split('\n')[0]);
    const more = replies.length === 0 ? '' : ` · ${replies.length} repl${replies.length === 1 ? 'y' : 'ies'}`;
    item.description = `${first.author} · Ln ${l.line + 1}${more}`;
    item.tooltip = new vscode.MarkdownString(l.thread.comments.map((c) => `**${c.author}:** ${c.body}`).join('\n\n'));
    item.iconPath = new vscode.ThemeIcon(l.thread.archived ? 'archive' : 'comment-discussion');
    const at = new vscode.Range(l.line, 0, l.line, 0);
    item.command = { title: 'Go to thread', command: 'vscode.open', arguments: [l.uri, { selection: at }] };
    return item;
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

  /** @param {string} key @param {Ref} ref @param {store.Thread} thread @returns {Listed} */
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
    return { uri, line: now.line, thread };
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
    view,
    treeChanged,
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
    vscode.commands.registerCommand('lineComments.refresh', guard(sync)),
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
