// index.js — RageByte Discord Bot (Railway)
import { Client, GatewayIntentBits, Partials, Events, Collection, REST, Routes } from "discord.js";
import { joinVoiceChannel, getVoiceConnection, VoiceConnectionStatus } from "@discordjs/voice";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---- ENV ----
const DISCORD_TOKEN       = process.env.DISCORD_TOKEN;
const DISCORD_CLIENT_ID   = process.env.DISCORD_CLIENT_ID;
const SUPABASE_URL        = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY   = process.env.SUPABASE_ANON_KEY;
const EDGE_FUNCTION_URL   = `${SUPABASE_URL}/functions/v1/discord-bot-realtime`;

const STAFF_ROLE_IDS = (process.env.STAFF_ROLE_IDS || '').split(',').filter(Boolean);
const TICKET_CHANNEL_PREFIXES = (process.env.TICKET_CHANNEL_PREFIXES || 'ticket-,support-').split(',');

if (!DISCORD_TOKEN || !SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("Missing required env vars: DISCORD_TOKEN, SUPABASE_URL, SUPABASE_ANON_KEY");
  process.exit(1);
}

// ---- CLIENT ----
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

client.commands = new Collection();

// ---- SPAM / AUTO-MOD CONFIG ----
const SPAM_WINDOW_MS = 8000;
const SPAM_MAX_MSGS = 5;
const LINK_REGEX = /(https?:\/\/|discord\.gg\/)/i;
const ALLOWED_LINK_DOMAINS = ['ragebyte.xyz', 'discord.gg/ragebyte'];
const userMsgTimes = new Map();

// ---- LOAD SLASH COMMANDS ----
const commandsDir = path.join(__dirname, "commands");
if (fs.existsSync(commandsDir)) {
  const files = fs.readdirSync(commandsDir).filter(f => f.endsWith(".js"));
  for (const file of files) {
    const mod = await import(pathToFileURL(path.join(commandsDir, file)).href);
    const cmd = mod.default ?? mod;
    if (cmd?.data?.name && typeof cmd.execute === "function") {
      client.commands.set(cmd.data.name, cmd);
      console.log(`[cmd] loaded: ${cmd.data.name}`);
    }
  }
}

// ---- REGISTER SLASH COMMANDS ON STARTUP ----
async function registerSlashCommands() {
  if (!DISCORD_CLIENT_ID) return;
  try {
    const body = client.commands.map(c => c.data.toJSON?.() ?? c.data);
    const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), { body });
    console.log(`✅ Slash commands registered (${body.length})`);
  } catch (e) {
    console.error("[cmd] register failed:", e.message);
  }
}

// ---- FORWARD TO EDGE FUNCTION ----
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
    console.log(`[forward] ${payload.type} -> ${r.status} ${text.slice(0, 200)}`);
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

// ---- BUILD FAKE INTERACTION FOR ACTION EXECUTION ----
function buildFakeInteraction({ name, message }) {
  return {
    commandName: name,
    user: message.author,
    member: message.member,
    guild: message.guild,
    guildId: message.guildId,
    channel: message.channel,
    channelId: message.channelId,
    client,
    isChatInputCommand: () => true,
    isCommand: () => true,
    deferred: false,
    replied: false,
    reply: async (opts) => message.channel.send(typeof opts === "string" ? opts : opts.content ?? opts),
    deferReply: async () => {},
    editReply: async (opts) => message.channel.send(typeof opts === "string" ? opts : opts.content ?? opts),
    followUp: async (opts) => message.channel.send(typeof opts === "string" ? opts : opts.content ?? opts),
    options: {
      getString: () => null,
      getBoolean: () => null,
      getInteger: () => null,
      getNumber: () => null,
      getUser: () => null,
      getChannel: () => null,
      getRole: () => null,
      getMentionable: () => null,
      getAttachment: () => null,
    },
  };
}

// ---- HEARTBEAT ----
setInterval(() => {
  console.log(`[${new Date().toISOString()}] heartbeat ${client.ws.ping ?? 0}ms`);
}, 60000);

// ---- READY ----
client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  // Initial presence sync for staff
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

