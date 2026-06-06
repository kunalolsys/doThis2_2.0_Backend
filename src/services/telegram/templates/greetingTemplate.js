import bot from "../telegramBOT.js";

export const sendWelcomeMessage = async (chatId) => {
  return bot.sendMessage(
    chatId,
    `
👋 <b>Welcome to DoThis Task Assistant</b>

To connect your account:

<code>REGISTER your_email@example.com</code>

Commands:
• /start
• /status
• /unlink
`,
    {
      parse_mode: "HTML",
    },
  );
};
