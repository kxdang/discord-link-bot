const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ChannelType,
  PermissionFlagsBits,
} = require('discord.js');
const path = require('path');

// Load .env.local
require('dotenv').config({ path: path.resolve(__dirname, '.env.local') });

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;

// Channel IDs — leave blank to auto-create
let YOUTUBE_CHANNEL_ID = process.env.YOUTUBE_CHANNEL_ID || '';
let STEAM_CHANNEL_ID = process.env.STEAM_CHANNEL_ID || '';
let LINKS_CHANNEL_ID = process.env.LINKS_CHANNEL_ID || '';

// Backfill cutoff: January 1, 2026
const BACKFILL_AFTER = new Date('2026-01-01T00:00:00Z');

// Regex patterns
const URL_REGEX = /https?:\/\/[^\s<>"{}|\\^`[\]]+/gi;
const YOUTUBE_REGEX = /https?:\/\/(www\.)?(youtube\.com|youtu\.be|m\.youtube\.com)(\/\S*)?/i;
const STEAM_REGEX = /https?:\/\/(store\.steampowered\.com)(\/\S*)?/i;

// Category config
const CATEGORIES = {
  youtube: {
    regex: YOUTUBE_REGEX,
    color: 0xff0000,
    icon: '📺',
    title: 'YouTube Link',
    channelName: 'youtube',
    topic: '📺 YouTube links only — create a thread under any link to discuss it!',
  },
  steam: {
    regex: STEAM_REGEX,
    color: 0x1b2838,
    icon: '🎮',
    title: 'Steam Store Link',
    channelName: 'games',
    topic: '🎮 Steam links only — create a thread under any link to discuss it!',
  },
  other: {
    regex: null,
    color: 0x3498db,
    icon: '🔗',
    title: 'Links',
    channelName: 'links-channel',
    topic: '🔗 Links only — create a thread under any link to discuss it!',
  },
};

// Destination channel cache (category → channel object)
const destinationChannels = {
  youtube: null,
  steam: null,
  other: null,
};

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel],
});

// ─── Helpers ──────────────────────────────────────────────────────────────

function categorizeUrl(url) {
  if (YOUTUBE_REGEX.test(url)) return 'youtube';
  if (STEAM_REGEX.test(url)) return 'steam';
  return 'other';
}

function getDestinationId(category) {
  switch (category) {
    case 'youtube': return YOUTUBE_CHANNEL_ID;
    case 'steam':   return STEAM_CHANNEL_ID;
    case 'other':   return LINKS_CHANNEL_ID;
  }
}

function isDestinationChannel(channelId) {
  return [YOUTUBE_CHANNEL_ID, STEAM_CHANNEL_ID, LINKS_CHANNEL_ID].includes(channelId);
}

function updateEnvId(category, id) {
  switch (category) {
    case 'youtube': YOUTUBE_CHANNEL_ID = id; break;
    case 'steam':   STEAM_CHANNEL_ID = id; break;
    case 'other':   LINKS_CHANNEL_ID = id; break;
  }
}

/**
 * Build a link embed attributed to the original user.
 */
function buildLinkEmbed(category, urls, user, sourceChannel, timestamp) {
  const config = CATEGORIES[category];
  return new EmbedBuilder()
    .setColor(config.color)
    .setAuthor({
      name: user.displayName || user.username,
      iconURL: user.displayAvatarURL({ dynamic: true, size: 64 }),
    })
    .setTitle(`${config.icon} ${config.title}`)
    .setDescription(
      urls.map((url) => url).join('\n') +
      `\n\n**Posted by:** <@${user.id}>` +
      (sourceChannel ? `\n**From:** <#${sourceChannel.id}>` : '') +
      (timestamp ? `\n**Original date:** <t:${Math.floor(timestamp.getTime() / 1000)}:f>` : '')
    )
    .setFooter({ text: '💬 Create a thread on this message to discuss!' })
    .setThumbnail(user.displayAvatarURL({ dynamic: true, size: 128 }))
    .setTimestamp(timestamp || new Date());
}

/**
 * Find the most recent bot link embed in a channel and get or create a thread on it.
 * Returns the thread, or null if no link embeds exist.
 */
