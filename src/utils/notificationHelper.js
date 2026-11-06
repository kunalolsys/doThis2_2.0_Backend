import bot from "../services/telegram/telegramBOT.js";

export const sendNotificationAlert = async ({ io, user, title, message }) => {
  try {
    if (!bot) {
      console.log("Bot not initialized");
      return false;
    }
    // 1. Socket.io In-App Realtime Notification
    if (io) {
      io.to(String(user._id)).emit("new_notification", {
        title,
        message,
        createdAt: new Date(),
      });
    }

    // 2. Telegram Bot Notification
    if (user.telegramChatId && user.telegramNotificationsEnabled) {
      const telegramText = `🔔 <b>${title}</b>\n\n${message}`;
      await bot.sendMessage(user.telegramChatId, telegramText, {
        parse_mode: "HTML",
      });
    }
  } catch (err) {
    console.error(`[Notification Error] User ${user._id}:`, err.message);
  }
};
