require('dotenv').config();
const { Client, GatewayIntentBits, Partials } = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Channel, Partials.Message],
});

const SUPABASE_EDGE_BASE = process.env.SUPABASE_EDGE_BASE || 'https://kwfhmxfqormzobzbdhmm.supabase.co/functions/v1';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

async function forwardToEdge(functionName, payload) {
  try {
    const res = await fetch(`${SUPABASE_EDGE_BASE}/${functionName}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error(`Edge function ${functionName} returned ${res.status}`);
    }
  } catch (e) {
    console.error('Edge forward error:', e.message);
  }
}

client.once('ready', () => {
  console.log(`Bot logged in as ${client.user.tag}`);
});

// Forward all ticket-related messages to the ticket monitor edge function
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  const payload = {
    type: 'messageCreate',
    messageId: message.id,
    channelId: message.channelId,
    guildId: message.guildId,
    authorId: message.author.id,
    authorTag: message.author.tag,
    content: message.content,
    isDM: !message.guild,
    timestamp: message.createdTimestamp,
  };

  // Forward everything — edge functions decide what to process
  await forwardToEdge('rageauth-ticket-monitor', payload);
});

// Forward thread creation events (for ticket channels)
client.on('threadCreate', async (thread) => {
  await forwardToEdge('rageauth-ticket-monitor', {
    type: 'threadCreate',
    threadId: thread.id,
    parentId: thread.parentId,
    name: thread.name,
    timestamp: Date.now(),
  });
});

// Keep-alive heartbeat (Railway likes to see activity)
setInterval(() => {
  console.log(`[${new Date().toISOString()}] Heartbeat — ${client.ws.ping}ms`);
}, 60000);

client.login(process.env.DISCORD_BOT_TOKEN);
