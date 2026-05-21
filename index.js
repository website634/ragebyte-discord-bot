// index.js — RageByte Discord Bot (Railway) — full 24/7 monitoring build
import { Client, GatewayIntentBits, Partials, Events, Collection, REST, Routes, ChannelType } from "discord.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DISCORD_TOKEN     = process.env.DISCORD_TOKEN;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const EDGE_FUNCTION_URL = `${SUPABASE_URL}/functions/v1/discord-bot-realtime`;

const STAFF_ROLE_IDS = (process.env.STAFF_ROLE_IDS || '').split(',').filter(Boolean);
const TICKET_CHANNEL_PREFIXES = (process.env.TICKET_CHANNEL_PREFIXES || 'ticket-,support-').split(',');

if (!DISCORD_TOKEN || !SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("Missing env: DISCORD_TOKEN, SUPABASE_URL, SUPABASE_ANON_KEY");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildMessageReactions, GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User, Partials.GuildMember],
});
client.commands = new Collection();

// ---- auto-mod + heartbeat counters ----
const SPAM_WINDOW_MS = 8000, SPAM_MAX_MSGS = 5;
const LINK_REGEX = /(https?:\/\/|discord\.gg\/)/i;
const ALLOWED_LINK_DOMAINS = ['ragebyte.xyz', 'discord.gg/ragebyte'];
const userMsgTimes = new Map();

let msgsThisMinute = 0;
const activeUsersThisMinute = new Set();
const recentTopics = []; // rolling buffer of last ~20 message snippets

// ---- load slash commands ----
const commandsDir = path.join(__dirname, "commands");
if (fs.existsSync(commandsDir)) {
  for (const file of fs.readdirSync(commandsDir).filter(f => f.endsWith(".js"))) {
    const mod = await import(pathToFileURL(path.join(commandsDir, file)).href);
    const cmd = mod.default ?? mod;
    if (cmd?.data?.name && typeof cmd.execute === "function") {
      client.commands.set(cmd.data.name, cmd);
      console.log(`[cmd] loaded: ${cmd.data.name}`);
    }
  }
}

async function registerSlashCommands() {
  if (!DISCORD_CLIENT_ID) return;
  try {
    const body = client.commands.map(c => c.data.toJSON?.() ?? c.data);
    const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), { body });
    console.log(`✅ Slash commands registered (${body.length})`);
  } catch (e) { console.error("[cmd] register failed:", e.message); }
}

async function forward(payload) {
  try {
    const r = await fetch(EDGE_FUNCTION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
        "apikey": SUPABASE_ANON_KEY,
      },
      body: JSON.stringify(payload),
    });
    const text = await r.text();
    return text ? JSON.parse(text) : null;
  } catch (e) { console.error(`[forward] ${payload.type} FAILED:`, e.message); return null; }
}

const isTicketChannel = (ch) => !!ch?.name && TICKET_CHANNEL_PREFIXES.some(p => ch.name.startsWith(p.trim()));
const isStaffMember  = (m) => !!m?.roles?.cache && STAFF_ROLE_IDS.some(r => m.roles.cache.has(r));

function buildFakeInteraction({ name, message }) {
  return {
    commandName: name, user: message.author, member: message.member,
    guild: message.guild, guildId: message.guildId, channel: message.channel,
    channelId: message.channelId, client,
    isChatInputCommand: () => true, isCommand: () => true, deferred: false, replied: false,
    reply: async (o) => message.channel.send(typeof o === "string" ? o : o.content ?? o),
    deferReply: async () => {},
    editReply: async (o) => message.channel.send(typeof o === "string" ? o : o.content ?? o),
    followUp: async (o) => message.channel.send(typeof o === "string" ? o : o.content ?? o),
    options: { getString:()=>null, getBoolean:()=>null, getInteger:()=>null, getNumber:()=>null,
      getUser:()=>null, getChannel:()=>null, getRole:()=>null, getMentionable:()=>null, getAttachment:()=>null },
  };
}

