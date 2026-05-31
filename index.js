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

if (!ROBLOSECURITY) {
  console.warn('WARNING: ROBLOSECURITY is missing. Group/private games may not show active players.');
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
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
    Accept: 'application/json,text/plain,*/*'
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

/* ---------------- COOKIE-BASED PLAYER + GAME CHECKER ---------------- */
async function getPlayers(link) {
  for (let attempt = 1; attempt <= 3; attempt++) {
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

        console.log(
          `[Roblox] placeId=${extractedId} converted to universeId=${universeId}`
        );
      } catch (err) {
        console.log(
          `[Roblox] Universe lookup failed for ${extractedId}. Trying extracted ID directly as universeId. Reason:`,
          err?.response?.status || err.message
        );

        universeId = extractedId;
      }

      if (!universeId) {
        await sleep(1000);
        continue;
      }

      const gameRes = await axios.get(
        `https://games.roblox.com/v1/games?universeIds=${universeId}`,
        config
      );

      const data = gameRes.data?.data?.[0];

      if (!data) {
        console.log(`[Roblox] No game data for universeId=${universeId}`);
        await sleep(1000);
        continue;
      }

      if (data.isPlayable === false) {
        return {
          players: null,
          name: data.name || null,
          isPlayable: false,
          universeId: String(data.id || universeId),
          rootPlaceId: data.rootPlaceId ? String(data.rootPlaceId) : extractedId
        };
      }

      if (data.playing !== undefined) {
        return {
          players: Number(data.playing || 0),
          name: data.name || null,
          isPlayable: true,
          universeId: String(data.id || universeId),
          rootPlaceId: data.rootPlaceId ? String(data.rootPlaceId) : extractedId
        };
      }

      await sleep(1000);
    } catch (err) {
      console.log(
        `[Roblox] getPlayers attempt ${attempt}/3 failed:`,
        err?.response?.status || err.message
      );

      await sleep(1000);
    }
  }

  return null;
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
      `All games for **${state.label}** are banned, deleted, private, or inaccessible.\n\nAdd more games to \`games.json\` and restart the bot.`
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
    console.log(`[${state.label}] Next game is also dead/inaccessible: ${nextGame.link}`);
    await sleep(1000);
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

    if (!playerData || playerData.isPlayable === false) {
      console.log(`[${state.label}] Game banned/deleted/private/inaccessible: ${game.link}`);
      await moveToNextGame(state);
      return;
    }

    if (!state.message) {
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

client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log(`Checking every ${CHECK_INTERVAL_MS / 1000}s.`);
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

    await updateState(state);
  }

  setInterval(() => {
    for (const state of states) {
      updateState(state);
    }
  }, CHECK_INTERVAL_MS);
});

client.login(DISCORD_TOKEN);
