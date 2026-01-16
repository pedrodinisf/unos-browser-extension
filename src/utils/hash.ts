/**
 * Normalize a URL for consistent hashing
 * Removes fragments, normalizes trailing slashes, lowercases host
 */
export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    // Remove fragment
    parsed.hash = '';
    // Normalize trailing slash for paths (but not for root)
    if (parsed.pathname !== '/' && parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }
    // Lowercase the host
    parsed.hostname = parsed.hostname.toLowerCase();
    return parsed.toString();
  } catch {
    // If URL parsing fails, return as-is
    return url;
  }
}

/**
 * Generate a SHA-256 hash of a URL
 * Returns hex string
 */
export async function hashUrl(url: string): Promise<string> {
  const normalized = normalizeUrl(url);
  const encoder = new TextEncoder();
  const data = encoder.encode(normalized);

  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');

  return hashHex;
}

/**
 * Synchronous hash for cases where async isn't practical
 * Uses a simple djb2 hash - not cryptographically secure, but fast
 */
export function hashUrlSync(url: string): string {
  const normalized = normalizeUrl(url);
  let hash = 5381;

  for (let i = 0; i < normalized.length; i++) {
    hash = (hash * 33) ^ normalized.charCodeAt(i);
  }

  // Convert to unsigned 32-bit integer and then to hex
  return (hash >>> 0).toString(16).padStart(8, '0');
}
