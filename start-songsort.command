#!/bin/bash
# Double-click on macOS to start SongSort (first time: run `chmod +x start-songsort.command`).
cd "$(dirname "$0")" || exit 1
if ! command -v npm >/dev/null 2>&1; then
  echo "SongSort needs Node.js. Please install it from https://nodejs.org and run this again."
  read -r -p "Press Enter to close."
  exit 1
fi
[ -d node_modules ] || { echo "Setting up SongSort for the first time..."; npm install; }
echo "Starting SongSort. Your browser will open. Close this window to stop SongSort."
npm start
