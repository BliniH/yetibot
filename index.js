require('dotenv').config();

const axios = require('axios');
const allGamesRaw = require('./games.json');

const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} = require('discord.js');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CHECK_INTERVAL_MS = Number(process.env.CHECK_INTERVAL_MS || 30000);
const FAILS_BEFORE_SWITCH = Number(process.env.FAILS_BEFORE_SWITCH || 3);

const GIF_URL = (process.env.GIF_URL || process.env.IMAGE_URL || '')
  .trim()
  .replace(/^["']|["']$/g, '');

const ROBLOSECURITY = (process.env.ROBLOSECURITY || '').trim();

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

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

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
  failCounts: new Map(),
  lastGoodPlayers: null,
  exhausted: false,
  isUpdating: false
}));

function robloxHeaders() {
  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    Accept: 'application/json,text/plain,*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: 'https://www.roblox.com/'
  };

  if (
    ROBLOSECURITY &&
    !ROBLOSECURITY.includes('PASTE_YOUR') &&
    !ROBLOSECURITY.includes('optional_only')
  ) {
    headers.Cookie = `.ROBLOSECURITY=${ROBLOSECURITY}`;
  }

  return headers;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, label) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await axios.get(url, {
        headers: robloxHeaders(),
        timeout: 15000,
        validateStatus: (status) => status >= 200 && status < 500
      });

      if (res.status >= 200 && res.status < 300) {
        return res.data;
      }

      console.log(`[Roblox] ${label} returned HTTP ${res.status}`);
    } catch (err) {
      console.log(`[Roblox] ${label} failed:`, err?.response?.status || err.message);
    }

    await sleep(700);
  }

  return null;
}