// ---- MESSAGE CREATE (transcripts + AI auto-reply + auto-mod) ----
client.on(Events.MessageCreate, async (message) => {
  try {
    if (!message.guild) return;
    const member = message.member;
    const staff = isStaffMember(member);
    const ticket = isTicketChannel(message.channel);

    // ---- Auto-mod (only for non-staff, non-bot) ----
    if (!message.author.bot && !staff) {
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
    if (message.author.bot && message.author.id !== client.user.id) return;

    const data = await forward({
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

    // ---- AI auto-reply ----
    if (data?.autoReply && ticket && !staff && !message.author.bot) {
      try {
        await message.channel.sendTyping();
        setTimeout(async () => {
          try {
            await message.reply({
              content: `${data.autoReply}\n\n_— AI assistant. A staff member will follow up shortly._`,
              allowedMentions: { repliedUser: true },
            });
          } catch (e) { console.error('autoReply send:', e.message); }
        }, 1500);
      } catch (e) { console.error('typing:', e.message); }
    }

    // ---- Execute slash command action from AI ----
    if (data?.action?.type === "command") {
      const name = data.action.name;
      const command = client.commands.get(name);
      if (command) {
        try {
          const fake = buildFakeInteraction({ name, message });
          await command.execute(fake);
        } catch (e) {
          console.error("auto-command failed:", name, e.message);
        }
      }
    }
  } catch (err) {
    console.error("[messageCreate] error:", err.message);
  }
});

// ---- PRESENCE UPDATE ----
client.on(Events.PresenceUpdate, async (oldPresence, newPresence) => {
  try {
    const member = newPresence.member;
    if (!member || !isStaffMember(member)) return;
    forward({
      type: 'presenceUpdate',
      userId: member.id,
      username: member.user.username,
      status: newPresence.status || 'offline',
      activity: newPresence.activities?.[0]?.name || null,
    });
  } catch (e) { console.error('presenceUpdate:', e.message); }
});

// ---- REACTION ROLES ----
client.on(Events.MessageReactionAdd, async (reaction, user) => {
  try {
    if (user.bot) return;
    await forward({
      type: 'reactionAdd',
      messageId: reaction.message.id,
      emoji: reaction.emoji.name || reaction.emoji.id,
      userId: user.id,
      guildId: reaction.message.guildId,
    });
  } catch (e) { console.error('reactionAdd:', e.message); }
});

client.on(Events.MessageReactionRemove, async (reaction, user) => {
  try {
    if (user.bot) return;
    await forward({
      type: 'reactionRemove',
      messageId: reaction.message.id,
      emoji: reaction.emoji.name || reaction.emoji.id,
      userId: user.id,
      guildId: reaction.message.guildId,
    });
  } catch (e) { console.error('reactionRemove:', e.message); }
});

// ---- VOICE CHANNEL LOGGING ----
client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  try {
    if (!oldState.channelId && newState.channelId) {
      await forward({
        type: 'voiceJoined',
        guildId: newState.guild.id,
        channelId: newState.channelId,
        channelName: newState.channel?.name ?? null,
        joinedBy: newState.member?.user?.username ?? null,
      });
    }
    if (oldState.channelId && !newState.channelId) {
      await forward({
        type: 'voiceLeft',
        guildId: oldState.guild.id,
        channelId: oldState.channelId,
      });
    }
  } catch (e) { console.error('voiceState:', e.message); }
});

// ---- INTERACTION HANDLER (slash commands) ----
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const command = client.commands.get(interaction.commandName);
  if (!command) return;
  try {
    await command.execute(interaction);
  } catch (err) {
    console.error("[interaction] error:", err);
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: "Command failed.", ephemeral: true }).catch(() => {});
    } else {
      await interaction.reply({ content: "Command failed.", ephemeral: true }).catch(() => {});
    }
  }
});

// ---- ERROR HANDLING (prevents crash loops) ----
client.on(Events.Error, (err) => {
  console.error("[client error]", err.message);
});

process.on("unhandledRejection", (err) => {
  console.error("[unhandledRejection]", err);
});

process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
});

// ---- LOGIN ----
client.login(DISCORD_TOKEN);
