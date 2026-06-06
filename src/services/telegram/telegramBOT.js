import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";
import User from "../../models/User.js";
import { sendWelcomeMessage } from "./templates/greetingTemplate.js";

dotenv.config();

// ── Guard: token must exist before anything ──────────────────────────────────
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("TELEGRAM_BOT_TOKEN is missing from environment");

const bot = new TelegramBot(token, { polling: true });

console.log("✅ Telegram Bot Started");

// ── Safe reply helper — never throws, logs on failure ────────────────────────
const reply = async (chatId, text, options = {}) => {
  try {
    await bot.sendMessage(chatId, text, { parse_mode: "HTML", ...options });
  } catch (err) {
    console.error(
      `[Telegram] Failed to send message to chatId ${chatId}:`,
      err.message,
    );
  }
};

// ── Lookup user by Telegram username ─────────────────────────────────────────
// Returns: { user, reason } where reason is null if found, or a string why not
const findUser = async (username) => {
  // Case 1: user didn't set a Telegram username at all
  if (!username) {
    return { user: null, reason: "no_username" };
  }

  const normalizedUsername = username.replace("@", "");
  const user = await User.findOne({
    telegramUserName: {
      $in: [normalizedUsername, `@${normalizedUsername}`],
    },
    isDeleted: false,
  });
//   console.log("object", user);
  // Case 2: username not in our database
  if (!user) {
    return { user: null, reason: "not_registered" };
  }

  // Case 3: user is registered but disabled Telegram notifications
  if (!user.telegramNotificationsEnabled) {
    return {
      user: null,
      reason: "notifications_disabled",
      registeredUser: user,
    };
  }

  return { user, reason: null };
};

// ── Auto-save chatId if it changed or was missing ────────────────────────────
const syncChatId = async (user, chatId) => {
  const id = String(chatId);
  if (user.telegramChatId !== id) {
    user.telegramChatId = id;
    await user.save();
  }
};

// ── Unregistered user response ────────────────────────────────────────────────
const sendNotRegistered = (chatId, username) =>
  reply(
    chatId,
    `❌ <b>Account not found</b>\n\n` +
      `Your Telegram username <code>@${username || "unknown"}</code> is not linked to any account in our Dothis2 system.\n\n` +
      `Please contact your administrator to register your Telegram username.`,
  );

// ── No username set response ──────────────────────────────────────────────────
const sendNoUsername = (chatId) =>
  reply(
    chatId,
    `⚠️ <b>Username not set</b>\n\n` +
      `Please set a Telegram username in your Telegram settings (Settings → Edit Profile → Username) ` +
      `and then ask your administrator to link it to your account.`,
  );

// ════════════════════════════════════════════════════════════════════════════
// COMMAND: /start
// ════════════════════════════════════════════════════════════════════════════
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const username = msg.from?.username;

  try {
    const { user, reason, registeredUser } = await findUser(username);

    if (reason === "no_username") return sendNoUsername(chatId);
    if (reason === "not_registered") return sendNotRegistered(chatId, username);

    if (reason === "notifications_disabled") {
      // Re-enable since they're actively messaging the bot
      registeredUser.telegramNotificationsEnabled = true;
      await syncChatId(registeredUser, chatId);
      return reply(
        chatId,
        `✅ <b>Welcome back, ${registeredUser.name}!</b>\n\n` +
          `Your Telegram notifications have been re-enabled.`,
      );
    }

    await syncChatId(user, chatId);
    return sendWelcomeMessage(chatId, user);
  } catch (err) {
    console.error("[/start] Error:", err);
    reply(chatId, "⚠️ Something went wrong. Please try again in a moment.");
  }
});

// ════════════════════════════════════════════════════════════════════════════
// COMMAND: /status
// ════════════════════════════════════════════════════════════════════════════
bot.onText(/\/status/, async (msg) => {
  const chatId = msg.chat.id;
  const username = msg.from?.username;

  try {
    const { user, reason } = await findUser(username);

    if (reason === "no_username") return sendNoUsername(chatId);
    if (reason === "not_registered") return sendNotRegistered(chatId, username);
    if (reason === "notifications_disabled") {
      return reply(
        chatId,
        `🔕 <b>Notifications paused</b>\n\n` +
          `Your account is registered but Telegram notifications are currently disabled.\n` +
          `Send /start to re-enable them.`,
      );
    }

    await syncChatId(user, chatId);

    return reply(
      chatId,
      `✅ <b>Account linked</b>\n\n` +
        `<b>Name:</b> ${user.name}\n` +
        `<b>Email:</b> ${user.email}\n` +
        // `<b>Role:</b> ${user.role?.name || "—"}\n` +
        `<b>Notifications:</b> Enabled`,
    );
  } catch (err) {
    console.error("[/status] Error:", err);
    reply(chatId, "⚠️ Something went wrong. Please try again in a moment.");
  }
});

