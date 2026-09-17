# DropSync Desktop

DropSync Desktop is an offline encrypted vault companion for `.dropsync` backups. Export a
`.dropsync` backup from the DropSync web app, import it here, and your drops live on your own
machine: browse, edit, and create everything offline, then export a fresh backup to carry
back to the web — that round trip is the heart of the product. When you do want the full
site, Cloud mode runs the real DropSync website inside the app, with useful desktop powers
added. Everything stays private by design: your data is encrypted locally, and the app has
no accounts, no servers of ours, and nothing phoning home.

## Download

No need to build from source — grab an installer from the
[Releases page](https://github.com/AhmedSaeed4/dropsync-desktop/releases/latest).
Every published version lives there, and the newest one is marked Latest.

- The installer is unsigned, so Windows SmartScreen shows **More info** → **Run anyway** on first run.
- The app does not auto-update: when a new version ships, download its installer from the
  Releases page and install it over the old one.

## What it does

**Local vault (fully offline)**

- Import `.dropsync` backups — personal and workspace backups alike — and merge them into
  what you already have.
- Export any space back to a `.dropsync` file, protected with a fresh password you choose at
  export time.
- Three kinds of drops: text, files (up to 500 MB per file; an archive holds up to 100,000
  entries and 20 GB), and Excalidraw drawings.
- Multiple local workspaces ("spaces"), with move and copy of drops between them — a copy is
  re-encrypted into its new space.
- Up to 3 categories per drop, pinning, and manual drag-to-reorder.
- Search across names, content, and categories; a query starting with `#` searches saved
  YouTube video titles.
- Local reminders with toasts, an on-screen card, and a missed-reminder queue; dismissing a
  reminder keeps it dismissed. Expiry timers behave exactly like the web's.
- A 30-second undo for single deletes; bulk deletes ask for a press-and-hold so they cannot
  happen by accident.
- Recently opened drops are pre-warmed in memory, so reopening one is instant.
- Right-click menu with Copy; fullscreen video playback; YouTube links are detected and get
  real titles and thumbnails — fetched once online, then kept in a local cache that works
  offline from then on.
- Light, Dark, and Minimal themes.

**Cloud mode (optional)**

- The real DropSync website runs inside the app in a sandboxed view and keeps its own login —
  the app never modifies or injects anything into the page.
- Desktop powers are added around it: native downloads with a progress chip, fullscreen,
  clipboard access, and a desktop screen-share picker.

## How your data stays private

- Your vault is encrypted on your machine: PBKDF2-SHA256 key derivation (600,000 iterations)
  plus AES-GCM encryption in 4 MiB chunks. Your password never leaves your computer.
- One vault password guards everything, and there is no recovery path: if you forget it, the
  data is unrecoverable. That is deliberate — without the password, nobody can read your
  vault. Not us, not anyone.
- No servers of our own, no accounts, no auto-update.
- The app's interface makes zero direct network requests; the only outside content it can
  load is the YouTube player for videos you saved.
- The app itself makes only one kind of outbound request, and only from its main process:
  for YouTube links you saved, it fetches video titles (YouTube's oEmbed API) and thumbnails
  — once, then cached locally so cards keep showing them offline.
- All native powers (files, encryption, dialogs, notifications) sit behind a typed,
  sandboxed bridge, so the interface never touches the system directly.

## Getting started

Prerequisites: Windows 10 or 11, Node.js 22 or newer, and npm.

```
npm install
npm run dev
```

- `npm run dev` — run the app in development.
- `npm run dist:win` — build the Windows installer (an unsigned one-click installer; Windows
  SmartScreen may ask you to choose "More info" and then "Run anyway").
- `npm run typecheck` — run the TypeScript checks.

Note: development builds and the installed app share the same vault location, and only one
of them can run at a time (a single-instance lock) — close one before opening the other.

## Project structure

| Path | What lives there |
| --- | --- |
| `src/main` | Electron main process: vault crypto, import/export, IPC, Cloud mode shell |
| `src/preload` | The typed `dropsync` bridge between the interface and the main process |
| `src/renderer` | The React UI |

## The .dropsync round trip

Export a `.dropsync` backup from the DropSync web app and import it here — imports merge
into your vault. Edit, create, and organize offline for as long as you like. When you are
ready, export the space back to a fresh `.dropsync` file with a new password, and take it
back to the web.