async function getOrCreateLatestThread(channel) {
  // Fetch recent messages to find the latest bot embed
  const recentMessages = await channel.messages.fetch({ limit: 50 });
  const latestEmbed = recentMessages.find(
    (msg) => msg.author.id === client.user.id && msg.embeds.length > 0
  );

  if (!latestEmbed) return null;

  // Check if a thread already exists on this message
  if (latestEmbed.hasThread) {
    try {
      const existingThread = await latestEmbed.thread?.fetch();
      if (existingThread && !existingThread.archived) return existingThread;
      // If archived, unarchive it
      if (existingThread && existingThread.archived) {
        await existingThread.setArchived(false);
        return existingThread;
      }
    } catch (err) {
      // Thread might have been deleted, create a new one
    }
  }

  // Extract a short name from the embed for the thread title
  const embedTitle = latestEmbed.embeds[0]?.title || 'Link Discussion';
  const embedUrl = latestEmbed.embeds[0]?.description?.split('\n')[0] || '';
  // Clean up the URL for a thread name (Discord has 100 char limit)
  let threadName = `💬 ${embedTitle}`;
  if (embedUrl) {
    // Extract domain or video title for a readable thread name
    try {
      const urlObj = new URL(embedUrl.trim());
      threadName = `💬 ${urlObj.hostname}${urlObj.pathname}`.substring(0, 100);
    } catch {
      threadName = `💬 ${embedTitle}`.substring(0, 100);
    }
  }

  // Create a new thread on the embed message
  const thread = await latestEmbed.startThread({
    name: threadName,
    autoArchiveDuration: 1440, // Auto-archive after 24 hours of inactivity
    reason: 'Link Router Bot: auto-created discussion thread',
  });

  return thread;
}

// ─── Strict channel permissions ──────────────────────────────────────────

async function enforceStrictPermissions(channel, guild) {
  const everyoneRole = guild.roles.everyone;
  const botMember = guild.members.me;

  try {
    await channel.permissionOverwrites.edit(everyoneRole, {
      [PermissionFlagsBits.ViewChannel]: true,
      [PermissionFlagsBits.SendMessages]: false,
      [PermissionFlagsBits.SendMessagesInThreads]: true,
      [PermissionFlagsBits.CreatePublicThreads]: true,
      [PermissionFlagsBits.CreatePrivateThreads]: true,
      [PermissionFlagsBits.ReadMessageHistory]: true,
      [PermissionFlagsBits.AddReactions]: true,
    });

    await channel.permissionOverwrites.edit(botMember, {
      [PermissionFlagsBits.ViewChannel]: true,
      [PermissionFlagsBits.SendMessages]: true,
      [PermissionFlagsBits.ManageMessages]: true,
      [PermissionFlagsBits.ManageThreads]: true,
      [PermissionFlagsBits.CreatePublicThreads]: true,
      [PermissionFlagsBits.EmbedLinks]: true,
      [PermissionFlagsBits.ReadMessageHistory]: true,
    });

    console.log(`    🔒 Strict permissions set on #${channel.name}`);
  } catch (err) {
    console.warn(`    ⚠️  Could not set permissions on #${channel.name}: ${err.message}`);
  }
}

// ─── Auto-create channels ────────────────────────────────────────────────

async function ensureChannel(guild, category) {
  const config = CATEGORIES[category];
  const envId = getDestinationId(category);

  if (envId && envId.length > 10) {
    const existing = guild.channels.cache.get(envId);
    if (existing) {
      destinationChannels[category] = existing;
      console.log(`  ✅ ${config.icon} Found #${existing.name} (${envId})`);
      await enforceStrictPermissions(existing, guild);
      return existing;
    }
    console.warn(`  ⚠️  Channel ID ${envId} not found in server, will auto-create...`);
  }

  const byName = guild.channels.cache.find(
    (ch) => ch.name === config.channelName && ch.type === ChannelType.GuildText
  );
  if (byName) {
    destinationChannels[category] = byName;
    updateEnvId(category, byName.id);
    console.log(`  ✅ ${config.icon} Found existing #${byName.name} (${byName.id})`);
    await enforceStrictPermissions(byName, guild);
    return byName;
  }

  console.log(`  🔨 ${config.icon} Creating #${config.channelName}...`);
  const created = await guild.channels.create({
    name: config.channelName,
    type: ChannelType.GuildText,
    topic: config.topic,
    reason: 'Link Router Bot: auto-created destination channel',
  });

  destinationChannels[category] = created;
  updateEnvId(category, created.id);
  await enforceStrictPermissions(created, guild);
  console.log(`  ✅ ${config.icon} Created #${created.name} (${created.id})`);
  return created;
}

