require('dotenv').config();
const {
  Client, GatewayIntentBits, Partials, Events, REST, Routes,
  SlashCommandBuilder, PermissionFlagsBits,
} = require('discord.js');
const {
  joinVoiceChannel, getVoiceConnection, VoiceConnectionStatus,
} = require('@discordjs/voice');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User, Partials.GuildMember],
});

const EDGE = process.env.SUPABASE_EDGE_BASE || 'https://kwfhmxfqormzobzbdhmm.supabase.co/functions/v1';
const ANON = process.env.SUPABASE_ANON_KEY;
const STAFF_ROLE_IDS = (process.env.STAFF_ROLE_IDS || '').split(',').filter(Boolean);
// Channels (or category IDs) whose messages count as "tickets". If empty, all channels.
const TICKET_CHANNEL_PREFIXES = (process.env.TICKET_CHANNEL_PREFIXES || 'ticket-,support-').split(',');

// --- Spam/auto-mod config ---
const SPAM_WINDOW_MS = 8000;
const SPAM_MAX_MSGS = 5;
const LINK_REGEX = /(https?:\/\/|discord\.gg\/)/i;
const ALLOWED_LINK_DOMAINS = ['ragebyte.xyz', 'discord.gg/ragebyte'];
const userMsgTimes = new Map();

async function forward(payload) {
  const url = `${process.env.SUPABASE_URL}/functions/v1/discord-bot-realtime`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`,
        'apikey': process.env.SUPABASE_ANON_KEY,
      },
      body: JSON.stringify(payload),
    });
    const text = await r.text();
    console.log(`[forward] ${payload.type} -> ${r.status} ${text.slice(0,200)}`);
    return text ? JSON.parse(text) : null;
  } catch (e) {
    console.error(`[forward] ${payload.type} FAILED:`, e.message);
    return null;
  }
}

function isTicketChannel(channel) {
  if (!channel?.name) return false;
  return TICKET_CHANNEL_PREFIXES.some((p) => channel.name.startsWith(p.trim()));
}

function isStaffMember(member) {
  if (!member?.roles?.cache) return false;
  return STAFF_ROLE_IDS.some((r) => member.roles.cache.has(r));
}

// ---------- ready ----------
client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  // initial presence sync for staff
  for (const guild of client.guilds.cache.values()) {
    try {
      await guild.members.fetch({ withPresences: true });
      for (const member of guild.members.cache.values()) {
        if (isStaffMember(member)) {
          forward({
            type: 'presenceUpdate',
            userId: member.id,
            username: member.user.username,
            status: member.presence?.status || 'offline',
            activity: member.presence?.activities?.[0]?.name || null,
          });
        }
      }
    } catch (e) { console.error('presence sync:', e.message); }
  }
  await registerSlashCommands();
});

// ---------- messageCreate (transcripts + AI auto-reply + auto-mod) ----------
client.on(Events.MessageCreate, async (message) => {
  if (!message.guild) return;
  console.log(`[msg] #${message.channel.name} <${message.author.tag}>: ${message.content?.slice(0, 80)}`);
  const member = message.member;
  const staff = isStaffMember(member);
  const ticket = isTicketChannel(message.channel);

if (data?.autoReply) {
  await message.channel.send(data.autoReply);
}

// NEW — execute returned slash-command action:
if (data?.action?.type === "command") {
  const name = data.action.name; // "loader" | "setup" | "status"
  const handler = commandHandlers[name]; // your existing /loader, /setup, /status handlers
  if (handler) {
    try {
      // Build a minimal fake interaction OR just call the handler's core logic directly.
      // Easiest: reuse the same channel.send used by your slash command body.
      await handler({ channel: message.channel, user: message.author, guild: message.guild });
    } catch (e) {
      console.error("auto-command failed:", name, e);
    }
  }
}


  

  // ---- Auto-mod (only for non-staff, non-bot) ----
  if (!message.author.bot && !staff) {
    // Spam rate-limit
    const now = Date.now();
    const arr = (userMsgTimes.get(message.author.id) || []).filter(t => now - t < SPAM_WINDOW_MS);
    arr.push(now);
    userMsgTimes.set(message.author.id, arr);
    if (arr.length > SPAM_MAX_MSGS) {
      try { await message.delete(); } catch {}
      try { await message.channel.send(`<@${message.author.id}> please slow down.`); } catch {}
      forward({
        type: 'automod', guildId: message.guildId, channelId: message.channelId,
        messageId: message.id, authorId: message.author.id, authorTag: message.author.tag,
        action: 'spam_delete', reason: `>${SPAM_MAX_MSGS} msgs in ${SPAM_WINDOW_MS}ms`, content: message.content,
      });
      return;
    }
    // Link filter
    if (LINK_REGEX.test(message.content)) {
      const allowed = ALLOWED_LINK_DOMAINS.some(d => message.content.includes(d));
      if (!allowed) {
        try { await message.delete(); } catch {}
        forward({
          type: 'automod', guildId: message.guildId, channelId: message.channelId,
          messageId: message.id, authorId: message.author.id, authorTag: message.author.tag,
          action: 'link_delete', reason: 'unapproved link', content: message.content,
        });
        return;
      }
    }
  }

  // ---- Forward to edge for transcript + AI ----
  if (message.author.bot && message.author.id !== client.user.id) return; // ignore other bots
  const res = await forward({
    type: 'messageCreate',
    messageId: message.id,
    channelId: message.channelId,
    channelName: message.channel.name,
    guildId: message.guildId,
    authorId: message.author.id,
    authorTag: message.author.tag,
    content: message.content,
    isBot: message.author.bot,
    isStaff: staff,
    timestamp: message.createdTimestamp,
  });

  // ---- AI auto-reply (only in ticket channels, user messages, when edge says so) ----
  if (res?.autoReply && ticket && !staff && !message.author.bot) {
    try {
      await message.channel.sendTyping();
      setTimeout(async () => {
        try {
          await message.reply({
            content: `${res.autoReply}\n\n_— AI assistant. A staff member will follow up shortly._`,
            allowedMentions: { repliedUser: true },
          });
        } catch (e) { console.error('autoReply send:', e.message); }
      }, 1500);
    } catch (e) { console.error('typing:', e.message); }
  }
});