// ---- READY ----
client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  for (const guild of client.guilds.cache.values()) {
    try {
      await guild.members.fetch({ withPresences: true });
      for (const m of guild.members.cache.values()) {
        if (isStaffMember(m)) forward({
          type: 'presenceUpdate', userId: m.id, username: m.user.username,
          status: m.presence?.status || 'offline', activity: m.presence?.activities?.[0]?.name || null,
        });
      }
    } catch (e) { console.error('presence sync:', e.message); }
  }
  await registerSlashCommands();
});

// ---- MESSAGE CREATE ----
client.on(Events.MessageCreate, async (message) => {
  try {
    if (!message.guild) return;
    const member = message.member;
    const staff  = isStaffMember(member);
    const ticket = isTicketChannel(message.channel);

    if (!message.author.bot && !staff) {
      const now = Date.now();
      const arr = (userMsgTimes.get(message.author.id) || []).filter(t => now - t < SPAM_WINDOW_MS);
      arr.push(now);
      userMsgTimes.set(message.author.id, arr);
      if (arr.length > SPAM_MAX_MSGS) {
        try { await message.delete(); } catch {}
        try { await message.channel.send(`<@${message.author.id}> please slow down.`); } catch {}
        forward({ type:'automod', guildId:message.guildId, channelId:message.channelId,
          messageId:message.id, authorId:message.author.id, authorTag:message.author.tag,
          action:'spam_delete', reason:`>${SPAM_MAX_MSGS} msgs in ${SPAM_WINDOW_MS}ms`, content:message.content });
        return;
      }
      if (LINK_REGEX.test(message.content) && !ALLOWED_LINK_DOMAINS.some(d => message.content.includes(d))) {
        try { await message.delete(); } catch {}
        forward({ type:'automod', guildId:message.guildId, channelId:message.channelId,
          messageId:message.id, authorId:message.author.id, authorTag:message.author.tag,
          action:'link_delete', reason:'unapproved link', content:message.content });
        return;
      }
    }

    // counters for heartbeat
    if (!message.author.bot) {
      msgsThisMinute++;
      activeUsersThisMinute.add(message.author.id);
      if (message.content && message.content.length > 6) {
        recentTopics.push(message.content.slice(0, 80));
        if (recentTopics.length > 20) recentTopics.shift();
      }
    }

    if (message.author.bot && message.author.id !== client.user.id) return;

    const mentionsBot = message.mentions.users.has(client.user.id);
    let repliedToBot = false;
    if (message.reference?.messageId) {
      try {
        const ref = await message.channel.messages.fetch(message.reference.messageId);
        repliedToBot = ref?.author?.id === client.user.id;
      } catch {}
    }
    const authorRoleNames = member?.roles?.cache?.map(r => r.name) ?? [];

    const data = await forward({
      type:'messageCreate', messageId:message.id, channelId:message.channelId,
      channelName:message.channel.name, guildId:message.guildId,
      authorId:message.author.id, authorTag:message.author.tag,
      content:message.content, isBot:message.author.bot, isStaff:staff,
      timestamp:message.createdTimestamp,
      mentionsBot, repliedToBot, authorRoleNames,
    });

    if (data?.autoReply && data?.mode === 'casual') {
      try { await message.channel.sendTyping();
        setTimeout(() => message.reply({ content:data.autoReply, allowedMentions:{repliedUser:true} }).catch(()=>{}), 1200);
      } catch {}
    } else if (data?.autoReply && ticket && !staff && !message.author.bot) {
      try { await message.channel.sendTyping();
        setTimeout(() => message.reply({
          content:`${data.autoReply}\n\n_— AI assistant. A staff member will follow up shortly._`,
          allowedMentions:{repliedUser:true},
        }).catch(()=>{}), 1500);
      } catch {}
    }

    if (data?.action?.type === "command") {
      const command = client.commands.get(data.action.name);
      if (command) {
        try { await command.execute(buildFakeInteraction({ name:data.action.name, message })); }
        catch (e) { console.error("auto-command failed:", data.action.name, e.message); }
      }
    }
  } catch (err) { console.error("[messageCreate] error:", err.message); }
});

