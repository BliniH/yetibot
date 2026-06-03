# Yeti Open Cloud Publisher + Discord Bot Connector

This folder adds an Open Cloud publisher in front of your current working Discord monitor bot.

The publisher does this:

1. Uploads `module/module.rbxm` to Roblox with Open Cloud Assets API.
2. Gets the uploaded asset ID.
3. Inserts that asset ID into `serverScript.lua`.
4. Injects the generated server script into `files/template.rbxlx` under `ServerScriptService`.
5. Publishes the patched template to each place listed in `places.json`.
6. Writes the final Roblox links to `games.json`.
7. Starts your existing Discord monitor bot from `index.js`.

Roblox Open Cloud Assets API supports uploading assets programmatically, and Place Publishing API supports publishing new versions to existing places. You still need to create the blank places manually first.

## Folder setup

Put your current working Discord bot file in this folder as:

```txt
index.js
```

Put your Roblox module/model file here:

```txt
module/module.rbxm
```

Important: for `require(assetId)` to work, the uploaded asset should be require-able, usually a model containing a ModuleScript named `MainModule`.

Edit:

```txt
places.json
```

with the places you manually created first. Example:

```json
[
  {
    "channel": 1,
    "name": "misan2",
    "placeId": "77703427565906",
    "universeId": "1234567890",
    "link": "https://www.roblox.com/games/77703427565906/misan2"
  }
]
```

## Railway variables

Add these in Railway Variables:

```env
ROBLOX_OPEN_CLOUD_API_KEY=your_open_cloud_key
AUTO_PUBLISH_ON_START=true
CREATOR_USER_ID=your_user_id
# or use CREATOR_GROUP_ID=your_group_id instead

DISCORD_TOKEN=your_discord_bot_token
CHANNEL_1_ID=your_channel_1_id
CHANNEL_2_ID=your_channel_2_id
CHECK_INTERVAL_MS=30000
FAILS_BEFORE_SWITCH=3
GIF_URL=https://media1.tenor.com/m/S9hs-0W-tz8AAAAC/aesthetic-pixel.gif
```

Do not put API keys or Discord tokens in GitHub.

## Open Cloud API key permissions

In Roblox Creator Dashboard, make an Open Cloud API key with permissions for:

- Asset upload/create for your user or group.
- Place publishing/write access for every universe/place in `places.json`.
- Place update/name permissions if you want automatic renaming.

## Run locally

```bash
npm install
npm run publish
```

That only publishes and updates `games.json`.

To publish first, then start your existing Discord bot:

```bash
npm start
```

## Railway start command

Use:

```bash
npm start
```

If you do not want to publish on every Railway deploy, set:

```env
AUTO_PUBLISH_ON_START=false
```

Then manually run/push when publishing is needed.

## Notes

- The publisher updates existing places. It does not create new Roblox experiences from scratch.
- The Discord bot stays your current working bot. This package only updates `games.json` before starting it.
- `files/template.rbxlx` is a very plain starter template. You can replace it with your own `.rbxlx` template exported from Roblox Studio.
