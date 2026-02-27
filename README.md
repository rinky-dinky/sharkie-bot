# sharkie-bot

Simple music bot plugin for Sharkord that allows streaming music from youtube directly to voice channels.

## Installation

1. Download the latest release from the Releases for this fork page.
2. Move the `sharkie-bot` folder to your Sharkord plugins directory, typically located at `~/.config/sharkord/plugins`.
3. Download both the `ffmpeg` and `yt-dlp` binaries and place them inside the `sharkord/plugins/sharkie-bot/bin` folder.
4. Make both the `ffmpeg` and `yt-dlp` binaries have execution permissions (on UNIX systems, you can run `chmod +x ./ffmpeg` and `chmod +x ./yt-dlp` in the terminal).
5. Open Sharkord and enable the plugin.

`ffmpeg` can be downloaded from [FFmpeg's official website](https://ffmpeg.org/download.html).
`yt-dlp` can be downloaded from the [yt-dlp releases page](https://github.com/yt-dlp/yt-dlp/releases).

## Screenshots

![ss](https://i.imgur.com/mPsZSHA.png)

## Commands

- `/play <query>`: Adds a track to the queue. Supports search terms, YouTube URLs, direct URLs, and YouTube playlist URLs.
- `/play_direct <url>`: Adds a direct audio URL to the queue.
- `/queue`: Shows the current queue.
- `/skip`: Skips the current song.
- `/skipto <index>`: Skips directly to an index in the queue (`1` = current track).
- `/clearqueue`: Clears all queued tracks and keeps the current one playing.
- `/stop`: Stops playback and clears the queue.
- `/volume <0-100>`: Sets the playback volume (default is 50).
- `/nowplaying`: Shows the currently playing song.

## Troubleshooting

### Sign in to confirm you’re not a bot

Well, turns out this is a bot. If you encounter this issue, you can try the following solutions:

1. Use a different IP address by connecting through a VPN or proxy.
2. Pass your cookies to yt-dlp to a file in `plugins/sharkie-bot/bin/cookies.txt`.