// ---- MEMBER JOIN / LEAVE ----
client.on(Events.GuildMemberAdd, (m) => forward({
  type:'memberJoin', guildId:m.guild.id, userId:m.id, username:m.user.username,
}));
client.on(Events.GuildMemberRemove, (m) => forward({
  type:'memberLeave', guildId:m.guild.id, userId:m.id, username:m.user?.username ?? null,
}));

// ---- TICKET OPEN / CLOSE (detect by channel create/delete with prefix) ----
client.on(Events.ChannelCreate, (channel) => {
  if (channel.type !== ChannelType.GuildText || !isTicketChannel(channel)) return;
  forward({ type:'ticketOpen', guildId:channel.guildId, channelId:channel.id, channelName:channel.name });
});
client.on(Events.ChannelDelete, (channel) => {
  if (!channel.name || !isTicketChannel(channel)) return;
  forward({ type:'channelDelete', guildId:channel.guildId, channelId:channel.id, channelName:channel.name });
});

// ---- PRESENCE ----
client.on(Events.PresenceUpdate, (_o, n) => {
  const member = n.member;
  if (!member || !isStaffMember(member)) return;
  forward({ type:'presenceUpdate', userId:member.id, username:member.user.username,
    status:n.status || 'offline', activity:n.activities?.[0]?.name || null });
});

// ---- REACTIONS ----
client.on(Events.MessageReactionAdd, (r, u) => {
  if (u.bot) return;
  forward({ type:'reactionAdd', messageId:r.message.id, emoji:r.emoji.name || r.emoji.id, userId:u.id, guildId:r.message.guildId });
});
client.on(Events.MessageReactionRemove, (r, u) => {
  if (u.bot) return;
  forward({ type:'reactionRemove', messageId:r.message.id, emoji:r.emoji.name || r.emoji.id, userId:u.id, guildId:r.message.guildId });
});

// ---- VOICE ----
client.on(Events.VoiceStateUpdate, (o, n) => {
  if (!o.channelId && n.channelId) forward({ type:'voiceJoined', guildId:n.guild.id, channelId:n.channelId, channelName:n.channel?.name ?? null, joinedBy:n.member?.user?.username ?? null });
  if (o.channelId && !n.channelId) forward({ type:'voiceLeft', guildId:o.guild.id, channelId:o.channelId });
});

// ---- SLASH ----
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const command = client.commands.get(interaction.commandName);
  if (!command) return;
  try { await command.execute(interaction); }
  catch (err) {
    console.error("[interaction] error:", err);
    const opts = { content:"Command failed.", ephemeral:true };
    if (interaction.deferred || interaction.replied) await interaction.followUp(opts).catch(()=>{});
    else await interaction.reply(opts).catch(()=>{});
  }
});

// ---- HEARTBEAT (every 60s) ----
setInterval(async () => {
  console.log(`[hb] ${client.ws.ping ?? 0}ms`);
  try {
    let onlineCount = 0, memberCount = 0, voiceCount = 0;
    let guildId = null;
    for (const g of client.guilds.cache.values()) {
      guildId = g.id; memberCount += g.memberCount;
      for (const m of g.members.cache.values()) {
        if (m.presence?.status && m.presence.status !== 'offline') onlineCount++;
        if (m.voice?.channelId) voiceCount++;
      }
    }
    await forward({
      type:'serverHeartbeat', guildId,
      onlineCount, memberCount, voiceCount,
      messagesLastMin: msgsThisMinute,
      activeUsersLastMin: activeUsersThisMinute.size,
      recentTopics: [...recentTopics],
    });
  } catch (e) { console.error('heartbeat err:', e.message); }
  msgsThisMinute = 0;
  activeUsersThisMinute.clear();
}, 60_000);

client.on(Events.Error, (e) => console.error("[client error]", e.message));
process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", e));
process.on("uncaughtException", (e) => console.error("[uncaughtException]", e));

client.login(DISCORD_TOKEN);