// ─── Backfill: scan history from Jan 1 2025 ──────────────────────────────

async function backfillGuild(guild) {
  console.log(`\n📜 Starting backfill for messages since ${BACKFILL_AFTER.toISOString()}...`);

  const textChannels = guild.channels.cache.filter(
    (ch) =>
      ch.type === ChannelType.GuildText &&
      !isDestinationChannel(ch.id) &&
      ch.permissionsFor(guild.members.me)?.has([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageMessages,
      ])
  );

  let totalMoved = 0;

  for (const [, channel] of textChannels) {
    if (channel.name.includes('-private')) continue;

    console.log(`  📂 Scanning #${channel.name}...`);
    let movedInChannel = 0;
    let lastId = null;
    let reachedCutoff = false;

    while (!reachedCutoff) {
      const options = { limit: 100 };
      if (lastId) options.before = lastId;

      let messages;
      try {
        messages = await channel.messages.fetch(options);
      } catch (err) {
        console.warn(`    ⚠️  Could not fetch messages in #${channel.name}: ${err.message}`);
        break;
      }

      if (messages.size === 0) break;

      for (const [, msg] of messages) {
        if (msg.createdAt < BACKFILL_AFTER) {
          reachedCutoff = true;
          break;
        }

        if (msg.author.bot) continue;

        const urls = msg.content.match(URL_REGEX);
        if (!urls || urls.length === 0) continue;

        const grouped = {};
        for (const url of urls) {
          const cat = categorizeUrl(url);
          if (!grouped[cat]) grouped[cat] = [];
          grouped[cat].push(url);
        }

        let movedThisMsg = false;
        for (const [category, catUrls] of Object.entries(grouped)) {
          const destChannel = destinationChannels[category];
          if (!destChannel) continue;
          if (destChannel.id === channel.id) continue;

          const embed = buildLinkEmbed(category, catUrls, msg.author, channel, msg.createdAt);
          await destChannel.send({ embeds: [embed] });
          movedInChannel++;
          movedThisMsg = true;
        }

        // Delete the original message after routing its links
        if (movedThisMsg) {
          try {
            await msg.delete();
          } catch (err) {
            console.warn(`    ⚠️  Could not delete message: ${err.message}`);
          }
        }
      }

      lastId = messages.last()?.id;
      await new Promise((r) => setTimeout(r, 1000));
    }

    if (movedInChannel > 0) {
      console.log(`    ✅ Moved ${movedInChannel} link(s) from #${channel.name}`);
      totalMoved += movedInChannel;
    }
  }

  console.log(`\n✅ Backfill complete! ${totalMoved} total link(s) organized.\n`);
}

// ─── Bot ready ────────────────────────────────────────────────────────────

client.once('ready', async () => {
  console.log(`\n✅ Bot is online as ${client.user.tag}\n`);

  for (const [, guild] of client.guilds.cache) {
    console.log(`🏠 Setting up for server: ${guild.name}`);

    await ensureChannel(guild, 'youtube');
    await ensureChannel(guild, 'steam');
    await ensureChannel(guild, 'other');

    console.log(`\n📌 Channel IDs (save these to .env.local for future runs):`);
    console.log(`   YOUTUBE_CHANNEL_ID=${YOUTUBE_CHANNEL_ID}`);
    console.log(`   STEAM_CHANNEL_ID=${STEAM_CHANNEL_ID}`);
    console.log(`   LINKS_CHANNEL_ID=${LINKS_CHANNEL_ID}\n`);

    await backfillGuild(guild);
  }

  console.log('🟢 Now listening for new messages...\n');
});

// ─── Live message handler ─────────────────────────────────────────────────

