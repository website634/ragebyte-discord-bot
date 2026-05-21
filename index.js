// index.js — RageByte Discord Bot (Railway)
import { Client, GatewayIntentBits, Partials, Collection, REST, Routes } from "discord.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---- ENV ----
const DISCORD_TOKEN       = process.env.DISCORD_TOKEN;
const DISCORD_CLIENT_ID   = process.env.DISCORD_CLIENT_ID;
const SUPABASE_URL        = process.env.SUPABASE_URL;        // e.g. https://kwfhmxfqormzobzbdhmm.supabase.co
const SUPABASE_ANON_KEY   = process.env.SUPABASE_ANON_KEY;
const EDGE_FUNCTION_URL   = `${SUPABASE_URL}/functions/v1/discord-bot-realtime`;

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
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message],
});

client.commands = new Collection();

// ---- LOAD COMMANDS ----
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

// ---- REGISTER SLASH COMMANDS (optional, on startup) ----
async function registerCommands() {
  if (!DISCORD_CLIENT_ID) return;
  try {
    const body = client.commands.map(c => c.data.toJSON());
    const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), { body });
    console.log(`[cmd] registered ${body.length} slash commands`);
  } catch (e) {
    console.error("[cmd] register failed:", e);
  }
}

// ---- READY ----
client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await registerCommands();
});

// ---- INTERACTION HANDLER ----
client.on("interactionCreate", async (interaction) => {
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

// ---- HELPER: build a fake interaction so slash commands can run from messageCreate ----
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
    reply: async (opts) => message.channel.send(typeof opts === "string" ? opts : opts),
    deferReply: async () => {},
    editReply: async (opts) => message.channel.send(typeof opts === "string" ? opts : opts),
    followUp: async (opts) => message.channel.send(typeof opts === "string" ? opts : opts),
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

// ---- MESSAGE HANDLER (RageAI auto-reply in tickets) ----
client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;
    if (!message.guild) return;

    // Forward to edge function
    let data = null;
    try {
      const res = await fetch(EDGE_FUNCTION_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
          "apikey": SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({
          type: "messageCreate",
          message: {
            id: message.id,
            content: message.content,
            channelId: message.channelId,
            channelName: message.channel?.name ?? null,
            guildId: message.guildId,
            author: {
              id: message.author.id,
              username: message.author.username,
              bot: message.author.bot,
            },
          },
        }),
      });

      const text = await res.text();
      console.log(`[forward] messageCreate -> ${res.status} ${text.slice(0, 200)}`);
      try { data = JSON.parse(text); } catch { data = null; }
    } catch (err) {
      console.error("[forward] fetch error:", err);
      return;
    }

    if (!data) return;

    // 1) Post auto-reply
    if (data.autoReply && typeof data.autoReply === "string" && data.autoReply.trim()) {
      try {
        await message.channel.send(data.autoReply);
      } catch (e) {
        console.error("[autoReply] send failed:", e);
      }
    }

    // 2) Execute slash command if requested
    if (data.action?.type === "command" && data.action?.name) {
      const name = data.action.name;
      const command = client.commands.get(name);
      if (!command) {
        console.warn(`[action] unknown command: ${name}`);
        return;
      }
      try {
        const fake = buildFakeInteraction({ name, message });
        await command.execute(fake);
        console.log(`[action] executed /${name}`);
      } catch (e) {
        console.error(`[action] /${name} failed:`, e);
      }
    }
  } catch (err) {
    console.error("[messageCreate] handler error:", err);
  }
});

// ---- GLOBAL ERROR HANDLERS (prevent crashes) ----
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
});
client.on("error", (err) => {
  console.error("[client error]", err);
});

// ---- LOGIN ----
client.login(DISCORD_TOKEN);
