// Minimal browser shim for node:path. parse-torrent only uses path.sep and
// path.join; we don't need the rest. Aliased via vite.config.js.

export const sep = '/'

export function join(...parts) {
  return parts
    .filter((p) => p != null && p !== '')
    .join('/')
    .replace(/\/+/g, '/')
}

export const posix = { sep, join }
export const win32 = { sep: '\\', join }

export default { sep, join, posix, win32 }
