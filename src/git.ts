import { execFile } from 'child_process';
import * as vscode from 'vscode';

export type GitProvider = 'github' | 'gitlab' | 'bitbucket' | 'azure' | 'generic';

export interface RemoteRepo {
  host: string;
  owner: string;
  repo: string;
  provider: GitProvider;
}

function detectProvider(host: string, path: string): GitProvider {
  const h = host.toLowerCase();
  if (h === 'github.com' || h.endsWith('.github.com')) return 'github';
  if (h === 'gitlab.com' || h.includes('gitlab')) return 'gitlab';
  if (h === 'bitbucket.org') return 'bitbucket';
  if (h === 'dev.azure.com' || h === 'ssh.dev.azure.com' || h.endsWith('.visualstudio.com')) return 'azure';
  // Azure DevOps HTTPS path pattern: org/project/_git/repo
  if (path.includes('/_git/')) return 'azure';
  return 'generic';
}

export interface Branch {
  name: string;
  /** Short name without the remote prefix, e.g. "feature/x" for "origin/feature/x". */
  shortName: string;
  isRemote: boolean;
  remote?: string;
  upstream?: string;
  upstreamGone: boolean;
  ahead: number;
  behind: number;
  isCurrent: boolean;
  committerDateUnix: number;
  committerDateRelative: string;
  sha: string;
  merged: boolean;
}

export interface RepoInfo {
  root: string;
  headBranch?: string;
  defaultBranch: string;
  local: Branch[];
  remote: Branch[];
}

export class GitError extends Error {
  constructor(message: string, public readonly stderr: string) {
    super(message);
  }
}

const NUL = String.fromCharCode(0);

export class Git {
  constructor(public readonly repoRoot: string) {}

