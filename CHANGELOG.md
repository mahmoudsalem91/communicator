# Changelog

## 0.5.0 - 2026-11-20

### New
- **Text chat** between everyone in the room, sent directly between PCs. Shows the last 15 messages, links are clickable, and the taskbar flashes when a message arrives while the window is behind.
- **Push-to-talk**: hold any key or mouse button to talk, even inside games. Set it up under Settings > Push-to-talk.
- **Recording**: the new Record button saves the call to `Documents\Communicator Recordings` (one mixed file, optionally one file per person). Everyone in the room sees a **Rec** badge and a chat note while you record.
- **In-game overlay** that shows who is talking over windowed and borderless games. It hides while the Communicator window is in front.
- **Invite links**: **Copy invite link** gives a `communicator://join/<room>` link that opens the app and asks before joining.
- **Computer sound in screen shares** (optional, Windows). Viewers get a button to mute it.
- **Connection-quality dot** (green, amber, red) next to each person.
- **Mic level meter and speaker test** in Settings.
- **Sounds** for people joining, leaving and new chat messages.
- **Minimize to tray**, with a tray menu to show the window, mute or quit.

### Changed
- The window opens larger (500x920) so the main page fits without a scrollbar.
- Settings are grouped into Audio, Push-to-talk, App and Recording.

### Privacy
- Chat messages are also written to `chat-history.enc` in your AppData folder, encrypted with AES-256-GCM using a random key per message that is thrown away immediately. No key exists, so the file can never be decrypted by anyone.
- Recordings stay on your PC. Only record with everyone's consent.
- Push-to-talk uses a small native keyboard/mouse hook that runs only while the feature is on.

### Known limits
- Push-to-talk supports a single key or mouse button, not combinations.
- The overlay does not show over exclusive-fullscreen games.
- With "Share computer sound" on, use headphones, or friends may hear their own voices come back.

## 0.4.0
- Settings are saved to AppData; room codes are generated randomly.
