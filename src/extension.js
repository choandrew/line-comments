// @ts-check
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const store = require('./store');
const { git, locate } = require('./track');

/** @typedef {{ root: string, dir: string, id: string }} Ref */

/** @param {vscode.ExtensionContext} context */
function activate(context) {
  const controller = vscode.comments.createCommentController('line-comments', 'Line Comments');
  const archivedButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  archivedButton.command = 'lineComments.toggleArchived';
  const notice = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  /** @type {Map<string, string>} workspace folder -> comment folder, when configured and on the default branch */
  let active = new Map();
  /** @type {Map<string, vscode.CommentThread>} keyed by thread directory */
  const shown = new Map();
  /** @type {Map<vscode.CommentThread, Ref>} */
  const refs = new Map();
  /** @type {vscode.Disposable[]} */
  let watchers = [];
  /** @type {Set<string>} */
  let errors = new Set();
  let showArchived = false;

  controller.commentingRangeProvider = {
    provideCommentingRanges: (doc) => {
      const root = rootOf(doc.uri);
      const dir = root === undefined ? undefined : active.get(root);
      if (dir === undefined || doc.uri.fsPath.startsWith(dir + path.sep)) return [];
      return [new vscode.Range(0, 0, doc.lineCount - 1, 0)];
    },
  };

  /** Re-reads config, branches and every thread, then updates what VS Code shows. */
  function sync() {
    /** @type {string[]} */
    const failures = [];
    /** @type {{ text: string, tooltip: string, command?: vscode.Command } | undefined} */
    let problem;
    active = new Map();
    for (const root of roots()) {
      try {
        const dir = folderOf(root);
        if (dir === undefined) {
          problem ??= {
            text: '$(warning) Line Comments: set a folder',
            tooltip: 'Choose the shared folder that holds comment threads (lineComments.folder)',
            command: { title: 'Open settings', command: 'workbench.action.openSettings', arguments: ['lineComments.folder'] },
          };
          continue;
        }
        const { branch, main } = branches(root);
        if (branch !== main) {
          problem ??= {
            text: `$(git-branch) Line Comments: ${main} only`,
            tooltip: `Comments refer to ${main}'s lines, so they show only while ${path.basename(root)} is on ${main}`,
            command: undefined,
          };
          continue;
        }
        active.set(root, dir);
      } catch (e) {
        failures.push(message(e));
      }
    }

    const seen = new Set();
    let archived = 0;
    for (const [root, dir] of active) {
      for (const id of store.list(dir)) {
        try {
          const thread = store.read(dir, id);
          if (thread.archived) archived++;
          if (thread.archived && !showArchived) continue;
          const key = path.join(dir, id);
          seen.add(key);
          render(key, { root, dir, id }, thread);
        } catch (e) {
          failures.push(message(e));
        }
      }
    }
    for (const [key, thread] of shown) {
      if (seen.has(key)) continue;
      thread.dispose();
      shown.delete(key);
      refs.delete(thread);
    }

    // Each distinct problem notifies once, not on every file event while it persists.
    for (const f of failures) if (!errors.has(f)) showError(f);
    errors = new Set(failures);

    if (problem) Object.assign(notice, problem).show();
    else notice.hide();
    archivedButton.text = showArchived ? '$(eye-closed) Hide archived threads' : `$(archive) ${archived} archived`;
    archivedButton.tooltip = showArchived ? 'Hide archived comment threads' : 'Show archived comment threads';
    if (active.size > 0 && (archived > 0 || showArchived)) archivedButton.show();
    else archivedButton.hide();
  }

  /** Watches each comment folder (which may sit outside the workspace) and each repo's HEAD and reflog. */
  function rewatch() {
    for (const w of watchers) w.dispose();
    watchers = [];
    /** @param {string} base @param {string} glob */
    const watch = (base, glob) => {
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(base), glob));
      watchers.push(w, w.onDidCreate(resync), w.onDidChange(resync), w.onDidDelete(resync));
    };
    for (const root of roots()) {
      try {
        // logs/HEAD gains a line on every checkout, commit, pull or reset, so it catches main moving.
        const gitDir = git(root, 'rev-parse', '--path-format=absolute', '--git-dir');
        watch(gitDir, '{HEAD,logs/HEAD}');
        const dir = folderOf(root);
        if (dir !== undefined) watch(dir, '**/*.json');
      } catch {
        // sync() reports the same failure.
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
      refs.set(t, ref);
    }
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
    const dir = root === undefined ? undefined : active.get(root);
    if (root === undefined || dir === undefined) throw new Error('commenting is off here; see the status bar');
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
      store.reply(ref.dir, ref.id, entry);
    } else {
      const doc = await vscode.workspace.openTextDocument(thread.uri);
      const line = thread.range.start.line;
      const rel = path.relative(root, thread.uri.fsPath).split(path.sep).join('/');
      const commit = git(root, 'rev-parse', 'HEAD');
      store.create(dir, { path: rel, line: line + 1, text: doc.lineAt(line).text, commit }, entry);
      thread.dispose();
    }
    sync();
  }

  /** @param {boolean} archived @returns {(thread: vscode.CommentThread) => void} */
  const archive = (archived) => (thread) => {
    const { dir, id } = ref(thread);
    store.setArchived(dir, id, archived);
    sync();
  };

  /** @param {vscode.CommentThread} thread */
  async function remove(thread) {
    const choice = await vscode.window.showWarningMessage(
      'Delete this thread and all its comments?',
      { modal: true, detail: 'Archive keeps the thread and only hides it.' },
      'Delete',
    );
    if (choice !== 'Delete') return;
    const { dir, id } = ref(thread);
    store.remove(dir, id);
    sync();
  }

  function toggleArchived() {
    showArchived = !showArchived;
    sync();
  }

  /** @param {vscode.CommentThread} thread @returns {Ref} */
  function ref(thread) {
    const r = refs.get(thread);
    if (!r) throw new Error('this thread is not saved yet');
    return r;
  }

  /** @type {NodeJS.Timeout | undefined} */
  let pending;
  // A pull or checkout fires many file events at once; sync once they settle.
  const resync = () => {
    clearTimeout(pending);
    pending = setTimeout(guard(sync), 150);
  };

  context.subscriptions.push(
    controller,
    archivedButton,
    notice,
    { dispose: () => watchers.forEach((w) => w.dispose()) },
    { dispose: () => clearTimeout(pending) },
    vscode.workspace.onDidSaveTextDocument(resync),
    vscode.workspace.onDidChangeWorkspaceFolders(rewatch),
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('lineComments.folder') && rewatch()),
    vscode.commands.registerCommand('lineComments.comment', guard(comment)),
    vscode.commands.registerCommand('lineComments.archive', guard(archive(true))),
    vscode.commands.registerCommand('lineComments.unarchive', guard(archive(false))),
    vscode.commands.registerCommand('lineComments.delete', guard(remove)),
    vscode.commands.registerCommand('lineComments.toggleArchived', guard(toggleArchived)),
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

/**
 * The configured comment folder for a workspace folder, or undefined when unset. `~` and paths
 * relative to the workspace folder are allowed; a folder that does not exist is an error.
 * @param {string} root @returns {string | undefined}
 */
function folderOf(root) {
  const setting = vscode.workspace.getConfiguration('lineComments', vscode.Uri.file(root)).get('folder');
  if (setting === undefined || setting === '') return undefined;
  if (typeof setting !== 'string') throw new Error('lineComments.folder must be a string');
  const dir = path.resolve(root, setting.replace(/^~(?=$|[\\/])/, os.homedir()));
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`lineComments.folder ${dir} is not a folder`);
  return dir;
}

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
