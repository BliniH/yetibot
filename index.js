require('dotenv').config();

const axios = require('axios');
const allGamesRaw = require('./games.json');

const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  AttachmentBuilder
} = require('discord.js');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CHECK_INTERVAL_MS = Number(process.env.CHECK_INTERVAL_MS || 30000);
const FAILS_BEFORE_SWITCH = Number(process.env.FAILS_BEFORE_SWITCH || 3);
const GIF_URL = (process.env.GIF_URL || '').trim().replace(/^["']|["']$/g, '');

function cleanRoblosecurity(value) {
  let cookie = (value || '').trim();
  cookie = cookie.replace(/^["']|["']$/g, '');

  if (cookie.startsWith('.ROBLOSECURITY=')) {
    cookie = cookie.slice('.ROBLOSECURITY='.length);
  }

  return cookie;
}

const ROBLOSECURITY = cleanRoblosecurity(process.env.ROBLOSECURITY);

const CHANNEL_CONFIGS = [
  {
    id: 1,
    label: 'Scriptbloxian Studios',
    channelId: process.env.CHANNEL_1_ID,
    groupUrl:
      process.env.SCRIPTBLOXIAN_GROUP ||
      'https://www.roblox.com/communities/4705120/Scriptbloxian-Studios#!/about'
  },
  {
    id: 2,
    label: 'CRIMCORP',
    channelId: process.env.CHANNEL_2_ID,
    groupUrl:
      process.env.CRIMCORP_GROUP ||
      'https://www.roblox.com/communities/4165692/CRIMCORP#!/about'
  }
];

if (!DISCORD_TOKEN || !process.env.CHANNEL_1_ID || !process.env.CHANNEL_2_ID) {
  console.error('Missing DISCORD_TOKEN, CHANNEL_1_ID, or CHANNEL_2_ID in Railway variables.');
  process.exit(1);
}

if (!ROBLOSECURITY) {
  console.warn('WARNING: ROBLOSECURITY is missing. Group games may not check correctly.');
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

let cachedGifBuffer = null;
let gifDownloadFailed = false;

function normalizeGames(raw) {
  return raw
    .map((item) => (typeof item === 'string' ? { link: item } : item))
    .filter(
      (game) =>
        game &&
        typeof game.link === 'string' &&
        /roblox\.com\/games\//i.test(game.link)
    );
}

const states = CHANNEL_CONFIGS.map((config) => ({
  ...config,
  channel: null,
  message: null,
  games: normalizeGames(
    allGamesRaw.filter((game) => Number(game.channel) === config.id)
  ),
  currentIndex: 0,
  startTime: Date.now(),
  exhausted: false,
  isUpdating: false,
  failCount: 0,
  lastPlayerData: null,
  gifAttached: false
}));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getUptime(state) {
  const sec = Math.floor((Date.now() - state.startTime) / 1000);
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;

  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return `${m}m ${s}s`;
}

function extractIdFromLink(link) {
  const match = link.match(/\d+/);
  return match ? match[0] : null;
}

function nameFromLink(link) {
  const slug = link
    .split('/games/')[1]
    ?.split('/')[1]
    ?.split('?')[0]
    ?.split('#')[0];

  if (!slug) return 'Roblox Game';

  return decodeURIComponent(slug).replace(/-/g, ' ');
}

function getRobloxConfig() {
  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Accept: 'application/json,text/plain,*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: 'https://www.roblox.com/'
  };

  if (ROBLOSECURITY) {
    headers.Cookie = `.ROBLOSECURITY=${ROBLOSECURITY}`;
  }

  return {
    headers,
    timeout: 15000,
    validateStatus: (status) => status >= 200 && status < 500
  };
}

function getImageConfig() {
  return {
    responseType: 'arraybuffer',
    timeout: 20000,
    maxContentLength: 25 * 1024 * 1024,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
      Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
    }
  };
}

async function getGifAttachment() {
  if (!GIF_URL || gifDownloadFailed) return null;

  try {
    if (!cachedGifBuffer) {
      console.log(`[GIF] Downloading GIF from: ${GIF_URL}`);

      const res = await axios.get(GIF_URL, getImageConfig());

      cachedGifBuffer = Buffer.from(res.data);
      console.log(`[GIF] Loaded GIF. Size: ${cachedGifBuffer.length} bytes`);
    }

    return new AttachmentBuilder(Buffer.from(cachedGifBuffer), {
      name: 'yeti.gif'
    });
  } catch (err) {
    gifDownloadFailed = true;
    console.log('[GIF ERROR] Could not download GIF:', err?.response?.status || err.message);
    return null;
  }
}

/* ---------------- ROBLOX CHECKER ---------------- */

async function getUniverseId(placeId) {
  const config = getRobloxConfig();

  const res = await axios.get(
    `https://apis.roblox.com/universes/v1/places/${placeId}/universe`,
    config
  );

  if (res.status >= 400) {
    console.log(`[Roblox] Universe lookup HTTP ${res.status} for placeId=${placeId}`);
    return null;
  }

  return res.data?.universeId ? String(res.data.universeId) : null;
}

async function getGameData(universeId) {
  const config = getRobloxConfig();

  const res = await axios.get(
    `https://games.roblox.com/v1/games?universeIds=${universeId}`,
    config
  );

  if (res.status >= 400) {
    console.log(`[Roblox] Game lookup HTTP ${res.status} for universeId=${universeId}`);
    return null;
  }

  return res.data?.data?.[0] || null;
}

async function getPlaceDetails(placeId) {
  const config = getRobloxConfig();

  const urls = [
    `https://games.roblox.com/v1/games/multiget-place-details?placeIds=${placeId}`,
    `https://www.roblox.com/games/multiget-place-details?placeIds=${placeId}`
  ];

  for (const url of urls) {
    try {
      const res = await axios.get(url, config);

      if (res.status >= 400) {
        console.log(`[Roblox] Place details HTTP ${res.status} for placeId=${placeId}`);
        continue;
      }

      const data = Array.isArray(res.data) ? res.data[0] : null;
      if (data) return data;
    } catch (err) {
      console.log('[Roblox] Place details error:', err?.response?.status || err.message);
    }
  }

  return null;
}

async function checkGame(link) {
  const placeId = extractIdFromLink(link);

  if (!placeId) {
    return {
      ok: false,
      reason: 'bad_link',
      players: null,
      name: 'Invalid Roblox Link',
      placeId: null,
      universeId: null
    };
  }

  try {
    const details = await getPlaceDetails(placeId);

    if (details?.isPlayable === false) {
      return {
        ok: false,
        reason: 'not_playable_place_details',
        players: null,
        name: details.name || details.Name || nameFromLink(link),
        placeId,
        universeId: details.universeId ? String(details.universeId) : null
      };
    }

    let universeId = details?.universeId ? String(details.universeId) : null;

    if (!universeId) {
      universeId = await getUniverseId(placeId);
    }

    console.log(`[Roblox] placeId=${placeId} universeId=${universeId || 'null'}`);

    if (!universeId) {
      return {
        ok: false,
        reason: 'no_universe_id',
        players: null,
        name: details?.name || details?.Name || nameFromLink(link),
        placeId,
        universeId: null
      };
    }

    const data = await getGameData(universeId);

    if (!data) {
      return {
        ok: false,
        reason: 'no_game_data',
        players: null,
        name: details?.name || details?.Name || nameFromLink(link),
        placeId,
        universeId
      };
    }

    if (data.isPlayable === false) {
      return {
        ok: false,
        reason: 'not_playable',
        players: null,
        name: data.name || details?.name || nameFromLink(link),
        placeId: data.rootPlaceId ? String(data.rootPlaceId) : placeId,
        universeId: String(data.id || universeId)
      };
    }

    if (data.playing === undefined || data.playing === null) {
      return {
        ok: false,
        reason: 'no_playing_field',
        players: null,
        name: data.name || details?.name || nameFromLink(link),
        placeId: data.rootPlaceId ? String(data.rootPlaceId) : placeId,
        universeId: String(data.id || universeId)
      };
    }

    return {
      ok: true,
      reason: 'online',
      players: Number(data.playing || 0),
      name: data.name || details?.name || nameFromLink(link),
      placeId: data.rootPlaceId ? String(data.rootPlaceId) : placeId,
      universeId: String(data.id || universeId)
    };
  } catch (err) {
    console.log('[Roblox] checkGame error:', err?.response?.status || err.message);

    return {
      ok: false,
      reason: err?.response?.status ? `api_error_${err.response.status}` : 'api_error',
      players: null,
      name: nameFromLink(link),
      placeId,
      universeId: null
    };
  }
}

async function testGame(game, state, mode) {
  for (let attempt = 1; attempt <= FAILS_BEFORE_SWITCH; attempt++) {
    const result = await checkGame(game.link);

    console.log(
      `[${state.label}] ${mode} test ${attempt}/${FAILS_BEFORE_SWITCH} | ${game.link} | ok=${result.ok} | players=${result.players ?? 'null'} | reason=${result.reason} | universeId=${result.universeId ?? 'null'}`
    );

    if (result.ok) {
      return result;
    }

    await sleep(1000);
  }

  return null;
}

/* ---------------- DISCORD ---------------- */

function buildButtons(state, game) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel('Join')
      .setStyle(ButtonStyle.Link)
      .setURL(game.link),

    new ButtonBuilder()
      .setLabel('Group')
      .setStyle(ButtonStyle.Link)
      .setURL(state.groupUrl)
  );
}

function buildEmbed(state, game, playerData) {
  const usableData = playerData || state.lastPlayerData;

  const players =
    usableData && usableData.players !== null && usableData.players !== undefined
      ? usableData.players
      : 'N/A';

  const gameName =
    usableData?.name ||
    game.name ||
    nameFromLink(game.link);

  const embed = new EmbedBuilder()
    .setColor(0x2b2d31)
    .setTitle(`🎮 ${gameName}`)
    .setDescription(
      `⚠️ **join group**\nyou must join group or you cant access game!\n[Click here to join the Group](${state.groupUrl})`
    )
    .addFields(
      {
        name: '((•)) active players',
        value: `\`${players}\``,
        inline: true
      },
      {
        name: '🕒 server uptime',
        value: `\`${getUptime(state)}\``,
        inline: true
      }
    )
    .setFooter({ text: 'powered by yeti' });

  if (state.gifAttached) {
    embed.setImage('attachment://yeti.gif');
  } else if (GIF_URL && /^https?:\/\//i.test(GIF_URL)) {
    embed.setImage(GIF_URL);
  }

  return embed;
}

function buildNoGamesEmbed(state) {
  return new EmbedBuilder()
    .setColor(0xff0000)
    .setTitle('⚠ No working games left')
    .setDescription(
      `No games passed the active-player check for **${state.label}**.\n\nCheck Railway logs. If games are up, your \`ROBLOSECURITY\` may be expired/wrong or the account may not have access.`
    )
    .setFooter({ text: 'powered by yeti' });
}

async function sendGameMessage(state, game, playerData) {
  const gifAttachment = await getGifAttachment();
  state.gifAttached = Boolean(gifAttachment);

  const payload = {
    embeds: [buildEmbed(state, game, playerData)],
    components: [buildButtons(state, game)]
  };

  if (gifAttachment) {
    payload.files = [gifAttachment];
  }

  state.message = await state.channel.send(payload);
}

async function editGameMessage(state, game, playerData) {
  await state.message.edit({
    embeds: [buildEmbed(state, game, playerData)],
    components: [buildButtons(state, game)]
  });
}

/* ---------------- GAME FLOW ---------------- */

async function stopChannel(state) {
  state.exhausted = true;

  if (state.message) {
    await state.message.delete().catch(() => {});
    state.message = null;
  }

  state.message = await state.channel.send({
    embeds: [buildNoGamesEmbed(state)]
  });
}

async function findAndPostNextWorkingGame(state) {
  if (state.message) {
    await state.message.delete().catch(() => {});
    state.message = null;
  }

  state.failCount = 0;
  state.lastPlayerData = null;

  while (state.currentIndex < state.games.length) {
    const game = state.games[state.currentIndex];

    console.log(
      `[${state.label}] Checking game BEFORE posting ${state.currentIndex + 1}/${state.games.length}: ${game.link}`
    );

    const result = await testGame(game, state, 'pre-post');

    if (result) {
      state.startTime = Date.now();
      state.lastPlayerData = result;
      state.failCount = 0;

      await sendGameMessage(state, game, result);

      console.log(
        `[${state.label}] Posted working game ${state.currentIndex + 1}/${state.games.length}: ${game.link}`
      );

      return;
    }

    console.log(
      `[${state.label}] Skipping game because active-player check failed ${FAILS_BEFORE_SWITCH} times: ${game.link}`
    );

    state.currentIndex += 1;
    await sleep(1000);
  }

  console.log(`[${state.label}] No games passed checks.`);
  await stopChannel(state);
}

async function updateState(state) {
  if (state.isUpdating) {
    console.log(`[${state.label}] Skipping check because previous check is still running.`);
    return;
  }

  state.isUpdating = true;

  try {
    if (!state.channel || !state.games.length) return;
    if (state.exhausted) return;

    if (state.currentIndex >= state.games.length) {
      await stopChannel(state);
      return;
    }

    if (!state.message) {
      await findAndPostNextWorkingGame(state);
      return;
    }

    const game = state.games[state.currentIndex];
    const result = await checkGame(game.link);

    console.log(
      `[${state.label}] Live check | ${game.link} | ok=${result.ok} | players=${result.players ?? 'null'} | fails=${state.failCount}/${FAILS_BEFORE_SWITCH} | reason=${result.reason} | universeId=${result.universeId ?? 'null'}`
    );

    if (result.ok) {
      state.failCount = 0;
      state.lastPlayerData = result;

      await editGameMessage(state, game, result);
      return;
    }

    state.failCount += 1;

    console.log(
      `[${state.label}] Current game failed check ${state.failCount}/${FAILS_BEFORE_SWITCH}: ${game.link}`
    );

    if (state.failCount >= FAILS_BEFORE_SWITCH) {
      console.log(`[${state.label}] Deleting failed game and moving next: ${game.link}`);

      state.currentIndex += 1;
      await findAndPostNextWorkingGame(state);
      return;
    }

    if (state.lastPlayerData) {
      await editGameMessage(state, game, state.lastPlayerData);
    }
  } catch (err) {
    console.log(`[${state.label}] UPDATE ERROR:`, err?.response?.data || err.message);
  } finally {
    state.isUpdating = false;
  }
}

/* ---------------- BOT READY ---------------- */

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log(`Checking every ${CHECK_INTERVAL_MS / 1000}s.`);
  console.log(`Tests before posting / switching: ${FAILS_BEFORE_SWITCH}`);
  console.log(`GIF_URL loaded: ${GIF_URL || 'none'}`);
  console.log(`ROBLOSECURITY loaded: ${ROBLOSECURITY ? 'yes' : 'no'}`);

  for (const state of states) {
    if (!state.games.length) {
      console.log(`[${state.label}] No valid games found in games.json for channel ${state.id}.`);
      continue;
    }

    state.channel = await client.channels.fetch(state.channelId).catch(() => null);

    if (!state.channel) {
      console.log(`[${state.label}] Failed to fetch Discord channel.`);
      continue;
    }

    await findAndPostNextWorkingGame(state);
  }

  setInterval(() => {
    for (const state of states) {
      updateState(state);
    }
  }, CHECK_INTERVAL_MS);
});

client.login(DISCORD_TOKEN);
