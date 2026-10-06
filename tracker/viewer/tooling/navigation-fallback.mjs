const RESERVED_PATHS = new Set(['/__health', '/__tracker_reload']);

function htmlQuality(accept) {
  if (typeof accept !== 'string' || !accept.trim()) return 0;

  let bestSpecificity = -1;
  let bestQuality = 0;
  for (const entry of accept.split(',')) {
    const [mediaRange = '', ...parameters] = entry.split(';');
    const media = mediaRange.trim().toLowerCase();
    let specificity;
    if (media === 'text/html') specificity = 2;
    else if (media === 'text/*') specificity = 1;
    else if (media === '*/*') specificity = 0;
    else continue;

    let quality = 1;
    for (const parameter of parameters) {
      const [name, ...valueParts] = parameter.trim().split('=');
      if (name?.trim().toLowerCase() !== 'q') continue;
      const value = valueParts.join('=').trim();
      if (!/^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(value)) quality = 0;
      else quality = Number(value);
    }

    if (specificity > bestSpecificity) {
      bestSpecificity = specificity;
      bestQuality = quality;
    } else if (specificity === bestSpecificity) {
      bestQuality = Math.max(bestQuality, quality);
    }
  }
  return bestQuality;
}

function isSafeExtensionlessPath(pathname) {
  if (!pathname.startsWith('/') || pathname.includes('\\') || /[\u0000-\u001f\u007f]/.test(pathname)) return false;

  const rawSegments = pathname.split('/');
  const segments = [];
  try {
    for (const rawSegment of rawSegments) {
      const segment = decodeURIComponent(rawSegment);
      if (segment.includes('/') || segment.includes('\\') || /[\u0000-\u001f\u007f]/.test(segment)) return false;
      if (segment === '.' || segment === '..') return false;
      if (rawSegment.includes('%') && segment.includes('%')) return false;
      segments.push(segment);
    }
  } catch {
    return false;
  }

  const finalSegment = segments.findLast(segment => segment.length > 0);
  if (!finalSegment) return false;
  const dot = finalSegment.lastIndexOf('.');
  return dot <= 0;
}

export function shouldFallbackNavigation(request, assetResponse) {
  if (assetResponse?.status !== 404) return false;
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return false;
  }
  if (RESERVED_PATHS.has(url.pathname) || !isSafeExtensionlessPath(url.pathname)) return false;
  return htmlQuality(request.headers.get('accept')) > 0;
}

export function rootFallbackRequest(request) {
  return new Request(new URL('/', request.url), request);
}
