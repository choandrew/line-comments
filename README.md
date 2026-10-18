# Line Comments

Comment threads on any line of code in VS Code or Cursor, outside pull requests. Threads are stored in S3
(e.g. SeaweedFS) or a shared folder, so your team and coding agents see the same comments.

## Install

```bash
curl -fsSLO https://github.com/choandrew/line-comments/releases/latest/download/line-comments.vsix && code --install-extension line-comments.vsix
```

In Cursor, replace `code` with `cursor`.

## Set up

In your VS Code or Cursor user settings:

```json
{
  "lineComments.location": "s3://trading/line-comments",
  "lineComments.s3.endpoint": "http://seaweedfs.example:8333"
}
```

`location` can also be a folder, such as a Dropbox path. Unset, it is `~/.line-comments`. If the
S3 store needs a key, the side bar asks for one.

## Use

- Click `+` next to a line number to start a thread. Anyone can reply.
- Archive hides a thread; delete removes it. Edit or delete your own comments from their title bar.
- A dot marks threads with comments you haven't seen, and replies in threads you're in pop up a notification.
- The Line Comments side bar lists every thread and shows archived ones on request.
- Comments show only on the default branch (usually `main`) and follow the code as it changes.

## For agents

`npx -y github:choandrew/line-comments open` prints the repo's open threads as `path:line: [author] body`,
replies indented, at the lines they sit on in your working tree. It finds the location as the extension
does; `--location`, `--endpoint` or `LINE_COMMENTS_LOCATION` override it. Put this in AGENTS.md or CLAUDE.md:

> Open line comments: run `npx -y github:choandrew/line-comments open`; address each, then archive or reply in VS Code.

## Storage format

```
<location>/<owner>/<repo>/<thread-id>/thread.json        {"path", "line", "text", "commit", "archived"}
<location>/<owner>/<repo>/<thread-id>/<comment-id>.json  {"author", "body", "at", "edited"?}
```

`line` is 1-based and refers to `commit`.

## Develop

```bash
npm ci && npm run check
```

Set `LINE_COMMENTS_TEST_S3` and `LINE_COMMENTS_TEST_S3_OPEN` to also test against S3, as
`.github/workflows/ci.yml` does. Push a `v*` tag to release.
