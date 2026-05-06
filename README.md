# rom-seeker

A Myrient-style ROM index that runs entirely in the browser. Files come from
public torrents (e.g. Internet Archive) over WebTorrent — your server never
holds or proxies the ROM bytes.

## How it works

1. The site ships a small `catalog.json` of curated torrents (MAME, PSX, …).
2. Open a collection: the browser adds the magnet via WebTorrent and renders
   the file list in a Myrient-style table.
3. Click a file: WebTorrent fetches just that file's pieces from the swarm
   (and the Internet Archive web seed where available) and streams them
   straight to disk via StreamSaver. Other files in the torrent never touch
   your machine.

Why this works for Internet Archive torrents specifically: IA publishes its
torrents with `archive.org` listed as an HTTP web seed (BEP‑19). Browser
WebTorrent peers can talk to web seeds directly over HTTPS, sidestepping the
"browser peers can't reach traditional TCP/uTP swarms" limitation.

## Adding a torrent

Edit `public/catalog.json`:

```json
{
  "slug": "mame",
  "title": "MAME — Arcade ROMs",
  "subtitle": "Multiple Arcade Machine Emulator collection",
  "magnet": "magnet:?xt=urn:btih:…",
  "source": "https://archive.org/details/…"
}
```

Empty `magnet` fields render a placeholder card with a "no magnet configured"
note.

## Local dev

```sh
npm install
npm run dev
```

Then open the URL Vite prints (typically `http://localhost:5173/rom-seeker/`).

## Deploy (GitHub Pages)

A workflow at `.github/workflows/deploy.yml` builds and deploys on every push
to `main` (and the active feature branch). Once-off setup in the repo:

1. **Settings → Pages → Source = "GitHub Actions"**.
2. Push a commit; the action builds with Vite (`base: '/rom-seeker/'`) and
   uploads `dist/` to Pages.

If you fork or rename the repo, update `base` in `vite.config.js` to match.

## Caveats

- **Empty swarms**: torrents with zero WebRTC peers and no web seed will not
  download in the browser. IA torrents always have a web seed, so this is
  mostly a non-issue for IA-sourced collections.
- **Safari**: WebRTC + Service Worker support is the flakiest of the major
  browsers. Chrome/Firefox are the happy path.
- **No seeding**: this is a download-only client by design.
