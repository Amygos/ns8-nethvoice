#!/usr/bin/env node
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const SUPPORTED_UPDATE_STRATEGIES = new Set(['merge', 'none']);
const CURRENT_STATUSES = new Set(['ahead', 'identical']);
const UPDATE_STATUSES = new Set(['behind', 'diverged']);

export function normalizeUpdateStrategy(value) {
  const strategy = (value || 'merge').trim().toLowerCase();

  if (!SUPPORTED_UPDATE_STRATEGIES.has(strategy)) {
    throw new Error(
      `Invalid update strategy "${value}". Supported values: ${[
        ...SUPPORTED_UPDATE_STRATEGIES,
      ].join(', ')}.`
    );
  }

  return strategy;
}

export function isHeadCurrent(compareStatus) {
  return CURRENT_STATUSES.has(compareStatus);
}

export function shouldUpdateBranch(compareStatus) {
  return UPDATE_STATUSES.has(compareStatus);
}

export function wasLabelEverApplied(events, labelName) {
  return events.some(
    (event) => event.event === 'labeled' && event.label?.name === labelName
  );
}

export function hasCurrentLabel(labels, labelName) {
  return labels.some((label) => label.name === labelName);
}

export function parseRepository(repository) {
  const parts = repository?.split('/') || [];

  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid GITHUB_REPOSITORY value "${repository}".`);
  }

  return { owner: parts[0], repo: parts[1] };
}

export function getPullRequestNumber(event) {
  const number = event?.pull_request?.number || event?.number;

  if (!event?.pull_request || !number) {
    throw new Error('This workflow must run for a pull request event.');
  }

  return number;
}

class GitHubApi {
  constructor({ apiUrl, fetchImpl, owner, repo, token }) {
    if (!fetchImpl) {
      throw new Error('A fetch implementation is required.');
    }

    this.apiUrl = apiUrl.replace(/\/$/, '');
    this.fetch = fetchImpl;
    this.owner = owner;
    this.repo = repo;
    this.token = token;
  }

  repoPath() {
    return `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(
      this.repo
    )}`;
  }

  async request(method, path, { body, expectedStatuses = [200] } = {}) {
    const response = await this.fetch(`${this.apiUrl}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
        'user-agent': 'ns8-nethvoice-pr-gate',
        'x-github-api-version': '2022-11-28',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const text = await response.text();
    const payload = parseJsonResponse(text);

    if (!expectedStatuses.includes(response.status)) {
      throw new Error(formatApiError(method, path, response.status, payload));
    }

    return payload;
  }

  async getPullRequest(number) {
    return this.request('GET', `${this.repoPath()}/pulls/${number}`);
  }

  async getBranch(branchName) {
    return this.request(
      'GET',
      `${this.repoPath()}/branches/${encodeURIComponent(branchName)}`
    );
  }

  async compare(baseSha, headSha) {
    return this.request(
      'GET',
      `${this.repoPath()}/compare/${baseSha}...${headSha}`
    );
  }

  async updateBranch(number, expectedHeadSha) {
    return this.request('PUT', `${this.repoPath()}/pulls/${number}/update-branch`, {
      body: { expected_head_sha: expectedHeadSha },
      expectedStatuses: [202],
    });
  }

  async listIssueEvents(number) {
    const events = [];

    for (let page = 1; ; page += 1) {
      const batch = await this.request(
        'GET',
        `${this.repoPath()}/issues/${number}/events?per_page=100&page=${page}`
      );

      events.push(...batch);

      if (batch.length < 100) {
        return events;
      }
    }
  }
}

function parseJsonResponse(text) {
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function formatApiError(method, path, status, payload) {
  const message =
    payload && typeof payload === 'object' && 'message' in payload
      ? payload.message
      : payload;

  return `${method} ${path} failed with HTTP ${status}${
    message ? `: ${message}` : ''
  }`;
}

function requireEnv(env, name) {
  if (!env[name]) {
    throw new Error(`${name} is required.`);
  }

  return env[name];
}

export async function runPrGate({
  env = process.env,
  fetchImpl = globalThis.fetch,
  readFile = fs.readFile,
  log = console,
} = {}) {
  const token = requireEnv(env, 'GITHUB_TOKEN');
  const eventPath = requireEnv(env, 'GITHUB_EVENT_PATH');
  const { owner, repo } = parseRepository(requireEnv(env, 'GITHUB_REPOSITORY'));
  const updateStrategy = normalizeUpdateStrategy(env.UPDATE_STRATEGY || 'merge');
  const event = JSON.parse(await readFile(eventPath, 'utf8'));
  const pullRequestNumber = getPullRequestNumber(event);
  const github = new GitHubApi({
    apiUrl: env.GITHUB_API_URL || 'https://api.github.com',
    fetchImpl,
    owner,
    repo,
    token,
  });

  const pullRequest = await github.getPullRequest(pullRequestNumber);
  const baseBranch = await github.getBranch(pullRequest.base.ref);
  const comparison = await github.compare(
    baseBranch.commit.sha,
    pullRequest.head.sha
  );

  if (isHeadCurrent(comparison.status)) {
    log.log(
      `PR #${pullRequestNumber} is ${comparison.status} relative to ${pullRequest.base.ref}.`
    );
  } else if (shouldUpdateBranch(comparison.status)) {
    if (updateStrategy === 'none') {
      throw new Error(
        `PR #${pullRequestNumber} is ${comparison.status} relative to ${pullRequest.base.ref}, and automatic updates are disabled.`
      );
    }

    log.log(
      `PR #${pullRequestNumber} is ${comparison.status}; requesting a ${updateStrategy} update with ${pullRequest.base.ref}.`
    );
    await github.updateBranch(pullRequestNumber, pullRequest.head.sha);
    log.log(
      `Requested branch update for PR #${pullRequestNumber}. The synchronize run will validate the updated head.`
    );
    return { branchUpdated: true, labelGateChecked: false };
  } else {
    throw new Error(
      `Unexpected compare status "${comparison.status}" for PR #${pullRequestNumber}.`
    );
  }

  const events = await github.listIssueEvents(pullRequestNumber);
  const testingWasApplied = wasLabelEverApplied(events, 'testing');
  const verifyIsPresent = hasCurrentLabel(pullRequest.labels || [], 'verify');

  if (testingWasApplied && !verifyIsPresent) {
    throw new Error(
      'The "testing" label was applied to this PR before, so the PR must currently have the "verify" label.'
    );
  }

  log.log(
    testingWasApplied
      ? 'Label gate passed: "testing" was applied before and "verify" is present.'
      : 'Label gate passed: "testing" was never applied.'
  );

  return { branchUpdated: false, labelGateChecked: true };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runPrGate().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
