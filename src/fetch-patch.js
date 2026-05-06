// Generic fetch patches for WebTorrent web-seed traffic. None of this is
// IA-specific — it fixes interactions between webtorrent v2.5.1's webconn and
// any browser/web-seed combo that conforms to the same specs.
//
// 1. BEP-47 padding files
//    Multi-file torrents pad real files to piece boundaries by inserting
//    synthetic "padding" entries in the file list. The padding bytes are
//    zeroed out per spec, and the piece SHA1 is computed over those zeros —
//    they are NOT files that exist on the web-seed host. WebTorrent v2.5.1
//    has no awareness of BEP-47 and tries to fetch them like real files,
//    Promise.all in webconn.js rejects on the 404, and the entire piece
//    reconstruction fails. Detect padding URLs and synthesize a zero-byte
//    206 response locally — the piece then verifies cleanly.
//
// 2. CORS preflight on web-seed range requests
//    webconn.js sends `Cache-Control: no-store` and `user-agent` headers on
//    every web-seed fetch. Cache-Control is NOT on the CORS-safelisted
//    request-header list, so any cross-origin GET it issues triggers an
//    OPTIONS preflight; few web-seed hosts whitelist `cache-control` in
//    `access-control-allow-headers`, so the preflight fails and the GET
//    never runs. The `cache: 'no-store'` *option* already gives no-cache
//    semantics; the header is redundant. `user-agent` is browser-forbidden
//    anyway. Strip both on any fetch carrying a Range header (= the
//    web-seed pattern), regardless of host.
//
// 3. Diagnostics
//    webconn swallows fetch errors via the `debug` package, which never
//    reaches the on-page log. Mirror every Range-bearing fetch's lifecycle
//    (attempt / response / error) into dlog/dwarn/derr so the debug panel
//    shows what's happening when a download stalls.
//
// Must be imported BEFORE the WebTorrent bundle: webtorrent (via
// cross-fetch-ponyfill in older bundles, or direct `self.fetch` capture in
// the v2.5.1 dist) reads self.fetch at module-evaluation time. Importing
// this module from the very top of main.js ahead of ./torrent.js gets the
// order right.

const dlog = (m) => self.dlog && self.dlog('[fetch] ' + m)
const dwarn = (m) => self.dwarn && self.dwarn('[fetch] ' + m)
const derr = (m) => self.derr && self.derr('[fetch] ' + m)

// Padding-file URL patterns. Three flavors in the wild:
//   - BitComet / IA pipeline: `.____padding_file/<n>` (4+ underscores)
//   - Older mktorrent style:  `____padding_file_<n>_<hex>`
//   - Various `.pad/<n>` shorthands
const PADDING_URL = /(?:\/|^)(?:\.?_+padding_file|\.pad)(?:\/|_)/i

function getRange(input, init) {
  const h = (init && init.headers) || (input && input.headers) || null
  if (!h) return ''
  if (typeof h.get === 'function') return h.get('range') || ''
  return h.range || h.Range || ''
}

const origFetch = self.fetch && self.fetch.bind(self)

if (origFetch) {
  self.fetch = function patchedFetch(input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || ''
    const range = getRange(input, init)
    const isWebSeed = !!range

    if (PADDING_URL.test(url)) {
      const m = /bytes=(\d+)-(\d+)/.exec(range)
      const start = m ? parseInt(m[1], 10) : 0
      const end = m ? parseInt(m[2], 10) : 0
      const len = m ? Math.max(0, end - start + 1) : 0
      return Promise.resolve(new Response(new Uint8Array(len), {
        status: 206,
        statusText: 'Partial Content',
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(len),
          'content-range': `bytes ${start}-${end}/*`,
        },
      }))
    }

    if (isWebSeed && init) {
      const stripped = {}
      const src = init.headers || {}
      const entries = (typeof src.entries === 'function') ? src.entries() : Object.entries(src)
      for (const [k, v] of entries) {
        const kl = String(k).toLowerCase()
        if (kl === 'cache-control' || kl === 'user-agent') continue
        stripped[k] = v
      }
      // Strip `cache: 'no-store'` as well — some browser/server combos add a
      // synthetic `Cache-Control` request header when this is set, defeating
      // the header-strip above. The default cache mode is fine for one-shot
      // Range fetches.
      const { cache: _cache, ...rest } = init
      init = { ...rest, headers: stripped }
    }

    if (isWebSeed) dlog('GET ' + (range ? range + ' ' : '') + url.slice(0, 110))

    return origFetch(input, init).then(
      (res) => {
        if (isWebSeed) {
          if (res.ok) dlog(res.status + ' ← ' + url.slice(0, 110))
          else dwarn(res.status + ' ← ' + url.slice(0, 130))
        }
        return res
      },
      (err) => {
        if (isWebSeed) {
          derr('throw ' + (err.message || err) + ' on ' + url.slice(0, 110))
          // Diagnostic probe: re-fetch with the absolute minimum options so
          // we can tell whether the URL itself is unreachable (DNS / TLS /
          // CORS / mixed-content redirect) vs whether webconn's options are
          // upsetting the server. Result lands in the debug panel for paste.
          try {
            origFetch(url, { method: 'GET', headers: { Range: range || 'bytes=0-1023' } })
              .then(
                (r) => dlog('probe ' + r.status + ' redirected=' + r.redirected + ' type=' + r.type + ' ← ' + url.slice(0, 100)),
                (e) => derr('probe ALSO threw: ' + (e.message || e)),
              )
          } catch {}
        }
        throw err
      },
    )
  }
  dlog('patch installed (BEP-47 padding + CORS preflight strip + webseed logging)')
}

// One-shot connectivity diagnostic. Cross-origin "Failed to fetch" hides the
// real cause behind that one opaque error string; this runs a small matrix
// of fetches on boot and logs the outcome of each so we can tell whether
// archive.org is reachable at all from this browser/network, whether the
// CORS-friendly metadata API works (rules out network/DNS issues), whether
// /download/ redirects break things vs CDN-direct URLs, and whether the
// Range header itself is the trigger.
//
// Each probe uses a tiny Range so even a "success" only transfers ~1 KB.
async function _runConnectivityProbes() {
  const small = { headers: { Range: 'bytes=0-1023' } }
  const tests = [
    ['metadata-api  ', 'https://archive.org/metadata/mame251', {}],
    ['download-range', 'https://archive.org/download/mame251/3b1.zip', small],
    ['cdn-range     ', 'https://ia904704.us.archive.org/1/items/mame251/3b1.zip', small],
    ['cdn-no-cors   ', 'https://ia904704.us.archive.org/1/items/mame251/3b1.zip',
      { ...small, mode: 'no-cors' }],
  ]
  dlog('[probe] starting connectivity matrix...')
  for (const [label, url, opts] of tests) {
    try {
      const res = await origFetch(url, opts)
      try { res.body && res.body.cancel && res.body.cancel() } catch {}
      const cors = res.headers && res.headers.get && res.headers.get('access-control-allow-origin')
      dlog('[probe ' + label + '] ' + res.status +
        ' redir=' + (res.redirected ? 'Y' : 'N') +
        ' type=' + res.type +
        (cors ? ' acao=' + cors : ''))
    } catch (e) {
      derr('[probe ' + label + '] THREW: ' + (e.message || e))
    }
  }
  dlog('[probe] done')
}

if (origFetch) {
  // Run after page boot so we don't compete with the .torrent fetch.
  setTimeout(() => _runConnectivityProbes(), 500)
}
