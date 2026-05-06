import WebTorrent from 'webtorrent/dist/webtorrent.min.js'
import streamSaver from 'streamsaver'

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
    _client = new WebTorrent()
    _client.on('error', (err) => console.warn('[webtorrent] client error:', err.message || err))
  }
  return _client
}

const _torrentsByHash = new Map()

export function addTorrent(magnetOrHash) {
  const client = getClient()
  return new Promise((resolve, reject) => {
    const opts = { announce: WSS_TRACKERS }
    const existing = _findExisting(client, magnetOrHash)
    if (existing) {
      if (existing.ready) return resolve(existing)
      existing.on('ready', () => resolve(existing))
      existing.on('error', reject)
      return
    }
    const torrent = client.add(magnetOrHash, opts, (t) => {
      // selection happens below in 'metadata'
      resolve(t)
    })
    torrent.on('metadata', () => {
      // Deselect everything by default — we only want files the user clicks.
      // WebTorrent auto-selects all files on add; we override that here.
      torrent.deselect(0, torrent.pieces.length - 1, false)
      for (const f of torrent.files) f.deselect()
      _torrentsByHash.set(torrent.infoHash, torrent)
    })
    torrent.on('error', (err) => {
      console.warn('[webtorrent] torrent error:', err.message || err)
      reject(err)
    })
  })
}

function _findExisting(client, magnetOrHash) {
  // try infoHash extracted from magnet, or treat input as a hash directly
  const m = /xt=urn:btih:([0-9a-f]{40}|[A-Z2-7]{32})/i.exec(magnetOrHash || '')
  let hash = m ? m[1].toLowerCase() : null
  if (!hash && /^[0-9a-f]{40}$/i.test(magnetOrHash || '')) hash = magnetOrHash.toLowerCase()
  if (!hash) return null
  return client.get(hash) || null
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
