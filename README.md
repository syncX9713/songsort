# SongSort – Music Organizer & Duplicate Finder

SongSort scans a music collection, finds duplicate songs, and copies your music into three tidy folders:

```
SongSort Output/
  Unique Songs/          every song once (including the copy you chose to keep)
  Duplicates/            the extra copies
  Potential Duplicates/  similar songs you have not reviewed yet
```

It runs entirely in your web browser. Your music is never uploaded, and your original files are never moved, changed or deleted.

**Use it online (computer or phone): https://syncx9713.github.io/songsort/**

## Start it

You need [Node.js](https://nodejs.org) (version 20 or newer) installed once.

- **Windows:** double-click `Start SongSort.bat`
- **Mac:** double-click `start-songsort.command` (the first time, run `chmod +x start-songsort.command` in Terminal)
- **Any computer, from a terminal** in this folder:

```bash
npm install
```

```bash
npm start
```

Your browser opens at http://localhost:5178. Keep the window open while you use SongSort.

## Use it

1. Click **Select Music Folder / Files** and pick a folder, a USB pen drive, an external hard drive, or individual songs. You can add more folders before scanning.
2. Click **Scan Music**.
3. Look through **Unique Songs**, **Exact Duplicates** and **Potential Duplicates**.
4. For each exact-duplicate group, pick the copy to keep. For each potential-duplicate group, listen and choose *Decide later*, *No, keep all* or *Yes, keep one*.
5. Click **Organize My Music** and choose a destination folder, or download a ZIP file.

**Previous Scans** (on the start screen) keeps a report of each scan: the song lists, the duplicate groups and whether you organized it. Reports are stored privately in your browser and contain song names, locations and sizes, never the music; the 20 most recent are kept. In Chrome or Edge on a computer, **Scan again** reopens a folder you scanned before (the browser may ask for permission first).

## How duplicates are found

- **Exact duplicates:** files whose contents are byte-for-byte identical, confirmed with a SHA-256 fingerprint. Only files that share their exact size with another file need fingerprinting, because files of different sizes can't be identical.
- **Potential duplicates:** files with different contents but matching song details: the same title and artist (read from the tags inside the file), at roughly the same length (within 6 seconds). Files with no tags are matched by a cleaned-up file name (track numbers and "(1)" / "copy" / "_1" markers are ignored, and in "FILM = SONG" names the song part is used).
  - Placeholder tags are ignored and the file name is used instead. These are titles that equal the artist, are a website, or are one title shared by many unrelated files (e.g. a ripper's name).
  - For files without a usable title, names that are spelled differently but clearly similar (e.g. "MILKE" / "MILKAR", "MEIN" / "MAIN") are also grouped. This only happens when the lengths match within 2 seconds.
  - Live versions, remixes and edits with a different title or length are **not** grouped. Potential duplicates are never treated as confirmed. You decide.

Supported formats: MP3, WAV, M4A, AAC, FLAC, OGG/Opus, WMA (plus AIFF).

## What works where

| | Pick a folder / drive | Pick files | Save organized folders | ZIP download |
|---|---|---|---|---|
| Chrome / Edge on Windows, Mac, Linux | ✅ | ✅ | ✅ written directly | ✅ streamed to disk |
| Firefox / Safari on a computer | ✅ (read only) | ✅ | ❌ | ✅ |
| Android (Chrome) | depends on the phone | ✅ via the phone's file picker | ❌ | ✅ |
| iPhone / iPad (Safari) | ❌ | ✅ via the Files picker | ❌ | ✅ |

Limits:

- Browsers can only open what you pick in their file picker. SongSort can't browse your whole device.
- Browsers block a few system locations (for example the main system drive or Windows folders). If that happens, pick the folder that holds your music.
- Phone browsers can't create folders on the device, so you get a ZIP file instead. A USB drive plugged into a phone works only if the phone's file picker shows it.
- Without direct folder saving, the ZIP is built in the browser's memory. Very large ZIPs (several GB) can fail on phones. If that happens, scan fewer songs at a time.

## Using it on a phone

A phone browser can't run `npm start` itself. Use one of these instead:

- Run `npm run start:lan` on your computer, then open the "Network" address it prints on a phone connected to the same Wi-Fi.
- Or run `npm run build` and put the `dist` folder on any static web host. Everything still runs on the phone; nothing is sent to that server.

## For developers

- `npm run make-samples` creates a `test-samples/` folder with known exact duplicates, re-encodes, untagged files, same-name files, a longer version of a song, a damaged file, an empty file and a macOS `._` file.
- `npm run typecheck` / `npm run build`
- Code layout: `src/lib/` holds the engine: `select.ts` picks files and walks folders, `scan.ts` / `scan.worker.ts` / `pool.ts` read tags and hash files in Web Workers, `analyze.ts` does the grouping, and `organize.ts` copies files and builds the ZIP. `src/components/` holds the screens.
