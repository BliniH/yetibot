require('dotenv').config();

const axios = require('axios');
const gamesRaw = require('./games.json');

const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} = require('discord.js');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const GROUP_URL = process.env.GROUP_URL || 'https://www.roblox.com/communities/2613928/ROLVe#!/about';
const GIF_URL = process.env.GIF_URL || '';
const CHECK_INTERVAL_MS = Number(process.env.CHECK_INTERVAL_MS || 30000);
const FAILS_BEFORE_SWITCH = Number(process.env.FAILS_BEFORE_SWITCH || 3);
const ROBLOSECURITY = process.env.ROBLOSECURITY || '';

if (!DISCORD_TOKEN || !CHANNEL_ID) {
  console.error('Missing DISCORD_TOKEN or CHANNEL_ID in .env');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

let channel = null;
let message = null;
let currentIndex = 0;
let startTime = Date.now();
const failCounts = new Map();

const games = gamesRaw
  .map((item) => {
    if (typeof item === 'string') return { link: item };
    return item;
  })
  .filter((game) => game && typeof game.link === 'string' && game.link.includes('roblox.com/games/'));

if (!games.length) {
  console.error('games.json has no valid Roblox game links.');
  process.exit(1);
}

function robloxHeaders() {
  const headers = {
    'User-Agent': 'Mozilla/5.0 YetiBot/1.0',
    Accept: 'application/json,text/plain,*/*'
  };

  if (ROBLOSECURITY && ROBLOSECURITY !== 'optional_only_if_needed_do_not_share') {
    headers.Cookie = `.ROBLOSECURITY=${ROBLOSECURITY}`;
  }

  return headers;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractUrlId(link) {
  const match = link.match(/roblox\.com\/games\/(\d+)/i);
  return match ? match[1] : null;
}

function nameFromLink(link) {
  const slug = link.split('/games/')[1]?.split('/')[1]?.split('?')[0]?.split('#')[0];
  if (!slug) return 'Roblox Game';
  return decodeURIComponent(slug).replace(/-/g, ' ');
}

function getUptime() {
  const sec = Math.floor((Date.now() - startTime) / 1000);
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;

  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return `${m}m ${s}s`;
}

async function getUniverseFromPlace(placeId) {
  try {
    const url = `https://apis.roblox.com/universes/v1/places/${placeId}/universe`;
    const res = await axios.get(url, { headers: robloxHeaders(), timeout: 12000 });
    return res.data?.universeId ? String(res.data.universeId) : null;
  } catch (err) {
    return null;
  }
}

async function getGameByUniverse(universeId) {
  try {
    const url = `https://games.roblox.com/v1/games?universeIds=${universeId}`;
    const res = await axios.get(url, { headers: robloxHeaders(), timeout: 12000 });
    const data = res.data?.data?.[0];
    if (!data) return null;

    return {
      universeId: String(data.id || universeId),
      rootPlaceId: data.rootPlaceId ? String(data.rootPlaceId) : null,
      name: data.name || null,
      playing: Number(data.playing || 0),
      visits: Number(data.visits || 0),
      isPlayable: data.isPlayable !== false
    };
  } catch (err) {
    return null;
  }
}

async function getPlaceDetails(placeId) {
  const endpoints = [
    `https://games.roblox.com/v1/games/multiget-place-details?placeIds=${placeId}`,
    `https://www.roblox.com/games/multiget-place-details?placeIds=${placeId}`
  ];

  for (const url of endpoints) {
    try {
      const res = await axios.get(url, { headers: robloxHeaders(), timeout: 12000 });
      const data = Array.isArray(res.data) ? res.data[0] : null;
      if (!data) continue;

      return {
        name: data.name || data.Name || null,
        playing: Number(data.playerCount ?? data.PlayerCount ?? data.playing ?? 0),
        placeId: String(data.placeId || data.PlaceId || placeId),
        universeId: data.universeId ? String(data.universeId) : null,
        isPlayable: data.isPlayable !== false
      };
    } catch (err) {
      // try next endpoint
    }
  }

  return null;
}

async function getGameStatus(game) {
  const urlId = extractUrlId(game.link);
  if (!urlId) {
    return { ok: false, reason: 'bad_link', players: null, name: game.name || 'Invalid Roblox Link' };
  }

  // Attempt 1: Treat URL id as placeId, convert to universeId, fetch official game stats.
  const universeId = await getUniverseFromPlace(urlId);
  if (universeId) {
    const byUniverse = await getGameByUniverse(universeId);
    if (byUniverse) {
      return {
        ok: byUniverse.isPlayable,
        reason: byUniverse.isPlayable ? 'online' : 'not_playable',
        players: byUniverse.playing,
        name: game.name || byUniverse.name || nameFromLink(game.link),
        placeId: byUniverse.rootPlaceId || urlId,
        universeId
      };
    }
  }

  // Attempt 2: Some Roblox links/API states behave like a universe id. Try it directly.
  const byDirectUniverse = await getGameByUniverse(urlId);
  if (byDirectUniverse) {
    return {
      ok: byDirectUniverse.isPlayable,
      reason: byDirectUniverse.isPlayable ? 'online_direct_universe' : 'not_playable_direct_universe',
      players: byDirectUniverse.playing,
      name: game.name || byDirectUniverse.name || nameFromLink(game.link),
      placeId: byDirectUniverse.rootPlaceId || urlId,
      universeId: urlId
    };
  }

  // Attempt 3: Place details fallback.
  const details = await getPlaceDetails(urlId);
  if (details) {
    return {
      ok: details.isPlayable,
      reason: details.isPlayable ? 'online_place_details' : 'not_playable_place_details',
      players: details.playing,
      name: game.name || details.name || nameFromLink(game.link),
      placeId: details.placeId || urlId,
      universeId: details.universeId || universeId
    };
  }

  return {
    ok: false,
    reason: 'no_api_data',
    players: null,
    name: game.name || nameFromLink(game.link),
    placeId: urlId,
    universeId: universeId || null
  };
}

function buildButtons(game) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel('Join')
      .setStyle(ButtonStyle.Link)
      .setURL(game.link),

    new ButtonBuilder()
      .setLabel('Group')
      .setStyle(ButtonStyle.Link)
      .setURL(GROUP_URL)
  );
}

