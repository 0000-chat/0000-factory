import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'bun:test';
import { createDevHandler } from '../tooling/dev.mjs';

const outputRoots = [];

function devServer() {
  const output = mkdtempSync(join(tmpdir(), 'tracker-viewer-dev-'));
  outputRoots.push(output);
  mkdirSync(join(output, 'assets'));
  writeFileSync(join(output, 'assets', 'index.html'), '<main>tracker shell</main>');
  writeFileSync(join(output, 'assets', 'app.js'), 'console.log("asset");');
  writeFileSync(join(output, 'assets', 'site.css'), 'body { color: black; }');
  writeFileSync(join(output, 'runtime-config.mjs'), 'export const privatePolicy = true;');
  writeFileSync(join(output, 'build-manifest.json'), '{"private":true}\n');
  mkdirSync(join(output, 'private-inputs'));
  writeFileSync(join(output, 'private-inputs', 'sentinel.txt'), 'private\n');
  symlinkSync(join(output, 'private-inputs'), join(output, 'assets', 'private'), 'dir');
  const subscribers = new Set();
  return { handler: createDevHandler({ output, subscribers }), subscribers };
}

function request(handler, path, { method = 'GET', headers = {} } = {}) {
  return handler(new Request(`http://127.0.0.1${path}`, { method, headers }));
}

afterEach(() => {
  for (const path of outputRoots.splice(0)) rmSync(path, { recursive: true, force: true });
});

test('existing assets are served from their original path', async () => {
  const { handler } = devServer();
  const response = await request(handler, '/app.js', { headers: { Accept: 'text/html' } });

  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'console.log("asset");');
  assert.equal(response.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal(response.headers.get('cache-control'), 'no-cache');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
});

test('extensionless HTML navigation falls back to the root document', async () => {
  const { handler } = devServer();
  const response = await request(handler, '/work/id', { headers: { Accept: 'text/html' } });

  assert.equal(response.status, 200);
  assert.equal(await response.text(), '<main>tracker shell</main>');
  assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
});

test('wildcard Accept allows an HTML route fallback', async () => {
  const { handler } = devServer();
  const response = await request(handler, '/work/id', { headers: { Accept: '*/*' } });

  assert.equal(response.status, 200);
  assert.equal(await response.text(), '<main>tracker shell</main>');
});

test('HEAD navigation falls back with no response body', async () => {
  const { handler } = devServer();
  const response = await request(handler, '/work/id', { method: 'HEAD', headers: { Accept: 'text/html' } });

  assert.equal(response.status, 200);
  assert.equal(response.body, null);
  assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
});

test('missing files, non-HTML requests, and non-GET methods stay 404', async () => {
  const cases = [
    ['JavaScript', '/missing.js', 'GET', 'text/html'],
    ['CSS', '/missing.css', 'GET', 'text/html'],
    ['JSON', '/missing.json', 'GET', 'text/html'],
    ['image', '/missing.png', 'GET', 'text/html'],
    ['file with trailing slash', '/missing.js/', 'GET', 'text/html'],
    ['file-like final dot', '/missing.', 'GET', 'text/html'],
    ['encoded extension dot', '/missing%2ejs', 'GET', 'text/html'],
    ['encoded path separator', '/unsafe%2fpath', 'GET', 'text/html'],
    ['malformed path escape', '/unsafe%ZZpath', 'GET', 'text/html'],
    ['JSON Accept', '/work/id', 'GET', 'application/json'],
    ['HTML refused by quality value', '/work/id', 'GET', 'text/html;q=0, */*;q=1'],
    ['POST navigation', '/work/id', 'POST', 'text/html']
  ];

  for (const [label, path, method, accept] of cases) {
    const { handler } = devServer();
    const response = await request(handler, path, { method, headers: { Accept: accept } });
    assert.equal(response.status, 404, label);
    assert.equal(await response.text(), 'Not found', label);
  }
});

test('health endpoint remains JSON even when HTML is accepted', async () => {
  const { handler } = devServer();
  const response = await request(handler, '/__health', { headers: { Accept: 'text/html' } });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.match(response.headers.get('content-type') ?? '', /^application\/json/);
});

test('private build inputs and symlink escapes are never served as assets', async () => {
  const { handler } = devServer();
  for (const path of ['/runtime-config.mjs', '/build-manifest.json', '/worker-entry.mjs', '/wrangler.json', '/private/sentinel.txt']) {
    const response = await request(handler, path, { headers: { Accept: 'text/html' } });
    assert.equal(response.status, 404, path);
    assert.equal(await response.text(), 'Not found', path);
  }
});

test('reload endpoint remains an event stream even when HTML is accepted', async () => {
  const { handler, subscribers } = devServer();
  const response = await request(handler, '/__tracker_reload', { headers: { Accept: 'text/html' } });

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/);
  const reader = response.body.getReader();
  const firstChunk = await reader.read();
  assert.equal(String(firstChunk.value), 'retry: 1000\n\n');
  assert.equal(subscribers.size, 1);
  await reader.cancel();
  assert.equal(subscribers.size, 0);
});
