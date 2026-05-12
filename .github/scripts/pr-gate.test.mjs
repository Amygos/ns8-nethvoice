import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hasCurrentLabel,
  isHeadCurrent,
  normalizeUpdateStrategy,
  runPrGate,
  shouldUpdateBranch,
  wasLabelEverApplied,
} from './pr-gate.mjs';

const baseEnv = {
  GITHUB_API_URL: 'https://api.github.test',
  GITHUB_EVENT_PATH: '/event.json',
  GITHUB_REPOSITORY: 'Amygos/ns8-nethvoice',
  GITHUB_TOKEN: 'token',
};

test('normalizes supported update strategies', () => {
  assert.equal(normalizeUpdateStrategy(undefined), 'merge');
  assert.equal(normalizeUpdateStrategy(' NONE '), 'none');
  assert.throws(
    () => normalizeUpdateStrategy('rebase'),
    /Invalid update strategy/
  );
});

test('classifies compare statuses', () => {
  assert.equal(isHeadCurrent('ahead'), true);
  assert.equal(isHeadCurrent('identical'), true);
  assert.equal(shouldUpdateBranch('behind'), true);
  assert.equal(shouldUpdateBranch('diverged'), true);
  assert.equal(shouldUpdateBranch('ahead'), false);
});

test('detects exact label history and current labels', () => {
  assert.equal(
    wasLabelEverApplied(
      [
        { event: 'labeled', label: { name: 'Testing' } },
        { event: 'labeled', label: { name: 'testing' } },
      ],
      'testing'
    ),
    true
  );
  assert.equal(
    wasLabelEverApplied([{ event: 'unlabeled', label: { name: 'testing' } }], 'testing'),
    false
  );
  assert.equal(hasCurrentLabel([{ name: 'verify' }], 'verify'), true);
});

test('fails when testing was applied and verify is missing', async () => {
  const { fetchImpl } = mockFetch([
    {
      key: 'GET /repos/Amygos/ns8-nethvoice/pulls/8',
      body: pullRequest({ labels: [] }),
    },
    {
      key: 'GET /repos/Amygos/ns8-nethvoice/compare/base...head',
      body: { status: 'ahead' },
    },
    {
      key: 'GET /repos/Amygos/ns8-nethvoice/issues/8/events?per_page=100&page=1',
      body: [{ event: 'labeled', label: { name: 'testing' } }],
    },
  ]);

  await assert.rejects(
    runPrGate({
      env: baseEnv,
      fetchImpl,
      readFile: eventFile(8),
      log: silentLog(),
    }),
    /must currently have the "verify" label/
  );
});

test('passes when testing was applied and verify is present', async () => {
  const { fetchImpl } = mockFetch([
    {
      key: 'GET /repos/Amygos/ns8-nethvoice/pulls/8',
      body: pullRequest({ labels: [{ name: 'verify' }] }),
    },
    {
      key: 'GET /repos/Amygos/ns8-nethvoice/compare/base...head',
      body: { status: 'identical' },
    },
    {
      key: 'GET /repos/Amygos/ns8-nethvoice/issues/8/events?per_page=100&page=1',
      body: [{ event: 'labeled', label: { name: 'testing' } }],
    },
  ]);

  const result = await runPrGate({
    env: baseEnv,
    fetchImpl,
    readFile: eventFile(8),
    log: silentLog(),
  });

  assert.deepEqual(result, { branchUpdated: false, labelGateChecked: true });
});

test('requests a merge update when the PR branch is behind', async () => {
  const requests = [];
  const { fetchImpl } = mockFetch(
    [
      {
        key: 'GET /repos/Amygos/ns8-nethvoice/pulls/8',
        body: pullRequest({ labels: [] }),
      },
      {
        key: 'GET /repos/Amygos/ns8-nethvoice/compare/base...head',
        body: { status: 'behind' },
      },
      {
        key: 'PUT /repos/Amygos/ns8-nethvoice/pulls/8/update-branch',
        status: 202,
        body: { message: 'Updating pull request branch.' },
      },
    ],
    requests
  );

  const result = await runPrGate({
    env: baseEnv,
    fetchImpl,
    readFile: eventFile(8),
    log: silentLog(),
  });

  assert.deepEqual(result, { branchUpdated: true, labelGateChecked: false });
  assert.deepEqual(requests[2].body, { expected_head_sha: 'head' });
});

test('fails instead of updating when strategy is none', async () => {
  const { fetchImpl } = mockFetch([
    {
      key: 'GET /repos/Amygos/ns8-nethvoice/pulls/8',
      body: pullRequest({ labels: [] }),
    },
    {
      key: 'GET /repos/Amygos/ns8-nethvoice/compare/base...head',
      body: { status: 'diverged' },
    },
  ]);

  await assert.rejects(
    runPrGate({
      env: { ...baseEnv, UPDATE_STRATEGY: 'none' },
      fetchImpl,
      readFile: eventFile(8),
      log: silentLog(),
    }),
    /automatic updates are disabled/
  );
});

function pullRequest({ labels }) {
  return {
    base: { ref: 'main', sha: 'base' },
    head: { sha: 'head' },
    labels,
  };
}

function eventFile(number) {
  return async () => JSON.stringify({ number, pull_request: { number } });
}

function silentLog() {
  return { log() {} };
}

function mockFetch(routes, requests = []) {
  return {
    requests,
    fetchImpl: async (url, options = {}) => {
      const parsedUrl = new URL(url);
      const method = options.method || 'GET';
      const key = `${method} ${parsedUrl.pathname}${parsedUrl.search}`;
      const route = routes.shift();

      assert.ok(route, `Unexpected request: ${key}`);
      assert.equal(key, route.key);

      const body = options.body ? JSON.parse(options.body) : undefined;
      requests.push({ key, body });

      return new Response(JSON.stringify(route.body), {
        status: route.status || 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  };
}
