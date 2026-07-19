/**
 * Minimal static extension -> MIME table used by manifest auto-generation
 * when the caller does not supply its own detection. RFC 9239: javascript
 * is `text/javascript`. Kept deliberately small; consumers with a real
 * sniffer may inject one via `ParsePackageOptions.mimeTypeFor`.
 */

export const defaultMimeTypes: Readonly<Record<string, string>> = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  '.json': 'application/json',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.xml': 'application/xml',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

export const FALLBACK_MIME_TYPE = 'application/octet-stream';

/** MIME type for `path` from its lowercase extension; undefined when unknown. */
export function mimeTypeForPath(path: string): string | undefined {
  const slash = path.lastIndexOf('/');
  const dot = path.lastIndexOf('.');
  if (dot <= slash) {
    return undefined;
  }
  return defaultMimeTypes[path.slice(dot).toLowerCase()];
}
