const FULL_SHA = /^[0-9a-f]{40}$/u;
const RELEASE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function fail(message) {
  throw new Error(`Factory release receipt: ${message}`);
}

export function validateManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== 1) fail('manifest schemaVersion must be 1');
  if (!RELEASE_ID.test(manifest.releaseId ?? '')) fail('manifest releaseId is invalid');
  if (manifest.repository !== 'https://github.com/0000-chat/0000-factory.git') fail('manifest repository is invalid');
  if (manifest.branch !== 'codex/weekly-planning-archive') fail('manifest branch is invalid');
  if (!FULL_SHA.test(manifest.commit ?? '')) fail('manifest commit must be a full SHA');
  if (!Array.isArray(manifest.consumers) || manifest.consumers.length !== 2) fail('manifest must name exactly two consumers');
  const repositories = manifest.consumers.map((consumer) => consumer?.repository);
  if (new Set(repositories).size !== repositories.length) fail('manifest consumers must be unique');
  for (const consumer of manifest.consumers) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(consumer?.repository ?? '')) fail('manifest consumer repository is invalid');
    if (consumer.branch !== 'main') fail('manifest consumer branch must be main');
    if (!/^https:\/\//u.test(consumer.liveUrl ?? '')) fail('manifest consumer liveUrl must be HTTPS');
  }
  return manifest;
}

function consumerFor(manifest, repository) {
  return manifest.consumers.find((consumer) => consumer.repository === repository) ?? null;
}

function runtimeProofFor(manifest, receipt, consumer) {
  const proof = receipt.runtime_proof;
  if (!proof || proof.kind !== 'public-provenance' || proof.status !== 200) return false;
  if (proof.factory_sha !== manifest.commit) return false;
  try {
    const expected = new URL('/factory-provenance.json', consumer.liveUrl);
    const observed = new URL(String(proof.url ?? ''));
    return observed.origin === expected.origin
      && observed.pathname === expected.pathname
      && observed.search.length > 0;
  } catch {
    return false;
  }
}

export function validateReceipt(manifest, receipt) {
  validateManifest(manifest);
  if (!receipt || receipt.release_id !== manifest.releaseId) fail('receipt release_id does not match the current manifest');
  const repository = receipt.consumer_repository;
  if (!consumerFor(manifest, repository)) fail(`receipt consumer is not in the manifest: ${repository}`);
  if (receipt.factory_sha !== manifest.commit) fail('receipt factory_sha does not match the current manifest commit');
  if (receipt.factory_repository !== manifest.repository || receipt.factory_branch !== manifest.branch) fail('receipt Factory source does not match the manifest');
  if (receipt.status === 'stale') fail('stale receipt cannot complete a release');
  if (receipt.status === 'failed') return { repository, state: 'failed' };
  if (receipt.status !== 'triggered' && receipt.status !== 'deployed') fail('receipt status must be triggered, deployed, or failed');
  if (receipt.status === 'triggered') return { repository, state: 'pending' };
  if (receipt.runtime_factory_sha !== manifest.commit) fail('deployed receipt runtime SHA does not match the manifest');
  if (receipt.live_status !== 'verified') fail('deployed receipt live status is not verified');
  const consumer = consumerFor(manifest, repository);
  if (!runtimeProofFor(manifest, receipt, consumer)) fail('deployed receipt is missing authenticated public provenance proof');
  return { repository, state: 'deployed' };
}

export function reduceReceipts(manifest, receipts) {
  validateManifest(manifest);
  if (!Array.isArray(receipts)) fail('receipts must be an array');
  const byRepository = new Map();
  for (const receipt of receipts) {
    const result = validateReceipt(manifest, receipt);
    if (byRepository.has(result.repository)) {
      const previous = byRepository.get(result.repository);
      if (previous.state !== result.state) fail(`conflicting receipts for ${result.repository}`);
    }
    byRepository.set(result.repository, result);
  }
  const expected = manifest.consumers.map((consumer) => consumer.repository);
  if (expected.some((repository) => !byRepository.has(repository))) return { state: 'pending', repositories: [...byRepository.keys()] };
  const states = expected.map((repository) => byRepository.get(repository).state);
  if (states.some((state) => state === 'failed')) return { state: 'failed', repositories: expected };
  if (states.every((state) => state === 'deployed')) return { state: 'complete', repositories: expected };
  return { state: 'pending', repositories: expected };
}
