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
const GIF_URL = (process.env.GIF_URL || '').trim().replace(/^["']|["']$/g, '');
const ROBLOSECURITY = process.env.ROBLOSECURITY || '';

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
  console.error('Missing DISCORD_TOKEN, CHANNEL_1_ID, or CHANNEL_2_ID in .env');
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

  // NEW: stops the channel once every game has failed
  exhausted: false
}));

function robloxHeaders() {
  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 YetiBot/1.0',
    Accept: 'application/json,text/plain,*/*'
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

async function getUniverseFromPlace(placeId) {
  try {
    const res = await axios.get(
      `https://apis.roblox.com/universes/v1/places/${placeId}/universe`,
      {
        headers: robloxHeaders(),
        timeout: 12000
      }
    );

    return res.data?.universeId ? String(res.data.universeId) : null;
  } catch (err) {
    return null;
  }
}

async function getGameByUniverse(universeId) {
  try {
    const res = await axios.get(
      `https://games.roblox.com/v1/games?universeIds=${universeId}`,
      {
        headers: robloxHeaders(),
        timeout: 12000
      }
    );

    const data = res.data?.data?.[0];
    if (!data) return null;

    return {
      ok: data.isPlayable !== false,
      reason: data.isPlayable === false ? 'not_playable' : 'online',
      name: data.name || null,
      players: Number(data.playing || 0),
      visits: Number(data.visits || 0),
      rootPlaceId: data.rootPlaceId ? String(data.rootPlaceId) : null,
      universeId: String(data.id || universeId)
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
      const res = await axios.get(url, {
        headers: robloxHeaders(),
        timeout: 12000
      });

      const data = Array.isArray(res.data) ? res.data[0] : null;
      if (!data) continue;

      return {
        ok: data.isPlayable !== false,
        reason:
          data.isPlayable === false
            ? 'not_playable_place_details'
            : 'online_place_details',
        name: data.name || data.Name || null,
        players: Number(
          data.playerCount ?? data.PlayerCount ?? data.playing ?? 0
        ),
        placeId: String(data.placeId || data.PlaceId || placeId),
        universeId: data.universeId ? String(data.universeId) : null
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
    return {
      ok: false,
      reason: 'bad_link',
      players: null,
      name: game.name || 'Invalid Roblox Link'
    };
  }

  // Method 1: URL ID as placeId -> universeId -> game stats
  const universeId = await getUniverseFromPlace(urlId);

  if (universeId) {
    const byUniverse = await getGameByUniverse(universeId);

    if (byUniverse) {
      return {
        ...byUniverse,
        name: game.name || byUniverse.name || nameFromLink(game.link),
        placeId: byUniverse.rootPlaceId || urlId,
        universeId
      };
    }
  }

  // Method 2: URL ID as universeId directly
  const byDirectUniverse = await getGameByUniverse(urlId);

  if (byDirectUniverse) {
    return {
      ...byDirectUniverse,
      reason: byDirectUniverse.ok
        ? 'online_direct_universe'
        : byDirectUniverse.reason,
      name: game.name || byDirectUniverse.name || nameFromLink(game.link),
      placeId: byDirectUniverse.rootPlaceId || urlId,
      universeId: urlId
    };
  }

  // Method 3: place details fallback
  const details = await getPlaceDetails(urlId);

  if (details) {
    return {
      ...details,
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
  const playersText =
    status.players === null || status.players === undefined
      ? 'checking...'
      : String(status.players);

  const statusText = status.ok ? 'ONLINE' : `CHECKING (${status.reason})`;

  const embed = new EmbedBuilder()
    .setColor(status.ok ? 0x6a00ff : 0xffb000)
    .setTitle(`🎮 ${status.name || nameFromLink(game.link)}`)
    .setDescription(`⚠ join group required\n${state.label}`)
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
        name: '🟢 status',
        value: statusText,
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
    .setTitle(`⚠ No working games left`)
    .setDescription(
      `All games for **${state.label}** have failed checks.\n\nLast reason: \`${reason}\`\n\nAdd more games to \`games.json\` and restart the bot.`
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

  if (status.ok && status.players !== null && status.players !== undefined) {
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

  // FIXED:
  // Old code looped back to 0 here.
  // New code stops this channel when the final game also fails.
  if (state.currentIndex >= state.games.length) {
    await stopChannelBecauseNoGamesLeft(state, reason);
    return;
  }

  state.failCounts.clear();

  await sleep(1000);
  await postCurrentGame(state);
}

async function updateState(state) {
  try {
    if (!state.games.length) return;

    // NEW: once all games failed, stop checking/posting this channel
    if (state.exhausted) return;

    // NEW: extra protection so it never reads past the games list
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

    if (!status.ok) {
      const fails = (state.failCounts.get(key) || 0) + 1;
      state.failCounts.set(key, fails);

      console.log(
        `[${state.label}] Fail count: ${fails}/${FAILS_BEFORE_SWITCH}`
      );

      await state.message
        .edit({
          embeds: [buildEmbed(state, game, status)],
          components: [buildButtons(state, game)]
        })
        .catch(() => {});

      if (fails >= FAILS_BEFORE_SWITCH) {
        await switchToNextGame(state, status.reason);
      }

      return;
    }

    state.failCounts.set(key, 0);
    state.lastGoodPlayers = status.players;

    await state.message.edit({
      embeds: [buildEmbed(state, game, status)],
      components: [buildButtons(state, game)]
    });
  } catch (err) {
    console.log(
      `[${state.label}] UPDATE ERROR:`,
      err?.response?.data || err.message
    );
  }
}

client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log(
    `Checking every ${CHECK_INTERVAL_MS / 1000}s. Fails before switch: ${FAILS_BEFORE_SWITCH}.`
  );

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
