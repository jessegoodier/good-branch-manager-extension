import * as vscode from 'vscode';
import { Branch, Git, GitError } from './git';
import { branchUrl, resolveGitHubRepo, resolveRemoteRepo } from './github';
import { openCreatePrPanel } from './prPanel';
import { BranchNode, BranchTreeProvider } from './tree';

const BRANCH_NAME_RE = /^(?!\/|.*(?:\/\.|\/\/|\.\.|@\{|\\))[^\x00-\x20~^:?*[\]]+(?<!\.lock)(?<!\/)(?<!\.)$/;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const tree = new BranchTreeProvider();
  const view = vscode.window.createTreeView('goodBranchManager.branches', {
    treeDataProvider: tree,
    showCollapseAll: false
  });
  context.subscriptions.push(view);

  // Auto-refresh: follow repository state from the built-in git extension (commits,
  // checkouts, pushes, fetches all fire onDidChange). Debounced — state changes burst.
  let timer: NodeJS.Timeout | undefined;
  let interval: NodeJS.Timeout | undefined;
  const scheduleRefresh = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => tree.refresh(), 400);
  };
  const configureBackgroundRefresh = () => {
    if (interval) clearInterval(interval);
    interval = undefined;

    const minutes = vscode.workspace.getConfiguration('goodBranchManager').get<number>('refreshIntervalMins', 0);
    if (minutes > 0) {
      interval = setInterval(() => tree.refresh(), minutes * 60 * 1000);
    }
  };
  configureBackgroundRefresh();
  context.subscriptions.push({
    dispose: () => {
      if (timer) clearTimeout(timer);
      if (interval) clearInterval(interval);
    }
  });
  const gitExt = vscode.extensions.getExtension('vscode.git');
  if (gitExt) {
    const api = (await gitExt.activate()).getAPI(1);
    const hook = (repo: any) => context.subscriptions.push(repo.state.onDidChange(scheduleRefresh));
    api.repositories.forEach(hook);
    context.subscriptions.push(api.onDidOpenRepository((repo: any) => {
      hook(repo);
      scheduleRefresh();
    }));
    context.subscriptions.push(api.onDidCloseRepository(scheduleRefresh));
  }
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('goodBranchManager.refreshIntervalMins')) configureBackgroundRefresh();
      if (e.affectsConfiguration('goodBranchManager')) scheduleRefresh();
    })
  );

  const register = (command: string, handler: (node: BranchNode) => Promise<void>) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(command, async (node?: BranchNode) => {
        if (!(node instanceof BranchNode)) return;
        try {
          await handler(node);
        } catch (err: any) {
          const detail = err instanceof GitError ? err.stderr || err.message : err?.message ?? String(err);
          vscode.window.showErrorMessage(`Branches: ${detail}`);
        }
      })
    );

  context.subscriptions.push(
    vscode.commands.registerCommand('goodBranchManager.refresh', () => tree.refresh())
  );

  register('goodBranchManager.checkout', async (node) => {
    const git = requireGit(tree);
    const b = node.branch;
    if (b.isRemote) {
      // Creates a local branch tracking the remote one (or switches if it exists).
      await git.exec(['switch', b.shortName]);
    } else {
      await git.exec(['switch', b.name]);
    }
    tree.refresh();
    vscode.window.setStatusBarMessage(`Checked out ${b.isRemote ? b.shortName : b.name}`, 4000);
  });

  register('goodBranchManager.createBranchFrom', async (node) => {
    const git = requireGit(tree);
    const source = node.branch.name;
    const name = await vscode.window.showInputBox({
      prompt: `New branch from ${source}`,
      placeHolder: 'e.g. feature/my-change',
      validateInput: (v) =>
        !v.trim() ? 'Branch name is required.'
          : !BRANCH_NAME_RE.test(v.trim()) ? 'Not a valid git branch name.'
            : undefined
    });
    if (!name) return;
    await git.exec(['switch', '-c', name.trim(), source]);
    tree.refresh();
    vscode.window.setStatusBarMessage(`Created and checked out ${name.trim()}`, 4000);
  });

  register('goodBranchManager.openOnGitHub', async (node) => {
    const git = requireGit(tree);
    const repo = await resolveRemoteRepo(git, node.branch.remote ?? 'origin');
    if (!repo) {
      vscode.window.showWarningMessage(
        'Could not determine the remote repository URL. Make sure "origin" is set.'
      );
      return;
    }
    const remoteBranch = node.branch.isRemote
      ? node.branch.shortName
      : node.branch.upstream?.replace(/^[^/]+\//, '') ?? node.branch.name;
    await vscode.env.openExternal(vscode.Uri.parse(branchUrl(repo, remoteBranch)));
  });

  register('goodBranchManager.renameBranch', async (node) => {
    const git = requireGit(tree);
    const oldName = node.branch.name;
    const newName = await vscode.window.showInputBox({
      prompt: `Rename branch ${oldName}`,
      value: oldName,
      validateInput: (v) =>
        !v.trim() ? 'Branch name is required.'
          : !BRANCH_NAME_RE.test(v.trim()) ? 'Not a valid git branch name.'
            : undefined
    });
    if (!newName || newName.trim() === oldName) return;
    await git.exec(['branch', '-m', oldName, newName.trim()]);
    tree.refresh();
  });

  register('goodBranchManager.mergeIntoCurrent', async (node) => {
    const git = requireGit(tree);
    const current = tree.getRepoInfo()?.headBranch ?? 'the current branch';
    const source = node.branch.name;
    const ok = await vscode.window.showInformationMessage(
      `Merge ${source} into ${current}?`,
      { modal: true },
      'Merge'
    );
    if (ok !== 'Merge') return;
    try {
      await git.exec(['merge', source]);
      vscode.window.setStatusBarMessage(`Merged ${source} into ${current}`, 4000);
    } catch (err) {
      if (err instanceof GitError && /conflict/i.test(err.stderr)) {
        vscode.window.showWarningMessage(
          'Merge produced conflicts. Resolve them in the Source Control view, then commit.'
        );
      } else {
        throw err;
      }
    }
    tree.refresh();
  });

  register('goodBranchManager.deleteBranch', async (node) => {
    const git = requireGit(tree);
    const b = node.branch;

    if (b.isRemote) {
      const confirm = await vscode.window.showWarningMessage(
        `Delete remote branch ${b.name}? This affects everyone using this repository.`,
        { modal: true },
        'Delete Remote Branch'
      );
      if (!confirm) return;
      await git.exec(['push', b.remote ?? 'origin', '--delete', b.shortName]);
      tree.refresh();
      return;
    }

    const confirm = await vscode.window.showWarningMessage(
      `Delete branch ${b.name}?`,
      { modal: true, detail: b.merged ? 'This branch is already merged.' : undefined },
      'Delete'
    );
    if (!confirm) return;

    try {
      await git.exec(['branch', '-d', b.name]);
    } catch (err) {
      if (!(err instanceof GitError && /not fully merged/i.test(err.stderr))) throw err;
      const force = await vscode.window.showWarningMessage(
        `${b.name} has commits that are not merged anywhere. Delete anyway?`,
        { modal: true },
        'Force Delete'
      );
      if (force !== 'Force Delete') return;
      await git.exec(['branch', '-D', b.name]);
    }

    // Best-practice cleanup: offer to remove the remote counterpart, then prune stale refs.
    if (b.upstream && !b.upstreamGone) {
      const remote = b.upstream.split('/')[0];
      const remoteName = b.upstream.slice(remote.length + 1);
      const also = await vscode.window.showInformationMessage(
        `Also delete the remote branch ${b.upstream}?`,
        { modal: true },
        'Delete Remote Too'
      );
      if (also === 'Delete Remote Too') {
        await git.exec(['push', remote, '--delete', remoteName]);
      }
    }
    try {
      await git.exec(['remote', 'prune', 'origin']);
    } catch {
      // No remotes, or prune failed — branch deletion already succeeded.
    }
    tree.refresh();
  });

  register('goodBranchManager.pullBranch', async (node) => {
    const git = requireGit(tree);
    const b = node.branch;
    if (b.isRemote) return;
    if (!b.isCurrent) {
      vscode.window.showWarningMessage('Pull only runs on the checked-out branch. Checkout this branch first.');
      return;
    }
    if (!b.upstream || b.upstreamGone) {
      vscode.window.showWarningMessage(`${b.name} does not have an active upstream to pull from.`);
      return;
    }

    const option = await vscode.window.showQuickPick(
      [
        { label: 'Pull --rebase', args: ['pull', '--rebase'], description: 'Replay local commits on top of the upstream branch' },
        { label: 'Pull', args: ['pull'], description: 'Merge upstream changes into the current branch' },
        { label: 'Pull --ff-only', args: ['pull', '--ff-only'], description: 'Only update when a fast-forward is possible' }
      ],
      { placeHolder: `Pull updates for ${b.name} from ${b.upstream}` }
    );
    if (!option) return;
    await git.exec(option.args);
    tree.refresh();
    vscode.window.setStatusBarMessage(`${option.label} completed for ${b.name}`, 4000);
  });

  register('goodBranchManager.setUpstream', async (node) => {
    const git = requireGit(tree);
    const b = node.branch;
    if (b.isRemote) return;

    const remoteBranches = await git.getRemoteBranches();
    const custom = '$(edit) Enter upstream manually...';
    const picked = await vscode.window.showQuickPick(
      [
        ...remoteBranches.map((name) => ({
          label: name,
          description: name === b.upstream ? 'current upstream' : undefined
        })),
        { label: custom }
      ],
      { placeHolder: `Choose upstream for ${b.name}` }
    );
    if (!picked) return;

    let upstream = picked.label;
    if (upstream === custom) {
      const input = await vscode.window.showInputBox({
        prompt: `Upstream for ${b.name}`,
        placeHolder: 'origin/feature/my-change',
        value: b.upstream ?? `origin/${b.name}`,
        validateInput: (v) => !v.trim() || !v.includes('/') ? 'Use the form remote/branch.' : undefined
      });
      if (!input) return;
      upstream = input.trim();
    }

    await git.exec(['branch', '--set-upstream-to', upstream, b.name]);
    tree.refresh();
    vscode.window.setStatusBarMessage(`Set upstream for ${b.name} to ${upstream}`, 4000);
  });

  register('goodBranchManager.unsetUpstream', async (node) => {
    const git = requireGit(tree);
    const b = node.branch;
    if (b.isRemote) return;
    if (!b.upstream) {
      vscode.window.showInformationMessage(`${b.name} does not have an upstream.`);
      return;
    }
    const confirm = await vscode.window.showWarningMessage(
      `Remove upstream ${b.upstream} from ${b.name}?`,
      { modal: true },
      'Remove Upstream'
    );
    if (confirm !== 'Remove Upstream') return;
    await git.exec(['branch', '--unset-upstream', b.name]);
    tree.refresh();
  });

  register('goodBranchManager.setDefaultBranch', async (node) => {
    const branch = node.branch.isRemote ? node.branch.shortName : node.branch.name;
    await vscode.workspace.getConfiguration('goodBranchManager').update(
      'defaultBranch',
      branch,
      vscode.ConfigurationTarget.Workspace
    );
    tree.refresh();
    vscode.window.setStatusBarMessage(`Set default branch to ${branch}`, 4000);
  });

  register('goodBranchManager.clearDefaultBranch', async () => {
    await vscode.workspace.getConfiguration('goodBranchManager').update(
      'defaultBranch',
      undefined,
      vscode.ConfigurationTarget.Workspace
    );
    tree.refresh();
    vscode.window.setStatusBarMessage('Cleared configured default branch', 4000);
  });

  register('goodBranchManager.createPullRequest', async (node) => {
    const git = requireGit(tree);
    const info = tree.getRepoInfo();
    if (!info) return;
    const repo = await resolveGitHubRepo(git);
    if (!repo) {
      vscode.window.showWarningMessage('Creating a PR requires a GitHub "origin" remote.');
      return;
    }
    if (node.branch.name === info.defaultBranch) {
      vscode.window.showWarningMessage(
        `${node.branch.name} is the default branch — create a PR from a feature branch instead.`
      );
      return;
    }
    await openCreatePrPanel(git, repo, node.branch, info.defaultBranch, info.local, () => tree.refresh());
  });
}

function requireGit(tree: BranchTreeProvider): Git {
  const git = tree.getGit();
  if (!git) throw new Error('No git repository found in this workspace.');
  return git;
}

export function deactivate(): void { }
