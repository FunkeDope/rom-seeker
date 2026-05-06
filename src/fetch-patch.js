// Patches the global fetch with two behaviors:
//
// 1. Synthesize zero-byte responses for BEP-47 "padding file" URLs.
//
//    IA's MAME-style torrents include synthetic padding files in their .torrent
//    metadata (paths like `<id>/.____padding_file/0`) so each real ROM aligns
//    to a piece boundary. These files don't exist on the actual web seed host
//    — but WebTorrent v2.5.1 has no awareness of BEP-47 and treats them as
//    real files. It fetches them via HTTP, gets a 404, and `Promise.all` in
//    webconn.js rejects, taking down the entire piece reconstruction. Result:
//    zero bytes ever flow.
//
//    Per BEP-47 the padding bytes are zero, and the piece SHA1 is computed
//    over those zeros — so we can substitute a local zero buffer of the
//    requested length and the piece verifies correctly.
//
// 2. Surface archive.org fetch failures in the on-page debug panel.
//
//    WebTorrent's webconn swallows HTTP errors silently (only writes them to
//    the `debug` package, which the user can't see). That's why "0 B/s with 3
//    peers" produced zero log lines. Wrap fetch and forward archive.org
//    failures through dwarn / derr so they show up.
//
// Must be imported BEFORE the WebTorrent bundle: cross-fetch-ponyfill captures
// `self.fetch` at module-evaluation time, so any patch later than that is
// invisible to webconn. Importing this module from the very top of main.js,
// ahead of `./torrent.js`, gets the order right.

const dlog = (m) => self.dlog && self.dlog('[fetch] ' + m)
const dwarn = (m) => self.dwarn && self.dwarn('[fetch] ' + m)
const derr = (m) => self.derr && self.derr('[fetch] ' + m)

// Matches all common padding-file naming conventions:
//   - BitComet / IA pipeline: `.____padding_file/<n>` (4+ underscores)
//   - Older mktorrent style:  `____padding_file_<n>_<hex>`
//   - Various `.pad/<n>` shorthands
const PADDING_URL = /(?:\/|^)(?:\.?_+padding_file|\.pad)(?:\/|_)/i

const origFetch = self.fetch && self.fetch.bind(self)

if (origFetch) {
  self.fetch = function patchedFetch(input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || ''

    if (PADDING_URL.test(url)) {
      const range = (init && init.headers && (init.headers.range || init.headers.Range)) ||
        (input && input.headers && input.headers.get && input.headers.get('range')) || ''
      const m = /bytes=(\d+)-(\d+)/.exec(range)
      const start = m ? parseInt(m[1], 10) : 0
      const end = m ? parseInt(m[2], 10) : 0
      const len = m ? Math.max(0, end - start + 1) : 0
      const data = new Uint8Array(len)
      return Promise.resolve(new Response(data, {
        status: 206,
        statusText: 'Partial Content',
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(len),
          'content-range': `bytes ${start}-${end}/*`,
        },
      }))
    }

    return origFetch(input, init).then(
      (res) => {
        if (!res.ok && url.includes('archive.org')) {
          dwarn(res.status + ' ' + url.slice(0, 140))
        }
        return res
      },
      (err) => {
        if (url.includes('archive.org')) derr('throw ' + (err.message || err) + ' on ' + url.slice(0, 120))
        throw err
      },
    )
  }
  dlog('patch installed (BEP-47 padding + archive.org error surfacing)')
}
