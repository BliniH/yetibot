# Yeti Roblox Monitor Bot

## Setup
1. Put your real values in `.env`.
2. Put Roblox game links in `games.json`. You can use simple strings:

```json
[
  "https://www.roblox.com/games/135508011149513/Sansz-IS-god"
]
```

3. Install packages:

```bash
npm install
```

4. Run:

```bash
npm start
```

## Notes
- The bot checks every 30 seconds by default.
- If a game fails status/player checks several times in a row, it deletes the current Discord message and posts the next game.
- `GIF_URL` must be a direct image/GIF URL, usually a Discord CDN link ending in `.gif`, `.png`, or `.jpg`.
- Keep `.env` private. Never share your Discord token or Roblox cookie.
