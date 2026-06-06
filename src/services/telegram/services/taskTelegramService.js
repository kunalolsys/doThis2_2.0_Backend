import User from "../../../models/User.js";
import { sendTelegramMessage } from "../telegramService.js";
import { TELEGRAM_TEMPLATES } from "../templates/templates.js";

export const sendNotification = async ({
  type,
  task,
  actor = null,
  remark = null,
  userId = null,
}) => {
  try {
    const targetUserId = userId || task.assignedTo;

    const user = await User.findById(targetUserId);

    if (!user) {
      console.log("[Telegram] User not found");
      return false;
    }

    if (!user.telegramNotificationsEnabled) {
      console.log("[Telegram] Disabled");
      return false;
    }

    if (!user.telegramChatId) {
      console.log("[Telegram] Chat ID missing");
      return false;
    }

    const template = TELEGRAM_TEMPLATES[type];

    if (!template) {
      console.log("[Telegram] Template not found:", type);
      return false;
    }

    const message = template({
      task,
      actor,
      remark,
    });

    const sent = await sendTelegramMessage({
      chatId: user.telegramChatId,
      message,
    });

    return sent;
  } catch (error) {
    console.error("Telegram Notification Error:", error);
    return false;
  }
};
