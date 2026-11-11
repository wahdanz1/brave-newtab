# Index

A Brave new tab page: pinned sites, recent sites and local dev servers.

## Install

1. Run `./sync-backgrounds.ps1` to copy Brave's wallpapers into `backgrounds/`.
2. Open `brave://extensions`, turn on **Developer mode**, click **Load unpacked** and pick this folder.

## Making changes

Edit the files, then click reload ↻ on the **Index** card in `brave://extensions`.

| File | What lives there |
| --- | --- |
| `newtab.html` | Page structure |
| `newtab.css` | Theme tokens (top of file), layout, cards |
| `newtab.js` | Pins, recent, dev pings, search, shortcuts, cover images |
| `manifest.json` | Permissions and the new tab override |

## Good to know

- Brave swaps its wallpaper set about once a quarter. Re-run `sync-backgrounds.ps1` to pick up the new one.
- Pin images are cached for 7 days in `chrome.storage.local`. To force a refresh, remove and re-add the pin.
- Brave focuses the address bar on every new tab. Click the page (or press `/` after clicking) before using the 1–5 shortcuts.
