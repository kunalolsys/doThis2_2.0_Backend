import TelegramBot from "node-telegram-bot-api";
import bot from "./telegramBOT.js";

export const sendTelegramMessage = async ({ chatId, message }) => {
  try {
    console.log("=== TELEGRAM SEND START ===");
    console.log("chatId:", chatId);
    // console.log("message:", message);

    if (!bot) {
      console.log("Bot not initialized");
      return false;
    }

    if (!chatId) {
      console.log("No chatId");
      return false;
    }

    const response = await bot.sendMessage(chatId, message, {
      parse_mode: "HTML",
    });

    console.log("Telegram Success:", response.message_id);

    return true;
  } catch (error) {
    console.error("Telegram Error:", error.response?.body || error.message);

    return false;
  }
};