function buildEmbed(game, status) {
  const playersText = status.players === null || status.players === undefined ? 'checking...' : String(status.players);
  const statusText = status.ok ? 'ONLINE' : `CHECKING (${status.reason})`;
  const title = `🎮 ${status.name || game.name || nameFromLink(game.link)}`;

  const embed = new EmbedBuilder()
    .setColor(status.ok ? 0x6a00ff : 0xffb000)
    .setTitle(title)
    .setDescription('⚠ join group required')
    .addFields(
      { name: '📡 active players', value: playersText, inline: true },
      { name: '🕒 server uptime', value: getUptime(), inline: true },
      { name: '🟢 status', value: statusText, inline: false }
    )
    .setFooter({ text: 'powered by yeti' });

  if (GIF_URL && /^https?:\/\//i.test(GIF_URL)) {
    embed.setImage(GIF_URL);
  }

  return embed;
}

async function postCurrentGame() {
  const game = games[currentIndex];
  startTime = Date.now();
  const status = await getGameStatus(game);

  message = await channel.send({
    embeds: [buildEmbed(game, status)],
    components: [buildButtons(game)]
  });

  console.log(`Posted game ${currentIndex + 1}/${games.length}: ${game.link}`);
}

async function switchToNextGame(reason) {
  console.log(`Switching game. Reason: ${reason}`);

  if (message) {
    await message.delete().catch(() => {});
    message = null;
  }

  currentIndex += 1;
  if (currentIndex >= games.length) {
    currentIndex = 0;
    console.log('Reached end of games.json, looping back to first game.');
  }

  failCounts.clear();
  await sleep(1000);
  await postCurrentGame();
}

async function updateLoop() {
  try {
    const game = games[currentIndex];
    if (!message) {
      await postCurrentGame();
      return;
    }

    const status = await getGameStatus(game);
    const key = game.link;

    console.log(`[check] ${status.name} | ok=${status.ok} | players=${status.players} | reason=${status.reason}`);

    if (!status.ok) {
      const fails = (failCounts.get(key) || 0) + 1;
      failCounts.set(key, fails);
      console.log(`Fail count for current game: ${fails}/${FAILS_BEFORE_SWITCH}`);

      // Edit the message while waiting for enough failed checks, so you can see it is checking.
      await message.edit({
        embeds: [buildEmbed(game, status)],
        components: [buildButtons(game)]
      }).catch(() => {});

      if (fails >= FAILS_BEFORE_SWITCH) {
        await switchToNextGame(status.reason);
      }

      return;
    }

    failCounts.set(key, 0);

    await message.edit({
      embeds: [buildEmbed(game, status)],
      components: [buildButtons(game)]
    });
  } catch (err) {
    console.log('UPDATE ERROR:', err?.response?.data || err.message);
  }
}

client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log(`Loaded ${games.length} game link(s). Checking every ${CHECK_INTERVAL_MS / 1000}s.`);

  channel = await client.channels.fetch(CHANNEL_ID);
  await postCurrentGame();

  setInterval(updateLoop, CHECK_INTERVAL_MS);
});

client.login(DISCORD_TOKEN);
