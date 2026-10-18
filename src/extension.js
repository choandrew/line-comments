// @ts-check
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const blob = require('./blob');
const { S3Error } = require('./s3');
const store = require('./store');
const { git, tracker } = require('./track');
const { repoId } = require('./repo');

/**
 * @typedef {ReturnType<typeof store.open>} Store
 * @typedef {{ root: string, store: Store, id: string }} Ref
 * @typedef {{ state: 'credentials' | 'offMain', detail: string }} Problem
 * @typedef {{ key: string, uri: vscode.Uri, line: number, thread: store.Thread, unread: number }} Listed
 * @typedef {{ key: string, ref: Ref, commentId: string, body: string }} CommentRef
 * @typedef {{ sha: string, branch: string, main: string }} Head
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
  const track = tracker();
  /** @type {Map<string, Promise<Head>>} per workspace folder, dropped when its HEAD or reflog changes */
  const heads = new Map();
  /** @type {Map<string, Promise<string>>} each workspace folder's owner/repo, dropped on rewatch */
  const repos = new Map();
  /** @type {Map<string, string>} what each shown thread last drew, so an unchanged one is left alone */
  const drawn = new Map();
  let drawnTree = '';
  const headOf = (/** @type {string} */ root) => memo(heads, root, () => readHead(root));
  /** @type {Map<string, Promise<string>>} each workspace folder's git user.name, '' when unset */
  const names = new Map();
  const nameOf = (/** @type {string} */ root) => memo(names, root, () => git(root, 'config', 'user.name').catch(() => ''));
  /** @type {Set<string>} threads with a comment being edited, which syncs leave alone */
  const editing = new Set();
  /** @type {WeakMap<vscode.Comment, CommentRef>} */
  const commentRefs = new WeakMap();
  // Comment ids this person has seen, per thread, kept per machine. A store seen for the first time
  // counts as read, so installing the extension doesn't flag every old comment as new.
  /** @type {Record<string, string[]>} */
  const readIds = context.globalState.get('lineComments.read') ?? {};
  const knownStores = new Set(/** @type {string[]} */ (context.globalState.get('lineComments.knownStores') ?? []));
  /** @type {Set<string>} comments already announced this session */
  const announced = new Set();

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
    const repo = await memo(repos, root, () => repoId(root));
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
    /** @type {Map<string, { store: Store, key: string, sha: string, loaded: store.Loaded[] | undefined }>} */
    const next = new Map();
    remote = false;
    for (const root of roots()) {
      try {
        const found = await storeFor(root);
        const { sha, branch, main } = await headOf(root);
        if (branch !== main) {
          problem ??= { state: 'offMain', detail: `${path.basename(root)} is on ${branch}, not ${main}` };
          continue;
        }
        let loaded;
        try {
          loaded = await found.store.readAll();
        } catch (e) {
          if (found.anonymous && e instanceof S3Error && e.status === 403) {
            problem ??= { state: 'credentials', detail: 'needs an S3 access key' };
            continue;
          }
          // An unreachable store keeps what is on screen rather than wiping it.
          failures.push(message(e));
        }
        next.set(root, { store: found.store, key: found.key, sha, loaded });
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
    /** @type {{ comment: store.Comment, listed: Listed }[]} */
    const replies = [];
    let archived = 0;
    for (const [root, { store: s, key: storeKey, sha, loaded }] of next) {
      if (loaded === undefined) {
        for (const [key] of shown) if (key.startsWith(`${storeKey}\0`)) seen.add(key);
        nextListed.push(...listed.filter((l) => rootOf(l.uri) === root));
        continue;
      }
      const me = await nameOf(root);
      if (!knownStores.has(storeKey)) {
        for (const item of loaded) if ('thread' in item) readIds[`${storeKey}\0${item.id}`] = item.thread.comments.map((c) => c.id);
        knownStores.add(storeKey);
        await context.globalState.update('lineComments.knownStores', [...knownStores]);
      }
      const present = new Set(loaded.map((item) => `${storeKey}\0${item.id}`));
      for (const key of Object.keys(readIds)) if (key.startsWith(`${storeKey}\0`) && !present.has(key)) delete readIds[key];
      /** @type {{ id: string, thread: store.Thread }[]} */
      const visible = [];
      for (const item of loaded) {
        if ('error' in item) {
          failures.push(item.error);
          continue;
        }
        if (item.thread.archived) archived++;
        if (!item.thread.archived || showArchived) visible.push(item);
      }
      const placed = await track.locateAll(root, sha, visible.map((v) => v.thread));
      visible.forEach(({ id, thread }, i) => {
        const key = `${storeKey}\0${id}`;
        seen.add(key);
        const read = new Set(readIds[key] ?? []);
        const fresh = thread.comments.filter((c) => c.author !== me && !read.has(c.id));
        const l = render(key, { root, store: s, id }, thread, placed[i], fresh.length, me);
        nextListed.push(l);
        // Replies are announced only in threads this person has written in.
        if (thread.comments.some((c) => c.author === me)) for (const c of fresh) replies.push({ comment: c, listed: l });
      });
    }
    for (const [key, thread] of shown) {
      if (seen.has(key)) continue;
      thread.dispose();
      shown.delete(key);
      drawn.delete(key);
      editing.delete(key);
      refs.delete(thread);
    }
    await context.globalState.update('lineComments.read', readIds);

    // Each distinct problem notifies once, not on every sync while it persists.
    for (const f of failures) if (!errors.has(f)) showError(f);
    errors = new Set(failures);

    listed = nextListed;
    const tree = JSON.stringify(listed.map((l) => [l.uri.toString(), l.line, l.thread, l.unread]));
    if (tree !== drawnTree) treeChanged.fire();
    drawnTree = tree;
    const unread = listed.filter((l) => l.unread > 0).length;
    view.badge = unread > 0 ? { value: unread, tooltip: `${unread} thread${unread === 1 ? '' : 's'} with new comments` } : undefined;
    announce(replies.filter(({ comment, listed: l }) => !announced.has(`${l.key}\0${comment.id}`) && !onScreen(l)));
    markVisibleRead();
    view.description = problem?.detail ?? (showArchived ? 'showing archived' : archived > 0 ? `${archived} archived` : undefined);
    // Problems explain themselves in the view's welcome content, which has buttons and hides under a message.
    view.message = problem ? undefined : failures[0];
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
    item.description = `${l.unread > 0 ? `${l.unread} new · ` : ''}${first.author} · Ln ${l.line + 1}${more}`;
    item.tooltip = new vscode.MarkdownString(l.thread.comments.map((c) => `**${c.author}:** ${c.body}`).join('\n\n'));
    item.iconPath = l.thread.archived
      ? new vscode.ThemeIcon('archive')
      : l.unread > 0
        ? new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('notificationsInfoIcon.foreground'))
        : new vscode.ThemeIcon('comment-discussion');
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

  /** Forgets cached git state, then watches each repo's HEAD and reflog and each comment folder on disk. */
  async function rewatch() {
    for (const w of watchers) w.dispose();
    watchers = [];
    stores.clear();
    heads.clear();
    repos.clear();
    track.clear();
    /** @param {string} base @param {string} glob @param {() => void} changed */
    const watch = (base, glob, changed) => {
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(base), glob));
      watchers.push(w, w.onDidCreate(changed), w.onDidChange(changed), w.onDidDelete(changed));
    };
    for (const root of roots()) {
      try {
        // logs/HEAD gains a line on every checkout, commit, pull or reset, so it catches main moving.
        const gitDir = await git(root, 'rev-parse', '--path-format=absolute', '--git-dir');
        watch(gitDir, '{HEAD,logs/HEAD}', () => {
          heads.delete(root);
          resync();
        });
        const location = setting(vscode.workspace.getConfiguration('lineComments', vscode.Uri.file(root)), 'location');
        if (!location.startsWith('s3://')) {
          const repo = await memo(repos, root, () => repoId(root));
          watch(path.join(expand(root, location), ...repo.split('/')), '**/*.json', resync);
        }
      } catch {
        // syncOnce() reports the same failure.
      }
    }
    resync();
  }

  /**
   * @param {string} key @param {Ref} ref @param {store.Thread} thread @param {import('./track').Located} now
   * @param {number} unread comments from others not yet seen @param {string} me git user.name @returns {Listed}
   */
  function render(key, ref, thread, now, unread, me) {
    const uri = vscode.Uri.file(path.join(ref.root, now.path));
    const listedAs = { key, uri, line: now.line, thread, unread };
    let t = shown.get(key);
    if (t && editing.has(key)) return listedAs;
    if (t && t.uri.fsPath !== uri.fsPath) {
      // A thread's file is fixed at creation, so a renamed file needs a new thread.
      t.dispose();
      refs.delete(t);
      t = undefined;
    }
    const sig = JSON.stringify([now, thread, unread, me]);
    if (!t) {
      t = controller.createCommentThread(uri, new vscode.Range(now.line, 0, now.line, 0), []);
      t.collapsibleState = thread.archived
        ? vscode.CommentThreadCollapsibleState.Collapsed
        : vscode.CommentThreadCollapsibleState.Expanded;
      shown.set(key, t);
    } else if (drawn.get(key) === sig && t.range.start.line === now.line) {
      // Reassigning an unchanged thread's fields would still make VS Code redraw its widget. The range is
      // checked too: VS Code shifts a thread itself when it reloads a file changed on disk.
      refs.set(t, ref);
      return listedAs;
    }
    drawn.set(key, sig);
    refs.set(t, ref);
    t.range = new vscode.Range(now.line, 0, now.line, 0);
    t.comments = thread.comments.map((c) => {
      /** @type {vscode.Comment} */
      const shownComment = {
        body: new vscode.MarkdownString(c.body),
        mode: vscode.CommentMode.Preview,
        author: { name: c.author },
        timestamp: new Date(c.at),
        label: c.edited ? 'edited' : undefined,
        contextValue: c.author === me ? 'mine' : undefined,
      };
      commentRefs.set(shownComment, { key, ref, commentId: c.id, body: c.body });
      return shownComment;
    });
    t.contextValue = thread.archived ? 'archived' : 'open';
    t.state = thread.archived ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;
    const count = `${thread.comments.length} comment${thread.comments.length === 1 ? '' : 's'}`;
    const fresh = unread > 0 && `${unread} new`;
    t.label = [thread.archived && 'Archived', fresh, count, now.stale && `line since changed from: ${thread.text.trim()}`]
      .filter(Boolean)
      .join(' · ');
    return listedAs;
  }

  /** Whether a thread's line is on screen in a focused window, which counts as reading it. @param {Listed} l */
  function onScreen(l) {
    if (!vscode.window.state.focused) return false;
    return vscode.window.visibleTextEditors.some(
      (e) => e.document.uri.fsPath === l.uri.fsPath && e.visibleRanges.some((r) => r.start.line <= l.line && l.line <= r.end.line),
    );
  }

  /** @param {Listed[]} threads */
  async function markRead(threads) {
    if (threads.length === 0) return;
    for (const l of threads) readIds[l.key] = l.thread.comments.map((c) => c.id);
    await context.globalState.update('lineComments.read', readIds);
    resync();
  }

  const markVisibleRead = () => guard(markRead)(listed.filter((l) => l.unread > 0 && onScreen(l)));

  /** One notification per sync: the reply itself, or a count when several arrived. @param {{ comment: store.Comment, listed: Listed }[]} news */
  function announce(news) {
    if (news.length === 0) return;
    for (const { comment, listed: l } of news) announced.add(`${l.key}\0${comment.id}`);
    const show = 'Show';
    if (news.length === 1) {
      const [{ comment, listed: l }] = news;
      const where = `${vscode.workspace.asRelativePath(l.uri)}:${l.line + 1}`;
      vscode.window.showInformationMessage(`${comment.author} replied on ${where}: ${comment.body.split('\n')[0]}`, show).then((pick) => {
        if (pick === show) vscode.commands.executeCommand('vscode.open', l.uri, { selection: new vscode.Range(l.line, 0, l.line, 0) });
      });
    } else {
      vscode.window.showInformationMessage(`${news.length} new replies in threads you're in`, show).then((pick) => {
        if (pick === show) vscode.commands.executeCommand('lineComments.threads.focus');
      });
    }
  }

  /** @param {vscode.Comment} c @returns {CommentRef} */
  function commentRef(c) {
    const r = commentRefs.get(c);
    if (!r) throw new Error('this comment is not saved yet');
    return r;
  }

  /** Redraws a thread's comments in place, after switching one into or out of edit mode. @param {string} key */
  function redraw(key) {
    const t = shown.get(key);
    if (t) t.comments = [...t.comments];
  }

  /** @param {vscode.Comment} c */
  function editComment(c) {
    const { key } = commentRef(c);
    editing.add(key);
    c.mode = vscode.CommentMode.Editing;
    redraw(key);
  }

  /** @param {vscode.Comment} c */
  async function saveComment(c) {
    const { key, ref, commentId } = commentRef(c);
    const body = typeof c.body === 'string' ? c.body : c.body.value;
    await ref.store.editComment(ref.id, commentId, body, new Date().toISOString());
    editing.delete(key);
    drawn.delete(key);
    await sync();
  }

  /** @param {vscode.Comment} c */
  function cancelEdit(c) {
    const { key, body } = commentRef(c);
    c.body = new vscode.MarkdownString(body);
    c.mode = vscode.CommentMode.Preview;
    editing.delete(key);
    redraw(key);
  }

  /** @param {vscode.Comment} c */
  async function deleteComment(c) {
    const { key, ref, commentId } = commentRef(c);
    const last = (shown.get(key)?.comments.length ?? 0) <= 1;
    const choice = await vscode.window.showWarningMessage(
      'Delete this comment?',
      { modal: true, detail: last ? 'It is the only comment, so the thread goes too.' : undefined },
      'Delete',
    );
    if (choice !== 'Delete') return;
    if (last) await ref.store.remove(ref.id);
    else await ref.store.removeComment(ref.id, commentId);
    drawn.delete(key);
    await sync();
  }

  async function markAllRead() {
    await markRead(listed.filter((l) => l.unread > 0));
  }

  /** @param {vscode.CommentReply} reply */
  async function comment({ thread, text }) {
    const root = rootOf(thread.uri);
    const s = root === undefined ? undefined : active.get(root);
    if (root === undefined || s === undefined) throw new Error('commenting is off here; see the status bar');
    let author;
    try {
      author = await git(root, 'config', 'user.name');
    } catch {
      author = ''; // git exits 1 when the name is unset
    }
    if (author === '') throw new Error('set your name with: git config --global user.name "Your Name"');
    const entry = { author, body: text, at: new Date().toISOString() };
    const ref = refs.get(thread);
    if (ref) {
      await ref.store.reply(ref.id, entry);
      const l = listed.find((x) => shown.get(x.key) === thread);
      if (l) await markRead([l]);
    } else {
      const doc = await vscode.workspace.openTextDocument(thread.uri);
      const line = thread.range.start.line;
      const rel = path.relative(root, thread.uri.fsPath).split(path.sep).join('/');
      const commit = await git(root, 'rev-parse', 'HEAD');
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

  async function switchToDefault() {
    for (const root of roots()) {
      const { branch, main } = await headOf(root);
      if (branch === main) continue;
      heads.delete(root);
      await git(root, 'switch', main);
    }
    await sync();
  }

  async function refresh() {
    heads.clear();
    track.clear();
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
    // A change that leaves the document clean is a reload from disk (a pull, a checkout), not typing.
    vscode.workspace.onDidChangeTextDocument((e) => !e.document.isDirty && e.contentChanges.length > 0 && resync()),
    vscode.workspace.onDidChangeWorkspaceFolders(guard(rewatch)),
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('lineComments') && guard(rewatch)()),
    context.secrets.onDidChange(guard(rewatch)),
    vscode.commands.registerCommand('lineComments.comment', guard(comment)),
    vscode.commands.registerCommand('lineComments.archive', guard(archive(true))),
    vscode.commands.registerCommand('lineComments.unarchive', guard(archive(false))),
    vscode.commands.registerCommand('lineComments.delete', guard(remove)),
    vscode.commands.registerCommand('lineComments.toggleArchived', guard(toggleArchived)),
    vscode.commands.registerCommand('lineComments.setS3Credentials', guard(setS3Credentials)),
    vscode.commands.registerCommand('lineComments.refresh', guard(refresh)),
    vscode.commands.registerCommand('lineComments.switchToDefault', guard(switchToDefault)),
    vscode.commands.registerCommand('lineComments.editComment', guard(editComment)),
    vscode.commands.registerCommand('lineComments.saveComment', guard(saveComment)),
    vscode.commands.registerCommand('lineComments.cancelEdit', guard(cancelEdit)),
    vscode.commands.registerCommand('lineComments.deleteComment', guard(deleteComment)),
    vscode.commands.registerCommand('lineComments.markAllRead', guard(markAllRead)),
    // A thread scrolled into view in a focused window counts as read.
    vscode.window.onDidChangeTextEditorVisibleRanges(debounce(markVisibleRead, 500)),
    vscode.window.onDidChangeVisibleTextEditors(debounce(markVisibleRead, 500)),
    vscode.window.onDidChangeWindowState(debounce(markVisibleRead, 500)),
  );
  guard(rewatch)();
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

/** @param {string} endpoint */
const secretKey = (endpoint) => `s3:${endpoint}`;

/** HEAD's sha and branch, and the default branch that origin/HEAD names, in one git call. @param {string} root */
async function readHead(root) {
  let out;
  try {
    out = await git(root, 'rev-parse', 'HEAD', '--abbrev-ref', 'HEAD', 'origin/HEAD');
  } catch (e) {
    if (/origin\/HEAD/.test(message(e))) throw new Error(`${path.basename(root)} has no origin/HEAD; run: git remote set-head origin --auto`);
    throw e;
  }
  const [sha, branch, origin] = out.split('\n');
  return { sha, branch, main: origin.replace(/^origin\//, '') };
}

/** @param {() => void} fn @param {number} ms */
function debounce(fn, ms) {
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}

/**
 * The cached promise for `key`, made on first use; a rejection is dropped so the next call retries.
 * @template T @param {Map<string, Promise<T>>} map @param {string} key @param {() => Promise<T>} make
 */
function memo(map, key, make) {
  let p = map.get(key);
  if (!p) {
    p = make();
    map.set(key, p);
    p.catch(() => map.delete(key));
  }
  return p;
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
