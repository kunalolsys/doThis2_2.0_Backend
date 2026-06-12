import bot from "../telegramBOT.js";

export const sendWelcomeMessage = async (chatId) => {
  const message = [
    `<b>DoThis2</b>`,
    ``,
    `Welcome. Your task system is active.`,
    ``,
    `<b>Account Setup</b>`,
    `<code>REGISTER your_email@example.com</code>`,
    ``,
    `<b>Commands</b>`,
    `General`,
    `/start - Initialize bot`,
    `/status - View account status`,
    `/unlink - Disconnect account`,
    ``,
    `Tasks`,
    `/tasks - Open task dashboard`,
    `Select status and view filtered tasks`,
    ``,
  ].join("\n");

  try {
    return await bot.sendMessage(chatId, message, {
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
  } catch (err) {
    console.error("Telegram sendWelcomeMessage error:", err.message);

    // fallback (prevents crash)
    return bot.sendMessage(chatId, "Welcome to DoThis Task Assistant.");
  }
};
