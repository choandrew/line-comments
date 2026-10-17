# Line Comments

GitHub-style comment threads on any line of code in VS Code, without a pull request. Threads live
in a folder you choose, such as a Dropbox, Google Drive, OneDrive or network-share folder, so
everyone pointed at it sees new comments as they sync. Coding agents (Claude Code, Codex) can read
the same files.

## Install

```bash
curl -fsSLO https://github.com/choandrew/line-comments/releases/latest/download/line-comments.vsix && code --install-extension line-comments.vsix
```

Or download `line-comments.vsix` from the [latest release](https://github.com/choandrew/line-comments/releases/latest)
and run **Extensions: Install from VSIX…** in VS Code.

## Set up

Set `lineComments.folder` to the shared folder for this repo, in your user settings or the repo's
`.vscode/settings.json`:

```json
{ "lineComments.folder": "~/Dropbox/reviews/my-repo" }
```

`~` and paths relative to the workspace folder work. Use one folder per repo. Until it is set,
the status bar shows **Line Comments: set a folder**.

## Use

- **Comment:** hover the gutter next to a line and click `+`.
- **Reply:** anyone can add to any thread.
- **Archive:** the archive button hides a thread; **Unarchive** brings it back.
- **Delete:** the trash button removes a thread and all its comments, after a confirmation.
- **See archived threads:** click `N archived` in the status bar, or run
  **Line Comments: Show/Hide Archived Threads**.

Comments show only while the repo is on its default branch (the one `origin/HEAD` names, usually
`main`), because their line numbers refer to that branch. Your name comes from `git config user.name`.

## Lines follow the code

Each thread records the commit it was written on. When `main` moves (you pull, commit or check
out), the extension replays `git diff` from that commit to the working tree:

- Lines added or removed above a thread move it, even when an identical line exists elsewhere.
- A renamed file takes its threads with it.
- If the commented line itself was rewritten, the thread looks for that text only inside the
  rewritten lines; if it is gone, the thread stays nearby and its header says the line changed.
- If your clone lacks the commit (a teammate commented on a newer `main`), the thread goes to the
  nearest line with the same text until you pull.

## Storage format

```
<folder>/<thread-id>/thread.json       {"path": "src/app.py", "line": 42, "text": "the line when commented",
                                        "commit": "<sha the comment was written on>", "archived": false}
<folder>/<thread-id>/<comment-id>.json {"author": "Ada", "body": "Markdown text", "at": "2026-10-17T18:03:00.000Z"}
```

- `path` is relative to the repo root; `line` is 1-based and refers to `commit`.
- Each comment is its own file, so two people replying at once never conflict in a sync service.
- Comments are ordered by `at` (ISO 8601).

To point an agent at the comments, add a line like this to the repo's `AGENTS.md` or `CLAUDE.md`:

> Line review comments live in `~/Dropbox/reviews/my-repo`; the format is at https://github.com/choandrew/line-comments#storage-format.

## Develop

```bash
npm ci && npm run check
```

Push a `v*` tag to build and publish a release.
