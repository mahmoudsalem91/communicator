# Communicator

Low-latency voice rooms for up to 8 friends. Voice goes straight from each PC to every other PC (peer-to-peer WebRTC, Opus codec tuned for 10 ms frames). There's no Discord-style server in the middle, so on fiber in the same city the delay should be well under 100 ms.

## Using it

1. Install `Communicator Setup x.y.z.exe`. Windows may say "Windows protected your PC" because the app isn't code-signed. Click **More info → Run anyway**.
2. Pick a **nickname**, and have everyone type the **same room code** (or one person clicks *New code* and sends it to the others). Press **Connect**.
3. After that, the app connects by itself every time you open it.

- The **people list** shows who's in the room. Avatars light up when someone talks, and each person has their own volume slider. Hover the delay text for ping, buffer and packet loss.
- **Ctrl+Shift+M** mutes/unmutes, even while a game has focus.
- **Share screen** lets you pick a screen or window. *Smooth* (60 fps) is for games, *Sharp* is for text. Everyone in the room sees it; if several people share, click their **Live** badge to switch. Double-click the video for fullscreen.
- If everyone uses headsets, turning off echo cancellation in Audio settings shaves off a little more delay.

## How connecting works

A room has 8 seats. A free public signaling server (PeerJS cloud) only introduces the PCs: a newcomer takes the first free seat and contacts every other seat, and each pair of people gets its own direct link. If a router blocks a direct connection, it falls back to a relay (TURN), and that person's row shows *Relayed*. If someone's link drops, both sides keep trying to reconnect for a minute.

Every person sends their voice to every other person, which is fine for a group of friends: voice uses about 64 kbit/s per person. Screen sharing sends a separate video stream to each viewer (up to 8 Mbit/s each).

## Development

```bash
npm install
npm start                                  # run the app
npm run start:second                       # a second copy with its own settings, for testing
# dev-only flags: --room=<code> --name=<nick> --profile=<name> --test-share --screenshot=<file.png>
```

## Releasing an update (auto-update)

The app checks GitHub Releases on launch and every 30 minutes. It downloads new versions in the background and shows a **Restart to update** button.

One-time setup:
1. Create a **public** GitHub repo called `communicator` under `mahmoudsalem91` (https://github.com/mahmoudsalem91/communicator).
2. Create a **fine-grained** GitHub token (Settings → Developer settings → Personal access tokens → Fine-grained tokens):
   - Repository access: **Only select repositories** → `communicator`
   - Repository permissions: **Contents → Read and write** (Metadata read-only is added automatically)
3. Copy `.env.example` to `.env` (if it isn't there already) and paste the token:
   ```
   GH_TOKEN=github_pat_...
   ```
   `.env` is git-ignored and is not packed into the app.

Each release:
1. Bump `"version"` in `package.json` (for example `0.2.0` → `0.3.0`). The app only updates when the version goes up.
2. Run `npm run release`. It reads the token from `.env`, builds the installer, and uploads it to a new GitHub release along with `latest.yml`. Your friend's app picks it up automatically.
