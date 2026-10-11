import { rootFallbackRequest, shouldFallbackNavigation } from '../tracker/viewer/tooling/navigation-fallback.mjs';
import { parseInstanceConfig } from '../tooling/instance/config.mjs';
import { handlePublishRequest, apiJsonError } from './publish-api.mjs';

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function response(message, status) {
  return new Response(`${message}\n`, {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function decodeBase64Url(value) {
  const text = String(value);
  if (!/^[A-Za-z0-9_-]+$/u.test(text)) throw new Error('invalid base64url');
  const normalized = text.replaceAll('-', '+').replaceAll('_', '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function decodeJson(value) {
  return JSON.parse(decoder.decode(decodeBase64Url(value)));
}

function audienceMatches(audience, expected) {
  const values = Array.isArray(audience) ? audience : [audience];
  return values.length > 0 && values.every(value => typeof value === 'string') && values.includes(expected);
}

function normalizedEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/** @param {Readonly<{readerEmails:string[],readerEmailDomains?:string[]}>} access @param {string} email */
function readerEmailAllowed(access, email) {
  if (access.readerEmails.includes(email)) return true;
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1 || email.indexOf('@') !== at) return false;
  return Array.isArray(access.readerEmailDomains) && access.readerEmailDomains.includes(email.slice(at + 1));
}

async function accessKey(teamDomain, keyId, fetchImpl) {
  const result = await fetchImpl(`${teamDomain}/cdn-cgi/access/certs`, {
    headers: { Accept: 'application/json' },
  });
  if (!result.ok) throw new Error('Access keys unavailable');
  const body = await result.json();
  const key = Array.isArray(body.keys)
    ? body.keys.find(candidate => candidate?.kid === keyId && candidate?.kty === 'RSA')
    : null;
  if (!key) throw new Error('Access key not found');
  return key;
}

/**
 * Verify a Cloudflare Access JWT against the captured site policy. Access keys
 * are fetched only after issuer, audience, and time claims pass. The result is
 * either an exact reader email, a configured reader email domain, or the
 * configured read-only service identity.
 */
export async function verifyAccessJwt(token, access, {
  now = Date.now,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!access || access.kind !== 'ready') throw new Error('Access is not configured');
  if (typeof fetchImpl !== 'function') throw new Error('Access key transport is unavailable');
  const parts = String(token).split('.');
  if (parts.length !== 3) throw new Error('malformed Access token');

  const header = decodeJson(parts[0]);
  const payload = decodeJson(parts[1]);
  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.kid.length === 0) {
    throw new Error('unsupported Access token');
  }
  if (payload.iss !== access.teamDomain) throw new Error('wrong Access issuer');
  if (!audienceMatches(payload.aud, access.audience)) throw new Error('wrong Access audience');

  const current = Math.floor(now() / 1000);
  if (!Number.isFinite(payload.exp) || payload.exp <= current) throw new Error('expired Access token');
  if (payload.nbf !== undefined && (!Number.isFinite(payload.nbf) || payload.nbf > current)) {
    throw new Error('early Access token');
  }
  if (payload.iat !== undefined && (!Number.isFinite(payload.iat) || payload.iat > current + 60)) {
    throw new Error('future Access token');
  }

  const key = await accessKey(access.teamDomain, header.kid, fetchImpl);
  const cryptoKey = await crypto.subtle.importKey(
    'jwk',
    key,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const valid = await crypto.subtle.verify(
    { name: 'RSASSA-PKCS1-v1_5' },
    cryptoKey,
    decodeBase64Url(parts[2]),
    encoder.encode(`${parts[0]}.${parts[1]}`),
  );
  if (!valid) throw new Error('invalid Access signature');

  const claimEmail = normalizedEmail(payload.email);
  const serviceShaped = Object.hasOwn(payload, 'common_name') || !Object.hasOwn(payload, 'email');
  if (serviceShaped) {
    if (
      access.service.kind !== 'enabled'
      || payload.type !== 'app'
      || payload.common_name !== access.service.clientId
      || payload.sub !== ''
      || Object.hasOwn(payload, 'email')
    ) throw new Error('wrong Access service identity');
    return { kind: 'service', clientId: payload.common_name };
  }

  if (!claimEmail || !readerEmailAllowed(access, claimEmail)) throw new Error('wrong Access identity');
  return claimEmail;
}

function privateAssetResponse(assetResponse, isHead = false) {
  const headers = new Headers(assetResponse.headers);
  headers.set('Cache-Control', 'private, no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Robots-Tag', 'noindex, nofollow');
  return new Response(isHead ? null : assetResponse.body, {
    status: assetResponse.status,
    statusText: assetResponse.statusText,
    headers,
  });
}

function invalidConfigurationWorker() {
  return {
    instance: null,
    async fetch() {
      return response('Private viewer is not configured.', 503);
    },
  };
}

function apiRequest(pathname) {
  const lower = pathname.toLowerCase();
  return lower === '/api' || lower.startsWith('/api/') || lower.startsWith('/api%');
}

function isPublishPath(pathname) {
  return pathname === '/api/publish' || pathname === '/api/publish/' || pathname.startsWith('/api/publish/');
}

function normalizedPathname(pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith('/')) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\\') || decoded.includes('\u0000')) return null;
  const segments = decoded.split('/');
  if (segments.some(segment => segment === '.' || segment === '..')) return null;
  return `/${segments.filter(Boolean).join('/')}`.toLowerCase();
}

function isPlanningPath(pathname) {
  const normalized = normalizedPathname(pathname);
  // A malformed encoded URL must not fall through to the SPA when a feature
  // is disabled. This fail-closed branch also prevents partial decoding from
  // changing which route boundary is being checked.
  if (normalized === null) return true;
  return normalized === '/weekly-planning'
    || normalized.startsWith('/weekly-planning/')
    || normalized === '/planning'
    || normalized.startsWith('/planning/');
}

function createConfiguredWorker(instance, options) {
  const access = instance.access;
  const verifyOptions = {
    now: options.now ?? Date.now,
    fetchImpl: options.accessFetch ?? options.fetchImpl ?? globalThis.fetch,
  };
  return {
    instance,
    async fetch(request, env = {}) {
      // This check is intentionally before token parsing, Access key fetches,
      // assets, and publisher credential construction.
      if (access.kind !== 'ready') return response('Private viewer is not configured.', 503);

      const token = request.headers.get('Cf-Access-Jwt-Assertion');
      if (!token) return response('Access required.', 403);

      let verifiedActor;
      try {
        verifiedActor = await verifyAccessJwt(token, access, verifyOptions);
      } catch {
        return response('Access required.', 403);
      }

      const pathname = new URL(request.url).pathname;
      if (apiRequest(pathname)) {
        if (!isPublishPath(pathname)) return apiJsonError('Not found.', 404, {}, request.method);
        if (typeof verifiedActor !== 'string') {
          return apiJsonError('Service Access identities are read-only.', 403, {}, request.method);
        }
        if (instance.publish.kind === 'disabled') {
          return apiJsonError('Publishing is disabled for this instance.', 403, {}, request.method, 'publishing-disabled');
        }
        if (verifiedActor !== instance.publish.publisherEmail) {
          return apiJsonError('Only the verified Don Access identity can review or publish tracker edits.', 403, {}, request.method);
        }
        return handlePublishRequest(request, verifiedActor, env, {
          ...options,
          instance,
        });
      }

      if (!instance.features.weeklyPlanning && isPlanningPath(pathname)) {
        return response('Not found.', 404);
      }

      if (!env.ASSETS || typeof env.ASSETS.fetch !== 'function') {
        return response('Private viewer is not configured.', 503);
      }
      const assetResponse = await env.ASSETS.fetch(request);
      if (shouldFallbackNavigation(request, assetResponse)) {
        return privateAssetResponse(await env.ASSETS.fetch(rootFallbackRequest(request)), request.method === 'HEAD');
      }
      return privateAssetResponse(assetResponse, request.method === 'HEAD');
    },
  };
}

/**
 * Create the Worker from one validated, immutable settings value. Parsing is
 * performed before the handler is returned, so every request observes the
 * same policy and destination even if ambient bindings later change.
 */
export function createTrackerWorker(value, options = {}) {
  const runtimeOptions = options && typeof options === 'object' ? options : {};
  let instance;
  try {
    instance = parseInstanceConfig(value);
  } catch {
    return invalidConfigurationWorker();
  }
  return createConfiguredWorker(instance, runtimeOptions);
}

// The direct Wrangler entrypoint intentionally remains an unconfigured state.
// Rendered site entries import createTrackerWorker(instance) with an explicit
// site manifest; ambient identity or destination bindings never become a
// production policy through this module's default export.
export default invalidConfigurationWorker();
