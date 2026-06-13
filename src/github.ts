import * as vscode from 'vscode';
import { Git, RemoteRepo } from './git';

export type { RemoteRepo };

export async function resolveRemoteRepo(git: Git, remote = 'origin'): Promise<RemoteRepo | undefined> {
  const url = await git.getRemoteUrl(remote);
  return url ? Git.parseRemoteUrl(url) : undefined;
}

/** Legacy alias kept for the PR creation flow, which is GitHub-only. */
export async function resolveGitHubRepo(git: Git, remote = 'origin'): Promise<RemoteRepo | undefined> {
  const repo = await resolveRemoteRepo(git, remote);
  return repo?.provider === 'github' ? repo : undefined;
}

export async function getGitHubSession(createIfNone: boolean): Promise<vscode.AuthenticationSession | undefined> {
  return vscode.authentication.getSession('github', ['repo'], { createIfNone });
}

export interface CreatePrInput {
  title: string;
  body: string;
  base: string;
  head: string;
  draft: boolean;
}

export interface CreatedPr {
  htmlUrl: string;
  number: number;
}

export async function createPullRequest(repo: RemoteRepo, input: CreatePrInput): Promise<CreatedPr> {
  const session = await getGitHubSession(true);
  if (!session) {
    throw new Error('GitHub sign-in is required to create a pull request.');
  }
  const res = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.repo}/pulls`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    body: JSON.stringify({
      title: input.title,
      body: input.body,
      base: input.base,
      head: input.head,
      draft: input.draft
    })
  });
  if (!res.ok) {
    const detail = await res.text();
    let message = `GitHub API error ${res.status}`;
    try {
      const parsed = JSON.parse(detail);
      const errors = (parsed.errors ?? []).map((e: any) => e.message ?? JSON.stringify(e)).join('; ');
      message = [parsed.message, errors].filter(Boolean).join(' — ');
    } catch {
      // keep generic message
    }
    throw new Error(message);
  }
  const json: any = await res.json();
  return { htmlUrl: json.html_url, number: json.number };
}

/**
 * Constructs the browser URL for a specific branch, routing by provider.
 * Returns undefined only for Azure DevOps HTTPS remotes where the org cannot be determined
 * (practically, always returns a string for the four named providers + generic fallback).
 */
export function branchUrl(repo: RemoteRepo, branch: string): string {
  const enc = encodeURIComponent(branch);
  const base = `https://${repo.host}`;

  switch (repo.provider) {
    case 'github':
      return `${base}/${repo.owner}/${repo.repo}/tree/${enc}`;

    case 'gitlab':
      // GitLab uses /-/tree/ and supports nested namespace owners (group/subgroup).
      return `${base}/${repo.owner}/${repo.repo}/-/tree/${enc}`;

    case 'bitbucket':
      return `${base}/${repo.owner}/${repo.repo}/src/${enc}`;

    case 'azure': {
      // Azure DevOps HTTPS: dev.azure.com/org/project/_git/repo
      // SSH remote was normalised to "org/project/repo" during parsing,
      // so owner = "org/project" and repo = "repo".
      const parts = repo.owner.split('/');
      const org = parts[0];
      const project = parts.slice(1).join('/') || repo.repo;
      return `https://dev.azure.com/${org}/${project}/_git/${repo.repo}?version=GB${enc}`;
    }

    default:
      // Generic self-hosted (Gitea, Forgejo, Gogs, etc.) all use the GitHub-style path.
      return `${base}/${repo.owner}/${repo.repo}/src/branch/${enc}`;
  }
}

export function commitUrl(repo: RemoteRepo, sha: string): string {
  const enc = encodeURIComponent(sha);
  const base = `https://${repo.host}`;

  switch (repo.provider) {
    case 'github':
      return `${base}/${repo.owner}/${repo.repo}/commit/${enc}`;

    case 'gitlab':
      return `${base}/${repo.owner}/${repo.repo}/-/commit/${enc}`;

    case 'bitbucket':
      return `${base}/${repo.owner}/${repo.repo}/commits/${enc}`;

    case 'azure': {
      const parts = repo.owner.split('/');
      const org = parts[0];
      const project = parts.slice(1).join('/') || repo.repo;
      return `https://dev.azure.com/${org}/${project}/_git/${repo.repo}/commit/${enc}`;
    }

    default:
      return `${base}/${repo.owner}/${repo.repo}/commit/${enc}`;
  }
}

export interface PullRequest {
  number: number;
  title: string;
  state: 'open' | 'closed';
  mergedAt: string | null;
  htmlUrl: string;
  headRef: string;
}

export async function listPullRequests(repo: RemoteRepo): Promise<PullRequest[]> {
  const session = await getGitHubSession(false);
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
  if (session) {
    headers['Authorization'] = `Bearer ${session.accessToken}`;
  }

  const res = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.repo}/pulls?state=all&per_page=100`, {
    headers
  });

  if (!res.ok) {
    throw new Error(`GitHub API error ${res.status}: ${await res.text()}`);
  }

  const json = await res.json() as any[];
  return json.map((pr: any) => ({
    number: pr.number,
    title: pr.title ?? '',
    state: pr.state,
    mergedAt: pr.merged_at || null,
    htmlUrl: pr.html_url,
    headRef: pr.head.ref
  }));
}