// ════════════════════════════════════════════════════════════════════════════
// COMMAND: /unlink
// ════════════════════════════════════════════════════════════════════════════
bot.onText(/\/unlink/, async (msg) => {
  const chatId = msg.chat.id;
  const username = msg.from?.username;

  try {
    const { user, reason } = await findUser(username);

    if (reason === "no_username") return sendNoUsername(chatId);
    if (reason === "not_registered") return sendNotRegistered(chatId, username);

    // Already disabled — still confirm so the user isn't confused
    if (reason === "notifications_disabled") {
      return reply(
        chatId,
        "ℹ️ Your Telegram notifications are already disabled.",
      );
    }

    user.telegramChatId = null;
    user.telegramNotificationsEnabled = false;
    await user.save();

    return reply(
      chatId,
      `✅ <b>Disconnected</b>\n\n` +
        `Your Telegram account has been unlinked from <b>${user.email}</b>.\n` +
        `You will no longer receive notifications here.\n\n` +
        `Send /start at any time to reconnect.`,
    );
  } catch (err) {
    console.error("[/unlink] Error:", err);
    reply(chatId, "⚠️ Something went wrong. Please try again in a moment.");
  }
});

// ════════════════════════════════════════════════════════════════════════════
// COMMAND: /help
// ════════════════════════════════════════════════════════════════════════════
bot.onText(/\/help/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    return reply(
      chatId,
      `📋 <b>Available Commands</b>\n\n` +
        `/start — Link your account and enable notifications\n` +
        `/status — Check your connection status\n` +
        `/unlink — Disconnect your Telegram account\n` +
        `/help — Show this message`,
    );
  } catch (err) {
    console.error("[/help] Error:", err);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// ALL OTHER MESSAGES (text, stickers, photos, etc.)
// ════════════════════════════════════════════════════════════════════════════
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const username = msg.from?.username;
  const text = msg.text?.trim() || "";

  // Skip anything already handled by onText (commands)
  if (text.startsWith("/")) return;

  try {
    const { user, reason, registeredUser } = await findUser(username);

    // ── Unregistered / no username ──────────────────────────────────────
    if (reason === "no_username") return sendNoUsername(chatId);
    if (reason === "not_registered") return sendNotRegistered(chatId, username);

    if (reason === "notifications_disabled") {
      return reply(
        chatId,
        `🔕 Your notifications are paused. Send /start to re-enable them.`,
      );
    }

    // ── Registered user ─────────────────────────────────────────────────
    // Sync chatId silently in background (don't await so the reply is instant)
    syncChatId(user, chatId).catch((e) =>
      console.error("[syncChatId] Error:", e.message),
    );

    // Respond with greeting — don't echo the message back or leave them hanging
    return sendWelcomeMessage(chatId, user);
  } catch (err) {
    console.error("[message handler] Error:", err);
    reply(chatId, "⚠️ Something went wrong. Please try again in a moment.");
  }
});

// ════════════════════════════════════════════════════════════════════════════
// POLLING ERROR HANDLER — prevents the process from crashing on network issues
// ════════════════════════════════════════════════════════════════════════════
bot.on("polling_error", (err) => {
  // ETELEGRAM 409 = another bot instance running — log but don't crash
  if (err.code === "ETELEGRAM" && err.message.includes("409")) {
    console.warn(
      "[Telegram] Polling conflict (409) — another instance may be running.",
    );
    return;
  }
  console.error("[Telegram] Polling error:", err.message);
});

// ════════════════════════════════════════════════════════════════════════════
// WEBHOOK / CALLBACK_QUERY errors (for inline buttons if added later)
// ════════════════════════════════════════════════════════════════════════════
bot.on("error", (err) => {
  console.error("[Telegram] Bot error:", err.message);
});

export default bot;
