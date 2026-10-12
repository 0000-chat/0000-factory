import assert from 'node:assert/strict';
import test from 'node:test';
import { reduceReceipts, validateReceipt } from '../scripts/factory-release-receipt.mjs';

const sha = '104a9ee32a61122895daddf71a14a6d022e8554e';
const manifest = {
  schemaVersion: 1,
  releaseId: 'factory-123-1',
  repository: 'https://github.com/0000-chat/0000-factory.git',
  branch: 'codex/weekly-planning-archive',
  commit: sha,
  consumers: [
    { repository: 'kapitolph/nextpay-team-delivery', branch: 'main', liveUrl: 'https://tracker.nextfinancial.xyz' },
    { repository: 'donmasakayan/nextpay-strategy', branch: 'main', liveUrl: 'https://tracker.nextpay.0000.gold' },
  ],
};

function receipt(repository, overrides = {}) {
  return {
    release_id: manifest.releaseId,
    consumer_repository: repository,
    factory_repository: manifest.repository,
    factory_branch: manifest.branch,
    factory_sha: sha,
    status: 'deployed',
    runtime_factory_sha: sha,
    live_status: 'verified',
    runtime_proof: {
      kind: 'public-provenance',
      status: 200,
      factory_sha: sha,
      url: `https://${repository.startsWith('kapitolph') ? 'tracker.nextfinancial.xyz' : 'tracker.nextpay.0000.gold'}/factory-provenance.json?release_id=${manifest.releaseId}`,
    },
    ...overrides,
  };
}

test('missing or pending consumer receipts never complete', () => {
  assert.deepEqual(reduceReceipts(manifest, [receipt('kapitolph/nextpay-team-delivery', { status: 'triggered', runtime_factory_sha: null, live_status: 'pending', deployment_version: null })]), {
    state: 'pending',
    repositories: ['kapitolph/nextpay-team-delivery'],
  });
  assert.equal(reduceReceipts(manifest, [receipt('kapitolph/nextpay-team-delivery', { status: 'failed' }), receipt('donmasakayan/nextpay-strategy')]).state, 'failed');
});

test('wrong release SHA, unknown consumer, and stale receipt are rejected', () => {
  assert.throws(() => validateReceipt(manifest, receipt('kapitolph/nextpay-team-delivery', { factory_sha: 'b23aac5428cb3ae82437070d3b5b8d4bc6422b42' })), /factory_sha/);
  assert.throws(() => validateReceipt(manifest, receipt('evil/example')), /not in the manifest/);
  assert.throws(() => validateReceipt(manifest, receipt('kapitolph/nextpay-team-delivery', { status: 'stale' })), /stale/);
});

test('both consumers with exact runtime proof complete the release', () => {
  const receipts = [receipt('kapitolph/nextpay-team-delivery'), receipt('donmasakayan/nextpay-strategy')];
  assert.deepEqual(reduceReceipts(manifest, receipts), {
    state: 'complete',
    repositories: ['kapitolph/nextpay-team-delivery', 'donmasakayan/nextpay-strategy'],
  });
  assert.deepEqual(reduceReceipts(manifest, receipts), reduceReceipts(manifest, receipts));
});
