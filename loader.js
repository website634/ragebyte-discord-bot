// commands/loader.js — RageByte Discord Bot
export default {
  data: {
    name: "loader",
    description: "Display the loader download links for RageByte products.",
  },
  async execute(interaction) {
    const RAGEBYTE_PURPLE = 0x8B5CF6;

    const embeds = [
      {
        title: "ARC Raiders / Rust Loader",
        description: "Download the latest loader for ARC Raiders and Rust.",
        url: "https://ragebyte.xyz/loader",
        color: RAGEBYTE_PURPLE,
      },
      {
        title: "Call of Duty Loader",
        description: "Download the latest loader for Call of Duty.",
        url: "https://ragebyte.xyz/loader",
        color: RAGEBYTE_PURPLE,
      },
      {
        title: "First Time Setup — Rust / ARC Raiders",
        description: "Step-by-step setup guide for new users.",
        url: "https://ragebyte.xyz/easy-setup",
        color: RAGEBYTE_PURPLE,
      },
    ];

    await interaction.reply({ embeds, ephemeral: false });
  },
};
