import * as vscode from 'vscode';
import { Branch, Git, GitError, RepoInfo } from './git';
import { branchUrl, resolveGitHubRepo, resolveRemoteRepo } from './github';
import { openCreatePrPanel } from './prPanel';
import { BranchNode, BranchTreeProvider } from './tree';

const BRANCH_NAME_RE = /^(?!\/|.*(?:\/\.|\/\/|\.\.|@\{|\\))[^\x00-\x20~^:?*[\]]+(?<!\.lock)(?<!\/)(?<!\.)$/;
const PUBLISH_PROMPT_SETTING = 'goodBranchManager.promptForPrOnPublish';

interface BranchSnapshot {
  upstream?: string;
  upstreamGone: boolean;
}

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
  const publishPromptTimers = new Map<string, NodeJS.Timeout>();
  const branchSnapshots = new Map<string, Map<string, BranchSnapshot>>();
  const suppressedPublishPrompts = new Set<string>();
  const scheduleRefresh = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => tree.refresh(), 400);
  };
  const schedulePublishPromptCheck = (repoRoot: string | undefined) => {
    if (!repoRoot) return;
    const existing = publishPromptTimers.get(repoRoot);
    if (existing) clearTimeout(existing);
    const next = setTimeout(() => {
      publishPromptTimers.delete(repoRoot);
      void checkForPublishedBranch(context, tree, repoRoot, branchSnapshots, suppressedPublishPrompts);
    }, 1000);
    publishPromptTimers.set(repoRoot, next);
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
      for (const promptTimer of publishPromptTimers.values()) {
        clearTimeout(promptTimer);
      }
    }
  });
  const gitExt = vscode.extensions.getExtension('vscode.git');
  if (gitExt) {
    const api = (await gitExt.activate()).getAPI(1);
    const hook = (repo: any) => {
      const repoRoot = repo?.rootUri?.fsPath as string | undefined;
      schedulePublishPromptCheck(repoRoot);
      context.subscriptions.push(repo.state.onDidChange(() => {
        scheduleRefresh();
        schedulePublishPromptCheck(repoRoot);
      }));
    };
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
        { label: 'Pull (Default)', args: ['pull'], description: 'Run pull using configured git default (merge or rebase)' },
        { label: 'Pull --rebase', args: ['pull', '--rebase'], description: 'Replay local commits on top of the upstream branch' },
        { label: 'Pull --no-rebase', args: ['pull', '--no-rebase'], description: 'Explicitly merge upstream changes, creating a merge commit' },
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
    suppressPublishPrompt(suppressedPublishPrompts, git.repoRoot, b.name, upstream);
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

  register('goodBranchManager.createPullRequest', async (node) => {
    const git = requireGit(tree);
    const info = tree.getRepoInfo();
    if (!info) return;
    await openCreatePullRequestPanel(git, info, node.branch, () => tree.refresh(), {
      onPublished: (upstream) => suppressPublishPrompt(suppressedPublishPrompts, git.repoRoot, node.branch.name, upstream)
    });
  });

  register('goodBranchManager.openPullRequest', async (node) => {
    const b = node.branch;
    const branchName = b.isRemote ? b.shortName : b.name;
    const pr = tree.getPullRequest(branchName);
    if (pr) {
      await vscode.env.openExternal(vscode.Uri.parse(pr.htmlUrl));
    } else {
      vscode.window.showWarningMessage(`No pull request found for branch ${b.name}.`);
    }
  });
}

function requireGit(tree: BranchTreeProvider): Git {
  const git = tree.getGit();
  if (!git) throw new Error('No git repository found in this workspace.');
  return git;
}

async function checkForPublishedBranch(
  context: vscode.ExtensionContext,
  tree: BranchTreeProvider,
  repoRoot: string,
  snapshots: Map<string, Map<string, BranchSnapshot>>,
  suppressedPrompts: Set<string>
): Promise<void> {
  const git = new Git(repoRoot);
  let info: RepoInfo;
  try {
    info = await git.getBranches();
  } catch (err) {
    console.error('goodBranchManager: failed to inspect branches for publish prompt', err);
    return;
  }

  const previous = snapshots.get(repoRoot);
  const next = snapshotBranches(info.local);
  snapshots.set(repoRoot, next);
  if (!previous) return;

  const enabled = vscode.workspace.getConfiguration('goodBranchManager').get<boolean>('promptForPrOnPublish', true);
  if (!enabled) return;

  const branch = info.local.find((b) => b.isCurrent);
  if (!branch || branch.name === info.defaultBranch || !branch.upstream || branch.upstreamGone) return;

  const before = previous.get(branch.name);
  if (!before || before.upstream || before.upstreamGone) return;
  if (tree.getRepoInfo()?.root === repoRoot && tree.getPullRequest(branch.name)) return;

  const remote = getBranchRemote(branch);
  const repo = await resolveGitHubRepo(git, remote);
  if (!repo) return;

  const transitionKey = publishPromptKey(repoRoot, branch.name, branch.upstream);
  if (suppressedPrompts.delete(transitionKey)) return;

  const promptKey = `goodBranchManager.prPrompt.${transitionKey}`;
  if (context.workspaceState.get<boolean>(promptKey)) return;
  await context.workspaceState.update(promptKey, true);

  const create = 'Create PR';
  const notNow = 'Not Now';
  const dontAsk = "Don't Ask Again";
  const picked = await vscode.window.showInformationMessage(
    `Branch ${branch.name} was published to ${branch.upstream}. Create a pull request?`,
    create,
    notNow,
    dontAsk
  );

  if (picked === dontAsk) {
    await vscode.workspace.getConfiguration('goodBranchManager').update(PUBLISH_PROMPT_SETTING, false, vscode.ConfigurationTarget.Global);
    return;
  }
  if (picked === create) {
    await openCreatePullRequestPanel(git, info, branch, () => tree.refresh(), { remote });
  }
}

function snapshotBranches(branches: Branch[]): Map<string, BranchSnapshot> {
  return new Map(
    branches.map((branch) => [
      branch.name,
      {
        upstream: branch.upstream,
        upstreamGone: branch.upstreamGone
      }
    ])
  );
}

async function openCreatePullRequestPanel(
  git: Git,
  info: Pick<RepoInfo, 'defaultBranch' | 'local'>,
  branch: Branch,
  onCreated: () => void,
  options: {
    remote?: string;
    onPublished?: (upstream: string) => void | Promise<void>;
  } = {}
): Promise<void> {
  const remote = options.remote ?? getBranchRemote(branch);
  const repo = await resolveGitHubRepo(git, remote);
  if (!repo) {
    vscode.window.showWarningMessage(`Creating a PR requires a GitHub "${remote}" remote.`);
    return;
  }
  if (branch.name === info.defaultBranch) {
    vscode.window.showWarningMessage(
      `${branch.name} is the default branch — create a PR from a feature branch instead.`
    );
    return;
  }
  await openCreatePrPanel(git, repo, branch, info.defaultBranch, info.local, onCreated, remote, options.onPublished);
}

function getBranchRemote(branch: Branch): string {
  if (branch.upstream) {
    return branch.upstream.split('/')[0];
  }
  return branch.remote ?? 'origin';
}

function suppressPublishPrompt(
  suppressedPrompts: Set<string>,
  repoRoot: string,
  branchName: string,
  upstream: string
): void {
  suppressedPrompts.add(publishPromptKey(repoRoot, branchName, upstream));
}

function publishPromptKey(repoRoot: string, branchName: string, upstream: string): string {
  return `${repoRoot}:${branchName}:${upstream}`;
}

export function deactivate(): void { }
