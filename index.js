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
const GIF_URL = (process.env.GIF_URL || '').trim().replace(/^["']|["']$/g, '');
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
  exhausted: false,
  isUpdating: false
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
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36'
  };

  if (
    ROBLOSECURITY &&
    !ROBLOSECURITY.includes('PASTE_YOUR') &&
    !ROBLOSECURITY.includes('optional_only')
  ) {
    headers.Cookie = `.ROBLOSECURITY=${ROBLOSECURITY}`;
  }

  return {
    headers,
    timeout: 15000
  };
}

/* ---------------- WORKING PLAYER FETCHER ---------------- */
async function getPlayers(link) {
  try {
    const match = link.match(/\d+/);
    if (!match) return null;

    const extractedId = match[0];
    const config = getRobloxConfig();

    let universeId = null;

    try {
      const uniRes = await axios.get(
        `https://apis.roblox.com/universes/v1/places/${extractedId}/universe`,
        config
      );

      universeId = uniRes.data?.universeId;
    } catch (err) {
      console.log(
        `[Roblox] Universe lookup failed for ${extractedId}. Trying ID directly as universeId.`
      );

      universeId = extractedId;
    }

    if (universeId) {
      const gameRes = await axios.get(
        `https://games.roblox.com/v1/games?universeIds=${universeId}`,
        config
      );

      const data = gameRes.data?.data?.[0];

      if (data && data.playing !== undefined) {
        return {
          players: Number(data.playing || 0),
          name: data.name || null,
          isPlayable: data.isPlayable !== false,
          universeId: String(data.id || universeId),
          rootPlaceId: data.rootPlaceId ? String(data.rootPlaceId) : extractedId
        };
      }
    }

    return null;
  } catch (err) {
    console.log('[Roblox] getPlayers error:', err?.response?.status || err.message);
    return null;
  }
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

function buildEmbed(state, game, playerData) {
  const players =
    playerData && playerData.players !== null && playerData.players !== undefined
      ? playerData.players
      : 'N/A';

  const gameName =
    playerData?.name ||
    game.name ||
    nameFromLink(game.link);

  const embed = new EmbedBuilder()
    .setColor(0x2b2d31)
    .setTitle(`🎮 ${gameName}`)
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
  }

  return embed;
}

function buildNoGamesEmbed(state) {
  return new EmbedBuilder()
    .setColor(0xff0000)
    .setTitle('⚠ No working games left')
    .setDescription(
      `All games for **${state.label}** are dead, banned, deleted, or inaccessible.\n\nAdd more games to \`games.json\` and restart the bot.`
    )
    .setFooter({ text: 'powered by yeti' });
}

async function postGame(state, game, playerData) {
  state.message = await state.channel.send({
    embeds: [buildEmbed(state, game, playerData)],
    components: [buildButtons(state, game)]
  });
}

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

async function moveToNextGame(state) {
  console.log(`[${state.label}] Moving to next game.`);

  if (state.message) {
    await state.message.delete().catch(() => {});
    state.message = null;
  }

  state.currentIndex += 1;

  if (state.currentIndex >= state.games.length) {
    console.log(`[${state.label}] Reached end of games list.`);
    await stopChannel(state);
    return;
  }

  state.startTime = Date.now();

  const nextGame = state.games[state.currentIndex];
  const nextPlayers = await getPlayers(nextGame.link);

  if (!nextPlayers || nextPlayers.isPlayable === false) {
    console.log(`[${state.label}] Next game is also dead: ${nextGame.link}`);
    await moveToNextGame(state);
    return;
  }

  await postGame(state, nextGame, nextPlayers);

  console.log(
    `[${state.label}] Posted next game ${state.currentIndex + 1}/${state.games.length}: ${nextGame.link}`
  );
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

    const game = state.games[state.currentIndex];
    const playerData = await getPlayers(game.link);

    console.log(
      `[${state.label}] [check] ${game.link} | players=${playerData?.players ?? 'null'} | playable=${playerData?.isPlayable ?? 'unknown'} | universeId=${playerData?.universeId ?? 'null'}`
    );

    // dead / banned / deleted / private / inaccessible
    if (!playerData || playerData.isPlayable === false) {
      console.log(`[${state.label}] Game dead or inaccessible: ${game.link}`);
      await moveToNextGame(state);
      return;
    }

    if (!messageExists(state)) {
      state.startTime = Date.now();

      await postGame(state, game, playerData);

      console.log(
        `[${state.label}] Posted game ${state.currentIndex + 1}/${state.games.length}: ${game.link}`
      );

      return;
    }

    await state.message.edit({
      embeds: [buildEmbed(state, game, playerData)],
      components: [buildButtons(state, game)]
    });
  } catch (err) {
    console.log(`[${state.label}] UPDATE ERROR:`, err?.response?.data || err.message);
  } finally {
    state.isUpdating = false;
  }
}

function messageExists(state) {
  return Boolean(state.message);
}

client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log(`Checking every ${CHECK_INTERVAL_MS / 1000}s.`);
  console.log(`GIF_URL loaded: ${GIF_URL || 'none'}`);

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

    await updateState(state);
  }

  setInterval(() => {
    for (const state of states) {
      updateState(state);
    }
  }, CHECK_INTERVAL_MS);
});

client.login(DISCORD_TOKEN);
