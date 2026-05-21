// commands/status.js — RageByte Discord Bot
export default {
  data: {
    name: "status",
    description: "Check the current status of RageByte products.",
  },
  async execute(interaction) {
    const RAGEBYTE_PURPLE = 0x8B5CF6;
    const STATUS_GREEN = 0x22C55E;
    const STATUS_RED = 0xEF4444;
    const STATUS_AMBER = 0xF59E0B;

    // Default status — update these values manually or wire to a live feed
    const statuses = [
      { product: "Rust", status: "Undetected", color: STATUS_GREEN },
      { product: "ARC Raiders", status: "Undetected", color: STATUS_GREEN },
      { product: "Call of Duty", status: "Undetected", color: STATUS_GREEN },
    ];

    const embeds = statuses.map((s) => ({
      title: `${s.product} — ${s.status}`,
      description: `Current status for ${s.product}. Check ragebyte.xyz/status for live updates.`,
      url: "https://ragebyte.xyz/status",
      color: s.color,
    }));

    await interaction.reply({ embeds, ephemeral: false });
  },
};
