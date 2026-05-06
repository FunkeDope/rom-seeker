// Per-torrent download state, persisted to localStorage so the page can
// resume after a refresh. The actual *piece data* persists separately in
// WebTorrent's chunk store (OPFS on modern browsers, fallback to memory) —
// we only need to remember which files the user wanted, so we can call
// file.select() again on the freshly re-added torrent.
//
// Shape:
//   {
//     [infoHash]: {
//       selected: ["mame251/foo.zip", ...],
//       done:     ["mame251/bar.zip", ...]
//     },
//     ...
//   }

// v2 = post-skipVerify cleanup. v1 entries were polluted by skipVerify lying
// about file.done, which caused _bindDoneHandler to write every restored
// file into state.done even though no actual pieces existed.
const KEY = 'rom-seeker:torrents-v2'

// Best-effort: clear the old (poisoned) v1 storage on first load.
try { localStorage.removeItem('rom-seeker:torrents-v1') } catch {}

function read() {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}') }
  catch { return {} }
}

function write(state) {
  try { localStorage.setItem(KEY, JSON.stringify(state)) } catch {}
}

export function getTorrentState(infoHash) {
  if (!infoHash) return { selected: [], done: [] }
  const all = read()
  const e = all[infoHash]
  return {
    selected: Array.isArray(e?.selected) ? e.selected : [],
    done: Array.isArray(e?.done) ? e.done : [],
  }
}

function update(infoHash, mutator) {
  if (!infoHash) return
  const all = read()
  const cur = all[infoHash] || { selected: [], done: [] }
  const next = mutator(cur) || cur
  all[infoHash] = next
  write(all)
}

export function markSelected(infoHash, filePath) {
  update(infoHash, (s) => {
    if (!s.selected.includes(filePath)) s.selected.push(filePath)
    return s
  })
}

export function markDeselected(infoHash, filePath) {
  update(infoHash, (s) => ({
    selected: s.selected.filter((p) => p !== filePath),
    done: s.done,
  }))
}

export function markDone(infoHash, filePath) {
  update(infoHash, (s) => ({
    // A done file is also no longer "actively selected" — leave the seeding
    // story to WebTorrent's piece state, not this list.
    selected: s.selected.filter((p) => p !== filePath),
    done: s.done.includes(filePath) ? s.done : [...s.done, filePath],
  }))
}

export function isDone(infoHash, filePath) {
  return getTorrentState(infoHash).done.includes(filePath)
}

export function isSelected(infoHash, filePath) {
  return getTorrentState(infoHash).selected.includes(filePath)
}
