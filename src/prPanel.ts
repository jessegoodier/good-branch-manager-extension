import * as vscode from 'vscode';
import { Branch, Git } from './git';
import { CreatePrInput, RemoteRepo as GitHubRepo, createPullRequest } from './github';

interface PrDefaults {
  head: string;
  base: string;
  branches: string[];
  title: string;
  body: string;
}

export async function openCreatePrPanel(
  git: Git,
  repo: GitHubRepo,
  branch: Branch,
  defaultBranch: string,
  localBranches: Branch[],
  onCreated: () => void
): Promise<void> {
  const base = defaultBranch;
  const commits = await git.getCommitSummaries(`origin/${base}`, branch.name);
  const title =
    commits.length === 1 ? commits[0] : prettifyBranchName(branch.name);
  const body =
    commits.length > 1 ? '## Changes\n\n' + commits.map((c) => `- ${c}`).join('\n') : '';

  const defaults: PrDefaults = {
    head: branch.name,
    base,
    branches: localBranches.map((b) => b.name).filter((n) => n !== branch.name),
    title,
    body
  };

  const panel = vscode.window.createWebviewPanel(
    'gitBranchPr.createPr',
    `New PR: ${branch.name}`,
    vscode.ViewColumn.Active,
    { enableScripts: true }
  );
  panel.webview.html = renderHtml(panel.webview, defaults, repo);

  panel.webview.onDidReceiveMessage(async (msg) => {
    if (msg.type === 'cancel') {
      panel.dispose();
      return;
    }
    if (msg.type !== 'submit') {
      return;
    }
    const input: CreatePrInput = {
      title: String(msg.title ?? '').trim(),
      body: String(msg.body ?? ''),
      base: String(msg.base ?? base),
      head: branch.name,
      draft: Boolean(msg.draft)
    };
    if (!input.title) {
      panel.webview.postMessage({ type: 'error', message: 'Title is required.' });
      return;
    }
    try {
      panel.webview.postMessage({ type: 'busy' });
      // Make sure the branch exists on the remote and is up to date before opening the PR.
      await git.exec(['push', '--set-upstream', 'origin', branch.name]);
      const pr = await createPullRequest(repo, input);
      panel.dispose();
      onCreated();
      const open = 'Open in Browser';
      const picked = await vscode.window.showInformationMessage(
        `Pull request #${pr.number} created.`,
        open
      );
      if (picked === open) {
        await vscode.env.openExternal(vscode.Uri.parse(pr.htmlUrl));
      }
    } catch (err: any) {
      panel.webview.postMessage({ type: 'error', message: err?.message ?? String(err) });
    }
  });
}

function prettifyBranchName(name: string): string {
  const last = name.split('/').pop() ?? name;
  const words = last.replace(/[-_]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderHtml(webview: vscode.Webview, d: PrDefaults, repo: GitHubRepo): string {
  const nonce = Math.random().toString(36).slice(2);
  const baseOptions = [d.base, ...d.branches.filter((b) => b !== d.base)]
    .map((b) => `<option value="${escapeHtml(b)}"${b === d.base ? ' selected' : ''}>${escapeHtml(b)}</option>`)
    .join('');
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    max-width: 680px;
    margin: 0 auto;
    padding: 16px 20px;
  }
  h2 { font-weight: 400; margin-bottom: 4px; }
  .meta { color: var(--vscode-descriptionForeground); margin-bottom: 20px; }
  .meta code {
    background: var(--vscode-textCodeBlock-background);
    padding: 1px 5px;
    border-radius: 3px;
  }
  label { display: block; margin: 14px 0 4px; font-weight: 600; }
  input[type=text], textarea, select {
    width: 100%;
    box-sizing: border-box;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 3px;
    padding: 6px 8px;
    font-family: inherit;
    font-size: inherit;
  }
  textarea { min-height: 160px; resize: vertical; }
  .row { display: flex; align-items: center; gap: 8px; margin-top: 14px; }
  .actions { margin-top: 22px; display: flex; gap: 10px; }
  button {
    border: none;
    border-radius: 3px;
    padding: 7px 16px;
    cursor: pointer;
    font-size: inherit;
  }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button.primary:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  button:disabled { opacity: 0.6; cursor: default; }
  .error {
    display: none;
    margin-top: 14px;
    padding: 8px 12px;
    border-radius: 3px;
    background: var(--vscode-inputValidation-errorBackground);
    border: 1px solid var(--vscode-inputValidation-errorBorder);
  }
</style>
</head>
<body>
  <h2>Create Pull Request</h2>
  <div class="meta">
    ${escapeHtml(repo.owner)}/${escapeHtml(repo.repo)} &nbsp;·&nbsp;
    <code>${escapeHtml(d.head)}</code> →
    <select id="base" style="width:auto; display:inline-block;">${baseOptions}</select>
  </div>

  <label for="title">Title</label>
  <input id="title" type="text" value="${escapeHtml(d.title)}" />

  <label for="body">Description</label>
  <textarea id="body">${escapeHtml(d.body)}</textarea>

  <div class="row">
    <input id="draft" type="checkbox" />
    <label for="draft" style="margin:0; font-weight:400;">Create as draft</label>
  </div>

  <div id="error" class="error"></div>

  <div class="actions">
    <button id="create" class="primary">Create Pull Request</button>
    <button id="cancel" class="secondary">Cancel</button>
  </div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const el = (id) => document.getElementById(id);
  el('create').addEventListener('click', () => {
    vscode.postMessage({
      type: 'submit',
      title: el('title').value,
      body: el('body').value,
      base: el('base').value,
      draft: el('draft').checked
    });
  });
  el('cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg.type === 'busy') {
      el('create').disabled = true;
      el('create').textContent = 'Creating...';
      el('error').style.display = 'none';
    } else if (msg.type === 'error') {
      el('create').disabled = false;
      el('create').textContent = 'Create Pull Request';
      el('error').textContent = msg.message;
      el('error').style.display = 'block';
    }
  });
</script>
</body>
</html>`;
}
