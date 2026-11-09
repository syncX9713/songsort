# SongSort – Music Organizer, Duplicate Finder & Song Downloader

SongSort has two parts:

1. **Organize My Music:** scans a music collection, finds duplicate songs, and copies your music into tidy folders.
2. **Download a Song:** paste a link and SongSort downloads the song, if the source legitimately allows it. The file is checked to make sure it is real audio and kept in its original format. You can convert it if you like, and add it to your collection.

The organizer copies your music into three folders:

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

## Download a Song

1. Paste a link into **Download a Song** on the start screen and click **Check Link**.
2. SongSort finds out what the link is, downloads the file and checks it.
3. You see the song's details: title, artist, album, length, source, original format, quality and size. Only details the file or the source actually states are shown; nothing is made up. A preview player is shown for downloaded files.
4. Then you can:
   - **Download Original Format**: the file exactly as published, byte for byte. MP3 is never forced.
   - **Convert to Another Format** (optional): see below.
   - **Add to Music Collection**: pick your music folder. SongSort uses the organizer's duplicate engine to tell you whether you already have the song (identical file or another version) before adding it. Nothing is overwritten; a name clash becomes "name (2).flac".

### What links work

| Link | What happens |
|---|---|
| Direct link to an audio file (MP3, AAC, M4A, WAV, FLAC, OGG, WMA) | Downloaded and checked |
| Internet Archive item (`archive.org/details/…`) | Uses the Archive's official API. Lists the files, with the **original upload** first |
| Wikimedia Commons file page (`commons.wikimedia.org/wiki/File:…`) | Uses the official API. Shows the license |
| A web page that offers downloads (artist site, free music library) | The page's audio download links are listed for you to pick |
| YouTube, YouTube Music, Spotify, Apple Music, SoundCloud, Deezer, TIDAL, Amazon Music, JioSaavn, Gaana, Wynk, Hungama, Audiomack… | **Not downloaded.** SongSort recognises the song, explains what the service allows, and links to the official app, store or purchase page (Apple Music shows its official 30-second preview and iTunes Store price) |
| Bandcamp, Qobuz | Recognised as stores. Buy or download there, then add the file to your collection |

SongSort never gets around DRM, paywalls or streaming restrictions, and uses no third-party "converter" sites.

### On the website vs. on your computer

- **Website (github.io) and phones:** downloads happen in your browser. That works for sources that allow other websites to download their files, which includes Internet Archive and Wikimedia Commons. Other websites get a clear message.
- **On your computer (`npm start` / `Start SongSort.bat`):** SongSort's local **download helper** can also download from websites that block browser downloads. It runs only on your computer and needs no setup or account.

### Safety checks

Every file is checked before it's offered, and checked again before it's added to your collection:

- **Real contents, not names.** SongSort reads the file's first bytes (its "signature"), never trusting the file name or extension. Programs (`.exe`, Linux and Mac apps), scripts, web pages, SVG images, ZIP/RAR/7z archives, PDFs and Office documents disguised as audio are rejected.
- **Structure check for every format.** It confirms the MP3/AAC audio frames at the start, middle and end of the file, the FLAC header, the WAV/AIFF sections, the OGG pages, and the MP4/M4A and WMA layouts. Copy-protected (DRM) files and video files are rejected.
- **Second opinion from a maintained parser** (`music-metadata`). The file must be readable as audio with a real length.
- **The website's stated file type** is checked as an extra layer. If it says "web page" or "program", the file is rejected.
- **Limits.** Files can be at most 250 MB and web pages 3 MB. Checking a file times out after 90 seconds, and downloads stop after 30 seconds without data or 15 minutes in total. Damaged, cut-off and unsupported files (MIDI, WebM, MP2…) are rejected.
- **Link rules.** Only `https://` links are accepted. `file:`, `javascript:` and `data:` links, links with passwords, unusual ports, this computer, private and home networks, and cloud-metadata addresses are refused.
- **The download helper** also looks up each website's real network address and checks it, and connects to that checked address, so a trick name like `localtest.me` can't reach this computer. It checks every redirect (5 at most), never saves anything to disk, and only answers SongSort's own page.
- **Safe handling.** Files are never opened or run. File names are cleaned (no folder parts, no forbidden or invisible characters) and given the extension of their real format. Everything is held in memory; nothing temporary is left behind.

If a file fails, SongSort says: *"File rejected: This does not appear to be a valid supported audio file."* and explains what the file really is. These checks greatly reduce the risk but can't guarantee a file is 100% harmless. Only open music from sources you trust.

### Converting (optional)

Conversion uses FFmpeg (WebAssembly) on your own device. It loads only when you first convert (about 31 MB, then cached). You can convert to MP3, M4A (AAC), AAC, FLAC, WAV, OGG (Vorbis) and WMA. The original is kept; converted copies are clearly marked "Converted" and are checked like downloads.

- **No inflated quality:** SongSort never picks a higher bitrate than the source has.
- **Honest notes** with each option, e.g. that converting MP3 to FLAC makes a bigger file without improving the sound.
- **Measured quality:** a converted copy shows the quality of the file actually produced.

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
- **Downloader test bench:** run `node scripts/dev-test.mjs`. It starts SongSort on http://localhost:5180 plus a deliberately misbehaving local test website (`scripts/fixture-server.mjs`, http://127.0.0.1:5199). That site serves programs, web pages, SVGs and archives disguised as MP3, damaged and cut-off files, a misleading extension, oversized downloads, dropped connections and redirects to private addresses. Only this test launcher allows that one local address; the normal app and the website never do.
- Code layout:
  - `src/lib/`: the organizer engine.
    - `select.ts` picks files and walks folders.
    - `scan.ts`, `scan.worker.ts` and `pool.ts` read tags and hash files in Web Workers.
    - `analyze.ts` does the grouping.
    - `organize.ts` copies files and builds the ZIP.
  - `src/downloader/`: the song downloader.
    - `links.ts` checks and recognises links.
    - `address.ts` holds the network-address rules.
    - `fetchAudio.ts` does limited, checked downloading.
    - `sniff.ts` and `validate.ts` (in a worker) check files.
    - `sources.ts` talks to Internet Archive, Commons, web pages and streaming platforms.
    - `convert.ts` runs FFmpeg.
    - `collection.ts` adds songs to your collection.
  - `server/downloadHelper.ts`: the local helper, part of `npm start` only.
  - `src/components/`: the screens.
- Licenses: FFmpeg (`@ffmpeg/core`) is LGPL/GPL software and is loaded unmodified from its npm package.