// ---------- presenceUpdate ----------
client.on(Events.PresenceUpdate, async (_old, presence) => {
  if (!presence?.member) return;
  if (!isStaffMember(presence.member)) return;
  forward({
    type: 'presenceUpdate',
    userId: presence.userId,
    username: presence.user?.username,
    status: presence.status,
    activity: presence.activities?.[0]?.name || null,
  });
});

// ---------- reaction roles ----------
async function handleReaction(reaction, user, isAdd) {
  if (user.bot) return;
  if (reaction.partial) { try { await reaction.fetch(); } catch { return; } }
  const emoji = reaction.emoji.id ? `<:${reaction.emoji.name}:${reaction.emoji.id}>` : reaction.emoji.name;
  const res = await forward({
    type: isAdd ? 'reactionAdd' : 'reactionRemove',
    messageId: reaction.message.id, channelId: reaction.message.channelId,
    guildId: reaction.message.guildId, emoji, userId: user.id,
  });
  if (res?.roleAction) {
    try {
      const guild = reaction.message.guild;
      const member = await guild.members.fetch(res.roleAction.userId);
      if (res.roleAction.add) await member.roles.add(res.roleAction.roleId);
      else await member.roles.remove(res.roleAction.roleId);
    } catch (e) { console.error('role apply:', e.message); }
  }
}
client.on(Events.MessageReactionAdd, (r, u) => handleReaction(r, u, true));
client.on(Events.MessageReactionRemove, (r, u) => handleReaction(r, u, false));

// ---------- threads ----------
client.on(Events.ThreadCreate, async (thread) => {
  forward({ type: 'threadCreate', threadId: thread.id, parentId: thread.parentId, name: thread.name });
});

// ---------- slash commands (voice support) ----------
const commands = [
  new SlashCommandBuilder()
    .setName('joincall').setDescription('Bot joins your current voice channel for support')
    .setDefaultMemberPermissions(PermissionFlagsBits.SendMessages),
  new SlashCommandBuilder()
    .setName('leavecall').setDescription('Bot leaves the voice channel'),
].map(c => c.toJSON());

async function registerSlashCommands() {
  try {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);
    const appId = client.application.id;
    await rest.put(Routes.applicationCommands(appId), { body: commands });
    console.log('✅ Slash commands registered');
  } catch (e) { console.error('register:', e.message); }
}

client.on(Events.InteractionCreate, async (i) => {
  if (!i.isChatInputCommand()) return;

  if (i.commandName === 'joincall') {
    const vc = i.member?.voice?.channel;
    if (!vc) return i.reply({ content: 'Join a voice channel first.', ephemeral: true });
    if (!isStaffMember(i.member)) return i.reply({ content: 'Staff only.', ephemeral: true });
    try {
      joinVoiceChannel({
        channelId: vc.id, guildId: vc.guildId,
        adapterCreator: vc.guild.voiceAdapterCreator,
        selfDeaf: false, selfMute: true,
      });
      forward({
        type: 'voiceJoined', guildId: vc.guildId, channelId: vc.id,
        channelName: vc.name, joinedBy: i.user.tag,
      });
      await i.reply({ content: `Joined **${vc.name}**.`, ephemeral: true });
    } catch (e) { await i.reply({ content: `Failed: ${e.message}`, ephemeral: true }); }
  }

  if (i.commandName === 'leavecall') {
    const conn = getVoiceConnection(i.guildId);
    if (!conn) return i.reply({ content: 'Not in a voice channel.', ephemeral: true });
    const channelId = conn.joinConfig.channelId;
    conn.destroy();
    forward({ type: 'voiceLeft', guildId: i.guildId, channelId });
    await i.reply({ content: 'Left the voice channel.', ephemeral: true });
  }
});

// ---------- heartbeat ----------
setInterval(() => {
  console.log(`[${new Date().toISOString()}] heartbeat ${client.ws.ping}ms`);
}, 60000);

client.login(process.env.DISCORD_BOT_TOKEN);
