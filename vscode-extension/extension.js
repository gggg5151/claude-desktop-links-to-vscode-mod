'use strict';
// Claude Open Bridge
//
// The open-in-vscode mod opens files with `code -r -g path:line:col`, but
// `code -g` cannot move a Markdown file shown in the built-in Markdown Preview
// (a custom editor): it opens a new text tab beside it instead. For those
// files the mod POSTs /reveal to this window's socket instead of running the
// CLI, and this extension opens / scrolls the file itself.
//
// Socket:   ~/.cache/claude-open-bridge/<pid>.sock  (HTTP over a unix socket)
// Registry: ~/.cache/claude-open-bridge/<pid>.json  (pid, socket, folders,
//           workspaceFile, focusedAt)

const vscode = require('vscode');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const VERSION = require('./package.json').version;
const PREVIEW_VIEW_TYPE = 'vscode.markdown.preview.editor';
const TAB_WAIT_MS = 3000;
const POLL_MS = 50;
const SCROLL_WAIT_MS = 500;
// Scrolling has come to rest once no visible-range change follows for this long.
const QUIET_MS = 40;
const REOPEN_WAIT_MS = 1000;
const MAX_BODY_BYTES = 64 * 1024;

const dir = path.join(os.homedir(), '.cache', 'claude-open-bridge');
const sockPath = path.join(dir, `${process.pid}.sock`);
const jsonPath = path.join(dir, `${process.pid}.json`);

let server = null;
let focusedAt = 0;
let cleanedUp = false;
let queue = Promise.resolve();

function activate(context) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  focusedAt = vscode.window.state.focused ? Date.now() : 0;

  try {
    fs.unlinkSync(sockPath); // a stale socket file makes listen() fail
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  server = http.createServer(handle);
  server.on('error', (err) => console.error('[claude-open-bridge] server error:', err));
  server.listen(sockPath, () => {
    try {
      fs.chmodSync(sockPath, 0o600);
    } catch (err) {
      console.error('[claude-open-bridge] chmod failed:', err);
    }
    writeRegistry();
  });

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => writeRegistry()),
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) {
        focusedAt = Date.now();
        writeRegistry();
      }
    }),
    { dispose: cleanup },
  );
}

function deactivate() {
  cleanup();
}

function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  if (server) {
    try {
      server.close();
    } catch (_) {
      // already closed
    }
  }
  for (const file of [sockPath, jsonPath]) {
    try {
      fs.unlinkSync(file);
    } catch (_) {
      // already gone
    }
  }
}

function folders() {
  return (vscode.workspace.workspaceFolders || [])
    .filter((f) => f.uri.scheme === 'file')
    .map((f) => f.uri.fsPath);
}

// The window's saved .code-workspace file, which the mod names to `code` to
// bring a multi-root window to the front; absent for a folder or an untitled
// workspace.
function workspaceFile() {
  const file = vscode.workspace.workspaceFile;
  return file && file.scheme === 'file' ? file.fsPath : undefined;
}

