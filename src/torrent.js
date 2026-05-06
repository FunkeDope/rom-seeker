import WebTorrent from 'webtorrent/dist/webtorrent.min.js'
import streamSaver from 'streamsaver'

const dlog = (m) => window.dlog && window.dlog('[wt] ' + m)
const dok = (m) => window.dok && window.dok('[wt] ' + m)
const dwarn = (m) => window.dwarn && window.dwarn('[wt] ' + m)
const derr = (m) => window.derr && window.derr('[wt] ' + m)

dok('torrent.js loaded; WebTorrent type=' + (typeof WebTorrent))

// Public WSS trackers — added to every torrent so browser peers can find each other
// even when the magnet's own announce list is HTTP/UDP-only (typical of IA torrents).
export const WSS_TRACKERS = [
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.btorrent.xyz',
  'wss://tracker.webtorrent.dev',
]

let _client = null
export function getClient() {
  if (!_client) {
    try {
      _client = new WebTorrent()
      dok('client created; WEBRTC_SUPPORT=' + WebTorrent.WEBRTC_SUPPORT)
    } catch (err) {
      derr('client init failed: ' + (err.message || err))
      throw err
    }
    _client.on('error', (err) => derr('client error: ' + (err.message || err)))
    _client.on('warning', (err) => dwarn('client warning: ' + (err.message || err)))
  }
  return _client
}

const _torrentsByHash = new Map()

const METADATA_TIMEOUT_MS = 30_000

export function addTorrent(torrentId, { webSeeds = [] } = {}) {
  const client = getClient()
  return new Promise((resolve, reject) => {
    const opts = {
      announce: WSS_TRACKERS,
      // BEP‑19 web seeds — IA serves these with permissive CORS, so the
      // browser can pull pieces over HTTPS even with zero WebRTC peers.
      urlList: webSeeds,
    }
    const existing = _findExisting(client, torrentId)
    if (existing) {
      if (existing.ready) return resolve(existing)
      existing.on('ready', () => resolve(existing))
      existing.on('error', reject)
      return
    }
    dlog('client.add ' + String(torrentId).slice(0, 100))
    if (webSeeds.length) dlog('  webSeeds=' + webSeeds.join(', '))
    const startedAt = Date.now()
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      const peers = torrent.numPeers || 0
      derr('metadata timeout after ' + METADATA_TIMEOUT_MS / 1000 + 's; peers=' + peers +
           ' (no WebRTC seeders found via WSS trackers)')
    }, METADATA_TIMEOUT_MS)

    const torrent = client.add(torrentId, opts, (t) => {
      settled = true
      clearTimeout(timer)
      dok('torrent ready cb infoHash=' + t.infoHash + ' files=' + t.files.length +
          ' (after ' + ((Date.now() - startedAt) / 1000).toFixed(1) + 's)')
      resolve(t)
    })
    torrent.on('infoHash', () => dlog('infoHash event ' + torrent.infoHash))
    torrent.on('metadata', () => {
      dlog('metadata event; deselecting all files')
      torrent.deselect(0, torrent.pieces.length - 1, false)
      for (const f of torrent.files) f.deselect()
      _torrentsByHash.set(torrent.infoHash, torrent)
    })
    torrent.on('wire', (wire, addr) => dlog('wire ' + (addr || '?')))
    torrent.on('noPeers', (announceType) => dwarn('noPeers: ' + announceType))
    torrent.on('warning', (err) => dwarn('torrent warning: ' + (err.message || err)))
    torrent.on('error', (err) => {
      settled = true
      clearTimeout(timer)
      derr('torrent error: ' + (err.message || err))
      reject(err)
    })
  })
}

function _findExisting(_client, magnetOrHash) {
  // Look up by infoHash in our own map. WebTorrent v2's client.get() is
  // async (returns a Promise), so we can't use it synchronously here.
  // Hex hashes only — base32 magnets get parsed inside WebTorrent itself,
  // and a duplicate add will be caught by client.add()'s _infoHash check.
  const m = /xt=urn:btih:([0-9a-f]{40})/i.exec(magnetOrHash || '')
  let hash = m ? m[1].toLowerCase() : null
  if (!hash && /^[0-9a-f]{40}$/i.test(magnetOrHash || '')) hash = magnetOrHash.toLowerCase()
  if (!hash) return null
  return _torrentsByHash.get(hash) || null
}

/**
 * Download a single file from the torrent to disk via StreamSaver.
 * Returns an object with `cancel()` to abort.
 */
export function downloadFile(torrent, file, onProgress) {
  // Mark this single file as wanted; leave the others deselected.
  file.select()

  const writeStream = streamSaver.createWriteStream(file.name, {
    size: file.length,
  })
  const writer = writeStream.getWriter()

  let cancelled = false
  let lastReported = -1

  const tickProgress = () => {
    if (cancelled) return
    const pct = file.progress
    if (pct !== lastReported) {
      lastReported = pct
      onProgress && onProgress({ progress: pct, downloaded: file.downloaded, done: file.done })
    }
  }
  const intervalId = setInterval(tickProgress, 500)

  ;(async () => {
    try {
      const stream = file.createReadStream()
      stream.on('data', async (chunk) => {
        if (cancelled) return
        // Backpressure: pause node-style stream while writer is busy.
        stream.pause()
        try {
          await writer.write(chunk)
          if (!cancelled) stream.resume()
        } catch (err) {
          if (!cancelled) console.warn('[download] writer error:', err)
          cancelled = true
          try { stream.destroy() } catch {}
        }
      })
      stream.on('end', async () => {
        clearInterval(intervalId)
        if (!cancelled) {
          try { await writer.close() } catch {}
          tickProgress()
          onProgress && onProgress({ progress: 1, downloaded: file.length, done: true })
        }
      })
      stream.on('error', async (err) => {
        clearInterval(intervalId)
        console.warn('[download] read error:', err)
        try { await writer.abort(err) } catch {}
        onProgress && onProgress({ progress: file.progress, downloaded: file.downloaded, done: false, error: err })
      })
    } catch (err) {
      clearInterval(intervalId)
      console.warn('[download] setup error:', err)
      try { await writer.abort(err) } catch {}
      onProgress && onProgress({ progress: 0, downloaded: 0, done: false, error: err })
    }
  })()

  return {
    cancel() {
      cancelled = true
      clearInterval(intervalId)
      try { writer.abort() } catch {}
      file.deselect()
    },
  }
}

export function formatSize(bytes) {
  if (bytes == null || isNaN(bytes)) return ''
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let n = bytes
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++ }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : n >= 10 ? 1 : 2)} ${units[i]}`
}