client.on('messageCreate', async (message) => {
  // Ignore bot messages and DMs
  if (message.author.bot) return;
  if (!message.guild) return;

  // Ignore messages inside threads — those are allowed
  if (message.channel.isThread()) return;

  const content = message.content;
  const channelName = message.channel.name || '';
  const currentChannelId = message.channel.id;

  // ─── STRICT MODE: Intercept messages in link channels ──────────────────
  // Delete the message, find the latest link embed, create/find its thread,
  // and repost the user's message there.
  if (isDestinationChannel(currentChannelId)) {
    try {
      // Save the content and attachments before deleting
      const savedContent = message.content;
      const savedAttachments = [...message.attachments.values()];
      const author = message.author;

      await message.delete();

      // Find or create a thread on the most recent link embed
      const thread = await getOrCreateLatestThread(message.channel);

      if (thread) {
        // Repost the user's message in the thread, attributed to them
        const repostContent =
          `**${author.displayName || author.username}** said:\n` +
          `> ${savedContent || '*(no text)*'}`;

        const repostOptions = { content: repostContent };

        // Carry over any attachments
        if (savedAttachments.length > 0) {
          repostOptions.files = savedAttachments.map((att) => ({
            attachment: att.url,
            name: att.name,
          }));
        }

        await thread.send(repostOptions);

        const notice = await message.channel.send(
          `💬 <@${author.id}> Your message was moved to the discussion thread: ${thread.toString()}. ` +
          `Please use threads to discuss links!`
        );
        setTimeout(() => notice.delete().catch(() => {}), 10000);
      } else {
        // No link embeds found — just warn
        const warning = await message.channel.send(
          `💬 <@${author.id}> This channel is for links only! ` +
          `No links have been posted yet to create a thread on. ` +
          `Please wait for a link to be posted, then create a thread to discuss it.`
        );
        setTimeout(() => warning.delete().catch(() => {}), 15000);
      }
    } catch (err) {
      console.error('Error enforcing strict channel:', err.message);
    }
    return;
  }

  // Extract all URLs from the message
  const allUrls = content.match(URL_REGEX);
  if (!allUrls || allUrls.length === 0) return;

  // ─── Private channel — block everything ────────────────────────────────
  if (channelName.includes('-private')) {
    try {
      await message.delete();
      const warning = await message.channel.send(
        `⛔ <@${message.author.id}> This is a chat-only room. No unsolicited links allowed. ` +
        `Please use the designated URL channels or send links via DM.`
      );
      setTimeout(() => warning.delete().catch(() => {}), 10000);
    } catch (err) {
      console.error('Error handling private channel link:', err.message);
    }
    return;
  }

  // ─── Categorize every URL ──────────────────────────────────────────────
  const grouped = {};
  for (const url of allUrls) {
    const category = categorizeUrl(url);
    if (!grouped[category]) grouped[category] = [];
    grouped[category].push(url);
  }

  // Filter to only categories that need routing
  const toRoute = Object.entries(grouped).filter(
    ([category]) => getDestinationId(category) !== currentChannelId
  );

  if (toRoute.length === 0) return;

  // ─── Route misplaced links ─────────────────────────────────────────────
  const routed = [];

  for (const [category, urls] of toRoute) {
    const destChannel = destinationChannels[category];
    if (!destChannel) {
      console.warn(`⚠️  No destination channel for category: ${category}`);
      continue;
    }

    const embed = buildLinkEmbed(category, urls, message.author, message.channel, message.createdAt);
    await destChannel.send({ embeds: [embed] });
    routed.push({ category, destId: destChannel.id, icon: CATEGORIES[category].icon });
  }

  // ─── Delete original message & notify ──────────────────────────────────
  if (routed.length === 0) return;

  try {
    await message.delete();

    const notices = routed.map(({ category, destId, icon }) => {
      const label =
        category === 'youtube' ? 'YouTube link'
        : category === 'steam' ? 'Steam link'
        : 'Link';
      return `${icon} <@${message.author.id}> ${label} detected, moved to <#${destId}>. Create a **thread** there to discuss it!`;
    });

    const notification = await message.channel.send(notices.join('\n'));
    setTimeout(() => notification.delete().catch(() => {}), 10000);
  } catch (err) {
    console.error('Error deleting original message:', err.message);
  }
});

// ─── Error handling ────────────────────────────────────────────────────────
client.on('error', (err) => console.error('Client error:', err));
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));

// ─── Validation & Login ───────────────────────────────────────────────────
if (!BOT_TOKEN || BOT_TOKEN === 'your_bot_token_here') {
  console.error('❌ Please set your DISCORD_BOT_TOKEN in .env.local');
  process.exit(1);
}

client.login(BOT_TOKEN);