function writeRegistry() {
  if (cleanedUp || !server || !server.listening) return;
  const data = { pid: process.pid, socket: sockPath, folders: folders(), workspaceFile: workspaceFile(), focusedAt };
  const tmp = `${jsonPath}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, jsonPath);
  } catch (err) {
    console.error('[claude-open-bridge] registry write failed:', err);
  }
}

// ---- HTTP ----------------------------------------------------------------

function handle(req, res) {
  const url = (req.url || '').split('?')[0];
  if (req.method === 'GET' && url === '/health') {
    send(res, 200, { ok: true, pid: process.pid, version: VERSION, folders: folders() });
    return;
  }
  if (req.method === 'POST' && url === '/reveal') {
    readBody(req, (status, body) => {
      if (status !== 200) {
        send(res, status, { ok: false, error: body });
        return;
      }
      let args;
      try {
        args = parseReveal(body);
      } catch (err) {
        send(res, 400, { ok: false, error: err.message });
        return;
      }
      enqueue(() => reveal(args)).then(
        (result) => send(res, 200, Object.assign({ ok: true }, result)),
        (err) => send(res, 500, { ok: false, error: String((err && err.message) || err) }),
      );
    });
    return;
  }
  send(res, 404, { ok: false, error: 'not found' });
}

function readBody(req, done) {
  const chunks = [];
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size <= MAX_BODY_BYTES) chunks.push(chunk);
  });
  req.on('end', () => {
    if (size > MAX_BODY_BYTES) done(413, 'body too large');
    else done(200, Buffer.concat(chunks).toString('utf8'));
  });
  req.on('error', (err) => done(400, err.message));
}

function send(res, status, obj) {
  if (res.headersSent) return;
  const body = JSON.stringify(obj) + '\n';
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function parseReveal(text) {
  let v;
  try {
    v = JSON.parse(text);
  } catch (_) {
    throw new Error('body must be JSON');
  }
  if (!v || typeof v !== 'object') throw new Error('body must be a JSON object');
  if (typeof v.path !== 'string' || !path.isAbsolute(v.path) || v.path.includes('\0')) {
    throw new Error('path must be an absolute path');
  }
  const line = v.line === undefined ? 1 : v.line;
  const column = v.column === undefined ? 1 : v.column;
  if (!Number.isInteger(line) || line < 1) throw new Error('line must be a positive integer');
  if (!Number.isInteger(column) || column < 1) throw new Error('column must be a positive integer');
  return { file: path.normalize(v.path), line, column };
}

// One reveal at a time: each one moves tabs around.
function enqueue(task) {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
}

// ---- reveal --------------------------------------------------------------

// 1. A Markdown Preview tab of the file exists: move that preview to the line.
// 2. Else a text tab exists: move its cursor to the line.
// 3. Else open the file with the user's default editor, then do 1 or 2.
async function reveal({ file, line, column }) {
  const isTarget = pathMatcher(file);

  const preview = findTab((tab) => isPreviewInput(tab.input) && isTarget(tab.input.uri));
  if (preview) {
    await revealInPreview(preview.tab.input.uri, preview.group.viewColumn, line, column);
    return { mode: 'preview' };
  }
  const text = findTab((tab) => isTextInput(tab.input) && isTarget(tab.input.uri));
  if (text) {
    await revealInText(text.tab.input.uri, text.group.viewColumn, line, column);
    return { mode: 'text' };
  }

  const pos = new vscode.Position(line - 1, column - 1);
  await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(file), {
    selection: new vscode.Range(pos, pos),
  });
  const opened = await waitForTab(
    (tab) => (isTextInput(tab.input) || tab.input instanceof vscode.TabInputCustom) && isTarget(tab.input.uri),
  );
  if (!opened) throw new Error(`no editor tab opened for ${file}`);
  const input = opened.tab.input;
  if (isPreviewInput(input)) {
    await revealInPreview(input.uri, opened.group.viewColumn, line, column);
    return { mode: 'preview' };
  }
  if (!isTextInput(input)) return { mode: 'custom' }; // another custom editor: no line to go to
  await revealInText(input.uri, opened.group.viewColumn, line, column);
  return { mode: 'text' };
}

function pathMatcher(file) {
  const wanted = new Set([file, realpath(file)]);
  const cache = new Map();
  return (uri) => {
    if (uri.scheme !== 'file') return false;
    if (wanted.has(uri.fsPath)) return true;
    if (!cache.has(uri.fsPath)) cache.set(uri.fsPath, realpath(uri.fsPath));
    return wanted.has(cache.get(uri.fsPath));
  };
}

function realpath(p) {
  try {
    return fs.realpathSync(p);
  } catch (_) {
    return p;
  }
}

function isPreviewInput(input) {
  return input instanceof vscode.TabInputCustom && input.viewType === PREVIEW_VIEW_TYPE;
}

function isTextInput(input) {
  return input instanceof vscode.TabInputText;
}

function sameUri(a, b) {
  return a.toString() === b.toString();
}

function groupOf(viewColumn) {
  return vscode.window.tabGroups.all.find((g) => g.viewColumn === viewColumn);
}

// A tab passing `test`: in the active group first (its active tab first),
// else in the first group that has one.
function findTab(test) {
  const groups = vscode.window.tabGroups;
  const active = groups.activeTabGroup;
  const ordered = active ? [active].concat(groups.all.filter((g) => g !== active)) : groups.all;
  for (const group of ordered) {
    if (group.activeTab && test(group.activeTab)) return { tab: group.activeTab, group };
    const tab = group.tabs.find(test);
    if (tab) return { tab, group };
  }
  return null;
}

function waitForTab(test) {
  return new Promise((resolve) => {
    const start = Date.now();
    let finished = false;
    let sub = null;
    let timer = null;
    const finish = (value) => {
      if (finished) return;
      finished = true;
      if (timer) clearInterval(timer);
      if (sub) sub.dispose();
      resolve(value);
    };
    const check = () => {
      const found = findTab(test);
      if (found) finish(found);
      else if (Date.now() - start >= TAB_WAIT_MS) finish(null);
    };
    sub = vscode.window.tabGroups.onDidChangeTabs(check);
    timer = setInterval(check, POLL_MS);
    check();
  });
}

// The Markdown preview takes no line from outside. A newly opened static
// preview starts at the topmost visible line of the most recent text editor
// of the same file (markdown-language-features' TopmostLineMonitor, recorded
// on onDidChangeTextEditorVisibleRanges and consumed by the next preview
// open). So: show the file as text in the preview's group, scroll the line to
// the top, close the old preview tab(s), and open a fresh preview there.
// `vscode.openWith` is used rather than `reopenActiveEditorWith`, which would
// convert a text tab the user already had.
async function revealInPreview(uri, viewColumn, line, column) {
  const before = groupOf(viewColumn);
  const hadText = !!before && before.tabs.some((tab) => isTextInput(tab.input) && sameUri(tab.input.uri, uri));

  const doc = await vscode.workspace.openTextDocument(uri);
  const pos = doc.validatePosition(new vscode.Position(line - 1, column - 1));
  const range = new vscode.Range(pos, pos);
  const editor = await vscode.window.showTextDocument(doc, {
    viewColumn,
    selection: range,
    preview: false,
  });
  await scrollLineToTop(editor, range);

  const group = groupOf(viewColumn);
  const oldPreviews = group ? group.tabs.filter((tab) => isPreviewTabOf(tab, uri)) : [];
  if (oldPreviews.length) await vscode.window.tabGroups.close(oldPreviews, true);

  await vscode.commands.executeCommand('vscode.openWith', uri, PREVIEW_VIEW_TYPE, {
    viewColumn,
    preserveFocus: false,
  });
  const previewActive = () => {
    const g = groupOf(viewColumn);
    return !!g && !!g.activeTab && isPreviewTabOf(g.activeTab, uri);
  };
  if (!(await waitUntil(previewActive, REOPEN_WAIT_MS))) {
    throw new Error('the Markdown preview did not open');
  }

  if (!hadText) {
    const g = groupOf(viewColumn);
    const ours = g ? g.tabs.filter((tab) => isTextInput(tab.input) && sameUri(tab.input.uri, uri)) : [];
    if (ours.length) await vscode.window.tabGroups.close(ours, true);
    if (!(await waitUntil(previewActive, REOPEN_WAIT_MS))) {
      throw new Error('the Markdown preview is not the active tab');
    }
  }
}

// Scrolls the editor so that `range`'s line is its first visible line, and
// waits until the editor reports it, so TopmostLineMonitor has recorded it.
// editorScroll moves the view by whole lines; revealRange(AtTop) would leave
// the line below the headings sticky scroll pins over the top, and the
// preview would start that many lines early.
async function scrollLineToTop(editor, range) {
  const target = range.start.line;
  // A scroll by no lines fires no event, and the monitor would keep an older
  // line: step off the line first when it is already at the top.
  if (topLine(editor) === target) await scrollBy(editor, target > 0 ? -1 : 1);
  // The visible ranges can lag behind a scroll; correct until they agree.
  for (let i = 0; i < 3; i++) {
    const top = topLine(editor);
    if (top < 0 || top === target) return;
    if (!(await scrollBy(editor, target - top))) return; // nothing moved: the end of the file
  }
}

// Scrolls the active editor (`editor`, which revealInPreview has just shown)
// by `lines`, down when positive; resolves false when nothing moved.
async function scrollBy(editor, lines) {
  const moved = waitForScroll(editor, SCROLL_WAIT_MS);
  await vscode.commands.executeCommand('editorScroll', {
    to: lines > 0 ? 'down' : 'up',
    by: 'line',
    value: Math.abs(lines),
  });
  return moved;
}

function topLine(editor) {
  const ranges = editor.visibleRanges;
  return ranges.length ? ranges[0].start.line : -1;
}

async function revealInText(uri, viewColumn, line, column) {
  const doc = await vscode.workspace.openTextDocument(uri);
  const pos = doc.validatePosition(new vscode.Position(line - 1, column - 1));
  const range = new vscode.Range(pos, pos);
  const editor = await vscode.window.showTextDocument(doc, { viewColumn, selection: range });
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

function isPreviewTabOf(tab, uri) {
  return isPreviewInput(tab.input) && sameUri(tab.input.uri, uri);
}

// Resolves true once the editor's visible ranges change and then stay put
// for QUIET_MS, false when they do not change within `timeoutMs`.
function waitForScroll(editor, timeoutMs) {
  return new Promise((resolve) => {
    const key = editor.document.uri.toString();
    let sub = null;
    let quiet = null;
    const timer = setTimeout(() => finish(false), timeoutMs);
    const finish = (value) => {
      clearTimeout(timer);
      clearTimeout(quiet);
      if (sub) sub.dispose();
      resolve(value);
    };
    sub = vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
      const same =
        e.textEditor === editor ||
        (e.textEditor.document.uri.toString() === key && e.textEditor.viewColumn === editor.viewColumn);
      if (!same) return;
      clearTimeout(timer);
      clearTimeout(quiet);
      quiet = setTimeout(() => finish(true), QUIET_MS);
    });
  });
}

function waitUntil(predicate, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve(true);
      if (Date.now() - start >= timeoutMs) return resolve(false);
      setTimeout(tick, POLL_MS);
    };
    tick();
  });
}

module.exports = { activate, deactivate };
