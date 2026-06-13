import * as vscode from 'vscode';
import { Branch, Git, RepoInfo, findRepoRoot } from './git';
import { PullRequest, listPullRequests, resolveRemoteRepo } from './github';

type Node = GroupNode | BranchNode;

export class GroupNode {
  constructor(public readonly kind: 'local' | 'remote', public readonly branches: Branch[]) {}
}

export class BranchNode {
  constructor(public readonly branch: Branch, public readonly repo: RepoInfo) {}
}

export class BranchTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private repoInfo: RepoInfo | undefined;
  private git: Git | undefined;
  private prMap = new Map<string, PullRequest>();
  private lastFetchTime = 0;
  private fetchPromise: Promise<void> | null = null;
  private isForceRefresh = false;

  getPullRequest(branchName: string): PullRequest | undefined {
    return this.prMap.get(branchName);
  }

  refresh(): void {
    this.isForceRefresh = true;
    this._onDidChangeTreeData.fire();
  }

  getGit(): Git | undefined {
    return this.git;
  }

  getRepoInfo(): RepoInfo | undefined {
    return this.repoInfo;
  }

  async getChildren(element?: Node): Promise<Node[]> {
    if (element instanceof GroupNode) {
      return element.branches.map((b) => new BranchNode(b, this.repoInfo!));
    }
    if (element instanceof BranchNode) {
      return [];
    }

    const root = await findRepoRoot();
    if (!root) {
      this.git = undefined;
      this.repoInfo = undefined;
      this.prMap.clear();
      return [];
    }
    this.git = new Git(root);
    try {
      this.repoInfo = await this.git.getBranches();
    } catch (err) {
      console.error('goodBranchManager: failed to list branches', err);
      return [];
    }

    this.triggerPrFetch(this.git);

    const scope = vscode.workspace.getConfiguration('goodBranchManager').get<string>('branchScope', 'both');
    if (scope === 'local' || this.repoInfo.remote.length === 0) {
      return this.repoInfo.local.map((b) => new BranchNode(b, this.repoInfo!));
    }
    return [new GroupNode('local', this.repoInfo.local), new GroupNode('remote', this.repoInfo.remote)];
  }

  private async triggerPrFetch(git: Git): Promise<void> {
    const showPrStatus = vscode.workspace.getConfiguration('goodBranchManager').get<boolean>('showPrStatus', true);
    if (!showPrStatus) {
      return;
    }

    const now = Date.now();
    const throttleMs = 30000; // 30 seconds throttle
    if (!this.isForceRefresh && now - this.lastFetchTime < throttleMs) {
      return;
    }
    if (this.fetchPromise) {
      return;
    }

    this.isForceRefresh = false;

    this.fetchPromise = (async () => {
      try {
        let repo = await resolveRemoteRepo(git, 'origin');
        if (!repo || repo.provider !== 'github') {
          try {
            const remotesRaw = await git.exec(['remote']);
            const remotes = remotesRaw.split('\n').map(r => r.trim()).filter(Boolean);
            for (const remote of remotes) {
              if (remote === 'origin') continue;
              const r = await resolveRemoteRepo(git, remote);
              if (r && r.provider === 'github') {
                repo = r;
                break;
              }
            }
          } catch {
            // ignore
          }
        }

        if (repo && repo.provider === 'github') {
          const prs = await listPullRequests(repo);
          const newMap = new Map<string, PullRequest>();
          for (const pr of [...prs].reverse()) {
            newMap.set(pr.headRef, pr);
          }
          this.prMap = newMap;
          this.lastFetchTime = Date.now();
          this._onDidChangeTreeData.fire();
        }
      } catch (err) {
        console.error('goodBranchManager: failed to fetch PRs', err);
      } finally {
        this.fetchPromise = null;
      }
    })();
  }

  getTreeItem(element: Node): vscode.TreeItem {
    if (element instanceof GroupNode) {
      const item = new vscode.TreeItem(
        element.kind === 'local' ? 'Local' : 'Remote',
        element.kind === 'local'
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed
      );
      item.contextValue = `group-${element.kind}`;
      item.iconPath = new vscode.ThemeIcon(element.kind === 'local' ? 'device-desktop' : 'cloud');
      return item;
    }
    return this.branchItem(element);
  }

  private branchItem(node: BranchNode): vscode.TreeItem {
    const b = node.branch;
    const item = new vscode.TreeItem(b.isRemote ? b.shortName : b.name);
    item.id = (b.isRemote ? 'remote:' : 'local:') + b.name;

    const staleDays = vscode.workspace.getConfiguration('goodBranchManager').get<number>('staleAfterDays', 30);
    const ageDays = (Date.now() / 1000 - b.committerDateUnix) / 86400;
    const isStale = staleDays > 0 && ageDays > staleDays && !b.isCurrent;

    const showPrStatus = vscode.workspace.getConfiguration('goodBranchManager').get<boolean>('showPrStatus', true);
    const branchName = b.isRemote ? b.shortName : b.name;
    const pr = showPrStatus ? this.prMap.get(branchName) : undefined;

    const status = this.syncStatus(b);
    const hints: string[] = [status.text, b.committerDateRelative];
    if (!b.isRemote && b.name === node.repo.defaultBranch) hints.push('default');
    if (b.merged) hints.push('merged');
    if (isStale) hints.push('stale');

    if (pr) {
      if (pr.state === 'open') {
        hints.push(`PR #${pr.number}`);
      } else if (pr.mergedAt) {
        hints.push(`PR #${pr.number} (merged)`);
      } else {
        hints.push(`PR #${pr.number} (closed)`);
      }
    }

    item.description = hints.filter(Boolean).join(' · ');

    if (pr && !b.isCurrent) {
      if (pr.state === 'open') {
        item.iconPath = new vscode.ThemeIcon('git-pull-request', new vscode.ThemeColor('charts.green'));
      } else if (pr.mergedAt) {
        item.iconPath = new vscode.ThemeIcon('git-pull-request-merged', new vscode.ThemeColor('charts.purple'));
      } else {
        item.iconPath = new vscode.ThemeIcon('git-pull-request-closed', new vscode.ThemeColor('charts.red'));
      }
    } else {
      item.iconPath = new vscode.ThemeIcon(status.icon, status.color ? new vscode.ThemeColor(status.color) : undefined);
    }

    const lines = [
      `**${b.name}**`,
      '',
      `${status.tooltip}`,
      `Last commit: ${b.committerDateRelative} (\`${b.sha}\`)`
    ];
    if (b.upstream) lines.push(`Upstream: \`${b.upstream}\``);
    if (!b.isRemote && b.name === node.repo.defaultBranch) lines.push('Default branch.');
    if (b.merged) lines.push('Already merged into the default branch.');
    if (isStale) lines.push(`Stale: no commits in over ${staleDays} days.`);

    if (pr) {
      const prStatus = pr.state === 'open' ? 'open' : (pr.mergedAt ? 'merged' : 'closed');
      lines.push(`Pull Request: [#${pr.number} - ${pr.title}](${pr.htmlUrl}) (${prStatus})`);
    }

    item.tooltip = new vscode.MarkdownString(lines.join('\n\n'));
    item.tooltip.isTrusted = true;

    const ctx: string[] = ['branch'];
    ctx.push(b.isRemote ? 'remote' : 'local');
    if (b.upstream && !b.upstreamGone) ctx.push('upstream');
    if (b.isCurrent) ctx.push('current');
    if (!b.isRemote && b.name === node.repo.defaultBranch) ctx.push('default');
    if (pr) ctx.push('has-pr');
    item.contextValue = ctx.join('-');

    if (!b.isCurrent) {
      item.command = {
        command: 'goodBranchManager.checkout',
        title: 'Checkout Branch',
        arguments: [node]
      };
    }
    return item;
  }

  private syncStatus(b: Branch): { text: string; tooltip: string; icon: string; color?: string } {
    if (b.isRemote) {
      return { text: '', tooltip: 'Remote branch (not checked out locally).', icon: 'cloud' };
    }
    if (b.isCurrent) {
      const extra = this.aheadBehindText(b);
      return {
        text: ['current', extra].filter(Boolean).join(' '),
        tooltip: 'This is the checked-out branch.' + (extra ? ` (${extra})` : ''),
        icon: 'check',
        color: 'charts.green'
      };
    }
    if (!b.upstream) {
      return {
        text: 'local only',
        tooltip: 'Local only — never pushed to a remote.',
        icon: 'cloud-upload',
        color: 'charts.yellow'
      };
    }
    if (b.upstreamGone) {
      return {
        text: 'upstream gone',
        tooltip: 'The remote branch was deleted (likely merged). Safe to clean up.',
        icon: 'warning',
        color: 'charts.orange'
      };
    }
    if (b.ahead === 0 && b.behind === 0) {
      return { text: 'synced', tooltip: 'In sync with its remote.', icon: 'cloud', color: 'charts.blue' };
    }
    const text = this.aheadBehindText(b);
    return {
      text,
      tooltip: `Out of sync with ${b.upstream}: ${text}.`,
      icon: b.ahead > 0 ? 'arrow-up' : 'arrow-down',
      color: 'charts.purple'
    };
  }

  private aheadBehindText(b: Branch): string {
    const parts: string[] = [];
    if (b.ahead > 0) parts.push(`${b.ahead}↑`);
    if (b.behind > 0) parts.push(`${b.behind}↓`);
    return parts.join(' ');
  }
}