function extractUrlId(link) {
  const match = link.match(/roblox\.com\/games\/(\d+)/i);
  return match ? match[1] : null;
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

function shouldSwitchGame(status) {
  return [
    'not_playable',
    'not_playable_place_details',
    'bad_link'
  ].includes(status.reason);
}

function cleanNumber(value) {
  const num = Number(value);
  if (Number.isFinite(num)) return num;
  return 0;
}

async function getUniverseFromPlace(placeId) {
  const modernUrl = `https://apis.roblox.com/universes/v1/places/${placeId}/universe`;
  const modernData = await fetchJson(modernUrl, `modern universe lookup ${placeId}`);

  if (modernData?.universeId) {
    return String(modernData.universeId);
  }

  const legacyUrl = `https://api.roblox.com/universes/get-universe-containing-place?placeid=${placeId}`;
  const legacyData = await fetchJson(legacyUrl, `legacy universe lookup ${placeId}`);

  if (legacyData?.UniverseId) {
    return String(legacyData.UniverseId);
  }

  return null;
}

async function getGameByUniverse(universeId) {
  const data = await fetchJson(
    `https://games.roblox.com/v1/games?universeIds=${universeId}`,
    `game lookup universe ${universeId}`
  );

  const game = data?.data?.[0];
  if (!game) return null;

  return {
    ok: game.isPlayable !== false,
    reason: game.isPlayable === false ? 'not_playable' : 'online',
    name: game.name || null,
    players: cleanNumber(game.playing),
    visits: cleanNumber(game.visits),
    rootPlaceId: game.rootPlaceId ? String(game.rootPlaceId) : null,
    universeId: String(game.id || universeId)
  };
}

async function getPlaceDetails(placeId) {
  const endpoints = [
    `https://games.roblox.com/v1/games/multiget-place-details?placeIds=${placeId}`,
    `https://www.roblox.com/games/multiget-place-details?placeIds=${placeId}`
  ];

  for (const url of endpoints) {
    const data = await fetchJson(url, `place details ${placeId}`);
    const detail = Array.isArray(data) ? data[0] : null;

    if (!detail) continue;

    return {
      ok: detail.isPlayable !== false,
      reason:
        detail.isPlayable === false
          ? 'not_playable_place_details'
          : 'online_place_details',
      name: detail.name || detail.Name || null,
      players: cleanNumber(
        detail.playerCount ?? detail.PlayerCount ?? detail.playing
      ),
      placeId: String(detail.placeId || detail.PlaceId || placeId),
      universeId: detail.universeId ? String(detail.universeId) : null
    };
  }

  return null;
}

async function getGameStatus(game) {
  const placeId = extractUrlId(game.link);

  if (!placeId) {
    return {
      ok: false,
      reason: 'bad_link',
      players: 0,
      name: game.name || 'Invalid Roblox Link',
      placeId: null,
      universeId: null
    };
  }

  // First try place details because it can directly return playerCount.
  const details = await getPlaceDetails(placeId);

  if (details && details.ok) {
    return {
      ...details,
      name: game.name || details.name || nameFromLink(game.link),
      placeId: details.placeId || placeId
    };
  }

  if (details && details.reason === 'not_playable_place_details') {
    return {
      ...details,
      name: game.name || details.name || nameFromLink(game.link),
      placeId: details.placeId || placeId
    };
  }

  // Then get universe ID and use the main games API.
  const universeId = details?.universeId || (await getUniverseFromPlace(placeId));

  if (universeId) {
    const byUniverse = await getGameByUniverse(universeId);

    if (byUniverse) {
      return {
        ...byUniverse,
        name: game.name || byUniverse.name || details?.name || nameFromLink(game.link),
        placeId: byUniverse.rootPlaceId || placeId,
        universeId
      };
    }
  }

  // Sometimes the URL ID may already be a universe ID.
  const directUniverse = await getGameByUniverse(placeId);

  if (directUniverse) {
    return {
      ...directUniverse,
      reason: directUniverse.ok
        ? 'online_direct_universe'
        : directUniverse.reason,
      name: game.name || directUniverse.name || nameFromLink(game.link),
      placeId: directUniverse.rootPlaceId || placeId,
      universeId: placeId
    };
  }

  // Do not treat this as dead. This means Roblox gave no usable data.
  return {
    ok: false,
    reason: 'no_api_data',
    players: null,
    name: game.name || details?.name || nameFromLink(game.link),
    placeId,
    universeId: universeId || null
  };
}

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

function buildEmbed(state, game, status) {
  let playersText = '0';

  if (status.players !== null && status.players !== undefined) {
    playersText = String(status.players);
  } else if (state.lastGoodPlayers !== null && state.lastGoodPlayers !== undefined) {
    playersText = String(state.lastGoodPlayers);
  }

  const embed = new EmbedBuilder()
    .setColor(0x2b2d31)
    .setTitle(`🎮 ${status.name || nameFromLink(game.link)}`)
    .addFields(
      {
        name: '📡 active players',
        value: playersText,
        inline: true
      },
      {
        name: '🕒 server uptime',
        value: getUptime(state),
        inline: true
      },
      {
        name: '⚠️ join group',
        value: 'you must join group or you cant access game!',
        inline: false
      }
    )
    .setFooter({ text: 'powered by yeti' });

  if (GIF_URL && /^https?:\/\//i.test(GIF_URL)) {
    embed.setImage(GIF_URL);
  } else if (GIF_URL) {
    console.log(`[GIF ERROR] Invalid GIF_URL: ${GIF_URL}`);
  }

  return embed;
}

function buildNoGamesEmbed(state, reason) {
  return new EmbedBuilder()
    .setColor(0xff0000)
    .setTitle('⚠ No working games left')
    .setDescription(
      `All games for **${state.label}** have failed real checks.\n\nLast reason: \`${reason}\`\n\nAdd more games to \`games.json\` and restart the bot.`
    )
    .setFooter({ text: 'powered by yeti' });
}

async function postCurrentGame(state) {
  if (state.exhausted) return;

  const game = state.games[state.currentIndex];

  if (!game) {
    state.exhausted = true;

    state.message = await state.channel.send({
      embeds: [buildNoGamesEmbed(state, 'missing_game')]
    });

    return;
  }

  state.startTime = Date.now();
  state.lastGoodPlayers = null;

  const status = await getGameStatus(game);

  if (status.players !== null && status.players !== undefined) {
    state.lastGoodPlayers = status.players;
  }

  state.message = await state.channel.send({
    embeds: [buildEmbed(state, game, status)],
    components: [buildButtons(state, game)]
  });

  console.log(
    `[${state.label}] Posted game ${state.currentIndex + 1}/${state.games.length}: ${game.link}`
  );
}

async function stopChannelBecauseNoGamesLeft(state, reason) {
  console.log(`[${state.label}] No more games left. Stopping this channel.`);

  state.exhausted = true;
  state.failCounts.clear();

  if (state.message) {
    await state.message.delete().catch(() => {});
    state.message = null;
  }

  state.message = await state.channel.send({
    embeds: [buildNoGamesEmbed(state, reason)]
  });
}

async function switchToNextGame(state, reason) {
  console.log(`[${state.label}] Switching game. Reason: ${reason}`);

  if (state.message) {
    await state.message.delete().catch(() => {});
    state.message = null;
  }

  state.currentIndex += 1;

  if (state.currentIndex >= state.games.length) {
    await stopChannelBecauseNoGamesLeft(state, reason);
    return;
  }

  state.failCounts.clear();

  await sleep(1000);
  await postCurrentGame(state);
}

async function updateState(state) {
  if (state.isUpdating) {
    console.log(`[${state.label}] Skipping check because previous check is still running.`);
    return;
  }

  state.isUpdating = true;

  try {
    if (!state.games.length) return;
    if (state.exhausted) return;

    if (state.currentIndex >= state.games.length) {
      await stopChannelBecauseNoGamesLeft(state, 'index_out_of_range');
      return;
    }

    if (!state.message) {
      await postCurrentGame(state);
      return;
    }

    const game = state.games[state.currentIndex];

    if (!game) {
      await stopChannelBecauseNoGamesLeft(state, 'missing_game');
      return;
    }

    const status = await getGameStatus(game);
    const key = game.link;

    console.log(
      `[${state.label}] [check] ${status.name} | ok=${status.ok} | players=${status.players} | reason=${status.reason}`
    );

    if (status.players !== null && status.players !== undefined) {
      state.lastGoodPlayers = status.players;
    }

    await state.message
      .edit({
        embeds: [buildEmbed(state, game, status)],
        components: [buildButtons(state, game)]
      })
      .catch(async () => {
        console.log(`[${state.label}] Message edit failed. Reposting current game.`);
        state.message = null;
        await postCurrentGame(state);
      });

    if (!status.ok) {
      if (!shouldSwitchGame(status)) {
        console.log(
          `[${state.label}] Not switching. "${status.reason}" is not confirmed dead.`
        );
        return;
      }

      const fails = (state.failCounts.get(key) || 0) + 1;
      state.failCounts.set(key, fails);

      console.log(
        `[${state.label}] Real fail count: ${fails}/${FAILS_BEFORE_SWITCH}`
      );

      if (fails >= FAILS_BEFORE_SWITCH) {
        await switchToNextGame(state, status.reason);
      }

      return;
    }

    state.failCounts.set(key, 0);
  } catch (err) {
    console.log(
      `[${state.label}] UPDATE ERROR:`,
      err?.response?.data || err.message
    );
  } finally {
    state.isUpdating = false;
  }
}

client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log(
    `Checking every ${CHECK_INTERVAL_MS / 1000}s. Fails before switch: ${FAILS_BEFORE_SWITCH}.`
  );
  console.log(`GIF_URL loaded: ${GIF_URL || 'none'}`);

  for (const state of states) {
    if (!state.games.length) {
      console.log(
        `[${state.label}] No valid games found in games.json for channel ${state.id}.`
      );
      continue;
    }

    state.channel = await client.channels.fetch(state.channelId);
    await postCurrentGame(state);
  }

  setInterval(() => {
    for (const state of states) {
      updateState(state);
    }
  }, CHECK_INTERVAL_MS);
});

client.login(DISCORD_TOKEN);