  exec(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        'git',
        args,
        { cwd: this.repoRoot, maxBuffer: 10 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) {
            reject(new GitError(stderr.trim() || error.message, stderr.trim()));
          } else {
            resolve(stdout.trimEnd());
          }
        }
      );
    });
  }

  private async tryExec(args: string[]): Promise<string | undefined> {
    try {
      return await this.exec(args);
    } catch {
      return undefined;
    }
  }

  async getDefaultBranch(): Promise<string> {
    const configured = vscode.workspace.getConfiguration('goodBranchManager').get<string>('defaultBranch', '').trim();
    if (configured) return configured;

    const headRef = await this.tryExec(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    if (headRef) {
      return headRef.replace(/^origin\//, '');
    }
    for (const candidate of ['main', 'master']) {
      if (await this.tryExec(['show-ref', '--verify', `refs/heads/${candidate}`])) {
        return candidate;
      }
    }
    return (await this.tryExec(['symbolic-ref', '--short', 'HEAD'])) ?? 'main';
  }

  async getBranches(): Promise<RepoInfo> {
    // %00 makes git emit a NUL separator, which can never appear in ref names.
    const format = [
      '%(refname:short)',
      '%(upstream:short)',
      '%(upstream:track)',
      '%(committerdate:unix)',
      '%(committerdate:relative)',
      '%(HEAD)',
      '%(objectname:short)'
    ].join('%00');

    const defaultBranch = await this.getDefaultBranch();
    const [localRaw, remoteRaw, mergedRaw] = await Promise.all([
      this.exec(['for-each-ref', 'refs/heads', `--format=${format}`, '--sort=-committerdate']),
      this.tryExec(['for-each-ref', 'refs/remotes', `--format=${format}`, '--sort=-committerdate']),
      this.tryExec(['for-each-ref', 'refs/heads', '--format=%(refname:short)', '--merged', defaultBranch])
    ]);

    const merged = new Set((mergedRaw ?? '').split('\n').filter(Boolean));
    const parse = (raw: string, isRemote: boolean): Branch[] =>
      raw
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [name, upstream, track, dateUnix, dateRel, head, sha] = line.split(NUL);
          const ahead = Number(/ahead (\d+)/.exec(track ?? '')?.[1] ?? 0);
          const behind = Number(/behind (\d+)/.exec(track ?? '')?.[1] ?? 0);
          const remote = isRemote ? name.split('/')[0] : undefined;
          return {
            name,
            shortName: isRemote ? name.slice(remote!.length + 1) : name,
            isRemote,
            remote,
            upstream: upstream || undefined,
            upstreamGone: (track ?? '').includes('gone'),
            ahead,
            behind,
            isCurrent: head === '*',
            committerDateUnix: Number(dateUnix),
            committerDateRelative: dateRel,
            sha,
            merged: merged.has(name) && name !== defaultBranch
          };
        });

    const local = parse(localRaw, false);
    const localUpstreams = new Set(local.map((b) => b.upstream).filter(Boolean));
    const remote = parse(remoteRaw ?? '', true).filter(
      // Skip symbolic refs like origin/HEAD and remote branches already tracked locally.
      (b) => b.shortName !== 'HEAD' && !localUpstreams.has(b.name)
    );

    const headBranch = local.find((b) => b.isCurrent)?.name;
    return { root: this.repoRoot, headBranch, defaultBranch, local, remote };
  }

  async getRemoteUrl(remote = 'origin'): Promise<string | undefined> {
    return this.tryExec(['remote', 'get-url', remote]);
  }

  async getRemoteBranches(): Promise<string[]> {
    const raw = await this.tryExec(['for-each-ref', 'refs/remotes', '--format=%(refname:short)', '--sort=refname']);
    return (raw ?? '').split('\n').filter((name) => name && !name.endsWith('/HEAD'));
  }

  /** Parses any common git hosting remote URL into its parts. Returns undefined only for
   *  completely unrecognised local or non-HTTP/SSH schemes. */
  static parseRemoteUrl(url: string): RemoteRepo | undefined {
    const s = url.trim();
    let host: string, path: string;

    // SCP-style SSH: git@host:path/to/repo.git  (Azure SSH has no @: ssh.dev.azure.com:v3/...)
    const scpMatch = /^(?:[^@\s]+@)?([A-Za-z0-9._-]+):([^:].+?)(?:\.git)?\/?$/.exec(s);
    // HTTPS / git+https: https://[user@]host/path.git
    const httpsMatch = /^(?:https?|git):\/\/(?:[^@/\s]+@)?([A-Za-z0-9._-]+)\/(.+?)(?:\.git)?\/?$/.exec(s);

    if (scpMatch) {
      [, host, path] = scpMatch;
    } else if (httpsMatch) {
      [, host, path] = httpsMatch;
    } else {
      return undefined;
    }

    const provider = detectProvider(host, path);

    // Azure DevOps SSH: ssh.dev.azure.com:v3/org/project/repo → strip the "v3/" prefix
    if (provider === 'azure' && path.startsWith('v3/')) {
      path = path.slice(3);
    }

    const parts = path.split('/').filter(Boolean);
    if (parts.length < 2) return undefined;

    const repo = parts[parts.length - 1];
    const owner = parts.slice(0, -1).join('/');
    return { host, owner, repo, provider };
  }

  /** @deprecated Use parseRemoteUrl instead. */
  static parseGitHubRemote(url: string): { owner: string; repo: string } | undefined {
    const r = Git.parseRemoteUrl(url);
    return r && r.provider === 'github' ? { owner: r.owner, repo: r.repo } : undefined;
  }

  async getLastCommitSubject(ref: string): Promise<string | undefined> {
    return this.tryExec(['log', '-1', '--pretty=%s', ref]);
  }

  async getCommitSummaries(base: string, head: string, limit = 20): Promise<string[]> {
    const out = await this.tryExec(['log', `${base}..${head}`, '--pretty=%s', `-${limit}`]);
    return (out ?? '').split('\n').filter(Boolean);
  }
}

/** Resolves the repository root for the first workspace folder using the built-in git extension. */
export async function findRepoRoot(): Promise<string | undefined> {
  const gitExt = vscode.extensions.getExtension('vscode.git');
  if (gitExt) {
    const api = (await gitExt.activate()).getAPI(1);
    if (api.repositories.length > 0) {
      return api.repositories[0].rootUri.fsPath;
    }
  }
  return undefined;
}
