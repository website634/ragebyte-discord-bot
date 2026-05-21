// commands/setup.js — RageByte Discord Bot
export default {
  data: {
    name: "setup",
    description: "Display the first-time setup guide for RageByte products.",
  },
  async execute(interaction) {
    const RAGEBYTE_PURPLE = 0x8B5CF6;

    const embeds = [
      {
        title: "First Time Setup — Rust / ARC Raiders",
        description: "Step-by-step setup guide for new users. Covers exploit protection, Hyper-V, BIOS settings, and loader execution.",
        url: "https://ragebyte.xyz/easy-setup",
        color: RAGEBYTE_PURPLE,
      },
      {
        title: "Call of Duty Setup Guide",
        description: "Setup instructions for Call of Duty products.",
        url: "https://ragebyte.xyz/easy-setup",
        color: RAGEBYTE_PURPLE,
      },
    ];

    await interaction.reply({ embeds, ephemeral: false });
  },
};
