import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker from '../../worker/access-gate.mjs';

test('placeholder Access configuration fails closed before reading assets', async () => {
  let assetCalls = 0;
  const response = await worker.fetch(new Request('https://tracker.synthetic.test/'), {
    ACCESS_TEAM_DOMAIN: 'https://__configure-access-team.example.invalid',
    ACCESS_AUD: '__configure_access_audience__',
    ACCESS_EMAIL: 'publisher@example.test',
    ASSETS: { fetch: async () => { assetCalls += 1; return new Response('unexpected'); } },
  });

  assert.equal(response.status, 503);
  assert.equal(await response.text(), 'Private viewer is not configured.\n');
  assert.equal(assetCalls, 0);
});
