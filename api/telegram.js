import OpenAI from "openai";
import { Redis } from "@upstash/redis";
import { randomUUID } from "node:crypto";

export const config = {
  maxDuration: 30,
};

const TELEGRAM_API_BASE = "https://api.telegram.org";
const DEFAULT_MODEL = "gpt-4.1-mini";
const DEFAULT_BOT_USERNAME = "example_minecraft_bot";
const MAX_MESSAGE_LENGTH = 3900;
const OPENAI_TIMEOUT_MS = 15_000;
const TELEGRAM_TIMEOUT_MS = 8_000;
const CONVERSATION_TTL_SECONDS = 60 * 60 * 24 * 14;
const MAX_HISTORY_MESSAGES = 12;
const MAX_HISTORY_TEXT_LENGTH = 1200;
const MAX_WISH_TEXT_LENGTH = 800;
const MAX_STORED_WISHES = 100;
const MAX_LISTED_WISHES = 20;
const GROUP_COMMANDS = new Set([
  "/start",
  "/help",
  "/mc",
  "/minecraft",
  "/myid",
  "/wish",
  "/wishes",
  "/clear_wishes",
]);
let openai;
let redis;

const SYSTEM_PROMPT = `
Ты дружелюбный Telegram-бот для детей примерно 8 лет, которые любят Minecraft.
Отвечай на русском языке простыми словами, тепло и коротко: 2-5 предложений.
Говори только на безопасные темы Minecraft: постройки, биомы, мобы, крафт, фермы, приключения, идеи для игры и творчество.
Если ребенок спрашивает не про Minecraft, мягко верни разговор к Minecraft.
Не проси личные данные, адрес, школу, телефон, фото или контакты. Не предлагай уходить в другие чаты и не давай внешние ссылки.
Не обсуждай взрослые, страшные, опасные или вредные темы. Если вопрос опасный, спокойно откажись и предложи безопасную идею для Minecraft.
Используй контекст прошлых сообщений только для безопасного разговора про Minecraft. Не запоминай и не повторяй личные данные ребенка.
Не притворяйся человеком. Ты игровой помощник по Minecraft.
`.trim();

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({ ok: true, service: "mc-tg-bot" });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  if (!hasValidTelegramSecret(req)) {
    return res.status(401).json({ ok: false, error: "Invalid webhook secret" });
  }

  const update = await parseTelegramUpdate(req);
  const message = update?.message;
  const chat = message?.chat;
  const text = getMessageText(message);
  const chatMode = getChatMode(message, text);

  if (!chat || !chatMode.shouldReply || !text) {
    console.info("telegram update skipped", {
      hasMessage: Boolean(message),
      chatType: chat?.type,
      hasText: Boolean(text),
      reason: chatMode.reason,
      updateId: update?.update_id,
    });

    return res.status(200).json({ ok: true, skipped: true });
  }

  try {
    console.info("telegram message accepted", {
      chatId: chat.id,
      chatType: chat.type,
      reason: chatMode.reason,
      messageId: message.message_id,
      textLength: text.length,
    });

    const commandResult = await handleCommand(message, chatMode.promptText);

    if (commandResult.handled) {
      await sendMessage(chat.id, commandResult.answer, message.message_id);

      return res.status(200).json({ ok: true, command: commandResult.command });
    }

    sendChatAction(chat.id, "typing").catch((error) => {
      console.warn("telegram typing action failed", compactError(error));
    });

    const history = await loadConversationHistory(chat.id);
    const answer = await createMinecraftAnswer(
      chatMode.promptText,
      message.from?.first_name,
      history,
    );
    console.info("openai answer created", {
      chatId: chat.id,
      messageId: message.message_id,
      answerLength: answer.length,
    });

    await sendMessage(chat.id, answer, message.message_id);
    await saveConversationHistory(chat.id, [
      ...history,
      { role: "user", text: chatMode.promptText },
      { role: "assistant", text: answer },
    ]);
    console.info("telegram answer sent", {
      chatId: chat.id,
      messageId: message.message_id,
    });

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("telegram webhook failed", error);

    await sendMessage(
      chat.id,
      "Ой, у меня сейчас лаг, как на сервере с дождем. Попробуй написать еще раз через минутку!",
      message.message_id,
    ).catch((sendError) => {
      console.error("failed to send fallback message", sendError);
    });

    return res.status(200).json({ ok: true, recovered: true });
  }
}

function hasValidTelegramSecret(req) {
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;

  if (!expectedSecret) {
    return true;
  }

  return req.headers["x-telegram-bot-api-secret-token"] === expectedSecret;
}

function getMessageText(message) {
  const text = message?.text ?? message?.caption;

  if (typeof text !== "string") {
    return "";
  }

  return text.trim().slice(0, 2000);
}

function getChatMode(message, text) {
  const chatType = message?.chat?.type;

  if (chatType === "private") {
    return {
      shouldReply: Boolean(text),
      promptText: text,
      reason: "private",
    };
  }

  if (chatType !== "group" && chatType !== "supergroup") {
    return {
      shouldReply: false,
      promptText: text,
      reason: "unsupported_chat_type",
    };
  }

  const botUsername = getBotUsername();
  const isReplyToBot =
    message?.reply_to_message?.from?.is_bot &&
    normalizeUsername(message.reply_to_message.from.username) === botUsername;
  const mentionPattern = new RegExp(`(^|\\s)@${escapeRegExp(botUsername)}\\b`, "i");
  const hasMention = mentionPattern.test(text);
  const commandMode = getGroupCommandMode(text, botUsername);
  const hasCommandForBot = commandMode.shouldReply;

  if (!isReplyToBot && !hasMention && !hasCommandForBot) {
    return {
      shouldReply: false,
      promptText: text,
      reason: "group_not_addressed_to_bot",
    };
  }

  return {
    shouldReply: Boolean(text),
    promptText: stripBotAddressing(text, botUsername),
    reason: isReplyToBot ? "group_reply_to_bot" : commandMode.reason || "group_mention",
  };
}

function getGroupCommandMode(text, botUsername) {
  const commandMatch = text.match(/^\/([a-z0-9_]+)(?:@([a-z0-9_]+))?\b/i);

  if (!commandMatch) {
    return {
      shouldReply: false,
      reason: "",
    };
  }

  const command = `/${commandMatch[1].toLowerCase()}`;
  const targetUsername = normalizeUsername(commandMatch[2]);

  if (targetUsername) {
    return {
      shouldReply: targetUsername === botUsername,
      reason: targetUsername === botUsername ? "group_command_to_bot" : "",
    };
  }

  return {
    shouldReply: GROUP_COMMANDS.has(command),
    reason: GROUP_COMMANDS.has(command) ? "group_command" : "",
  };
}

function stripBotAddressing(text, botUsername) {
  return text
    .replace(new RegExp(`@${escapeRegExp(botUsername)}\\b`, "gi"), "")
    .replace(new RegExp(`^(/[a-z0-9_]+)@${escapeRegExp(botUsername)}\\b`, "i"), "$1")
    .trim();
}

function getBotUsername() {
  return normalizeUsername(process.env.TELEGRAM_BOT_USERNAME || DEFAULT_BOT_USERNAME);
}

function normalizeUsername(username) {
  return String(username || "")
    .replace(/^@/, "")
    .trim()
    .toLowerCase();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function handleCommand(message, text) {
  const parsedCommand = parseCommand(text);

  if (!parsedCommand) {
    return {
      handled: false,
      command: "",
      answer: "",
    };
  }

  if (parsedCommand.command === "/wish") {
    return handleWishCommand(message, parsedCommand);
  }

  if (parsedCommand.command === "/myid") {
    return handleMyIdCommand(message);
  }

  if (parsedCommand.command === "/wishes") {
    return handleListWishesCommand(message);
  }

  if (parsedCommand.command === "/clear_wishes") {
    return handleClearWishesCommand(message);
  }

  return {
    handled: false,
    command: parsedCommand.command,
    answer: "",
  };
}

function parseCommand(text) {
  const match = text.match(/^\/([a-z0-9_]+)(?:@[a-z0-9_]+)?(?:\s+([\s\S]+))?$/i);

  if (!match) {
    return null;
  }

  return {
    command: `/${match[1].toLowerCase()}`,
    args: String(match[2] || "").trim(),
  };
}

function handleMyIdCommand(message) {
  if (message?.chat?.type !== "private") {
    return {
      handled: true,
      command: "/myid",
      answer: "Напиши /myid мне в личном чате, и я покажу твой Telegram user id.",
    };
  }

  const userId = message?.from?.id;

  return {
    handled: true,
    command: "/myid",
    answer: userId
      ? `Твой Telegram user id: ${userId}`
      : "Не получилось узнать user id из этого сообщения.",
  };
}

async function handleWishCommand(message, parsedCommand) {
  const wishText = sanitizeWishText(parsedCommand.args);

  if (!wishText) {
    return {
      handled: true,
      command: parsedCommand.command,
      answer: "Напиши пожелание после команды: /wish хочу карту сервера на сайте",
    };
  }

  const saved = await saveWish(message, wishText);

  return {
    handled: true,
    command: parsedCommand.command,
    answer: saved
      ? "Спасибо! Я записал пожелание для сайта и покажу его только администратору."
      : "Сейчас не могу записать пожелание: хранилище не настроено. Администратор сможет включить его позже.",
  };
}

async function handleListWishesCommand(message) {
  if (!isAdmin(message?.from?.id)) {
    return {
      handled: true,
      command: "/wishes",
      answer: "Эта команда доступна только администратору.",
    };
  }

  if (message?.chat?.type !== "private") {
    return {
      handled: true,
      command: "/wishes",
      answer: "Чтобы пожелания увидел только администратор, напиши эту команду мне в личном чате.",
    };
  }

  const wishes = await loadWishes();

  return {
    handled: true,
    command: "/wishes",
    answer: formatWishes(wishes),
  };
}

async function handleClearWishesCommand(message) {
  if (!isAdmin(message?.from?.id)) {
    return {
      handled: true,
      command: "/clear_wishes",
      answer: "Эта команда доступна только администратору.",
    };
  }

  if (message?.chat?.type !== "private") {
    return {
      handled: true,
      command: "/clear_wishes",
      answer: "Чтобы управлять пожеланиями без лишних глаз, напиши эту команду мне в личном чате.",
    };
  }

  const cleared = await clearWishes();

  return {
    handled: true,
    command: "/clear_wishes",
    answer: cleared
      ? "Готово, список пожеланий очищен."
      : "Не получилось очистить пожелания: хранилище не настроено.",
  };
}

async function saveWish(message, text) {
  const redisClient = getRedis();

  if (!redisClient) {
    return false;
  }

  const wish = {
    id: randomUUID(),
    text,
    createdAt: new Date().toISOString(),
    fromId: message?.from?.id || null,
    chatId: message?.chat?.id || null,
    chatType: message?.chat?.type || "",
  };

  try {
    await redisClient.lpush(getWishesKey(), JSON.stringify(wish));
    await redisClient.ltrim(getWishesKey(), 0, MAX_STORED_WISHES - 1);

    return true;
  } catch (error) {
    console.warn("redis wish save failed", compactError(error));
    return false;
  }
}

async function loadWishes() {
  const redisClient = getRedis();

  if (!redisClient) {
    return [];
  }

  try {
    const values = await redisClient.lrange(getWishesKey(), 0, MAX_LISTED_WISHES - 1);

    return values.map(parseStoredWish).filter(Boolean);
  } catch (error) {
    console.warn("redis wishes load failed", compactError(error));
    return [];
  }
}

async function clearWishes() {
  const redisClient = getRedis();

  if (!redisClient) {
    return false;
  }

  try {
    await redisClient.del(getWishesKey());

    return true;
  } catch (error) {
    console.warn("redis wishes clear failed", compactError(error));
    return false;
  }
}

function parseStoredWish(value) {
  try {
    const wish = typeof value === "string" ? JSON.parse(value) : value;
    const text = sanitizeWishText(wish?.text);

    if (!text) {
      return null;
    }

    return {
      text,
      createdAt: typeof wish.createdAt === "string" ? wish.createdAt : "",
      fromId: wish.fromId || null,
      chatType: typeof wish.chatType === "string" ? wish.chatType : "",
    };
  } catch {
    return null;
  }
}

function formatWishes(wishes) {
  if (wishes.length === 0) {
    return "Пока нет сохраненных пожеланий для сайта.";
  }

  const lines = wishes.map((wish, index) => {
    const createdAt = formatWishDate(wish.createdAt);
    const source = wish.fromId ? `, user ${wish.fromId}` : "";

    return `${index + 1}. ${wish.text}\n   ${createdAt}${source}`;
  });

  return trimTelegramMessage(`Пожелания для сайта:\n\n${lines.join("\n\n")}`);
}

function formatWishDate(value) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "дата неизвестна";
  }

  return date.toISOString().slice(0, 16).replace("T", " ");
}

function sanitizeWishText(text) {
  if (typeof text !== "string") {
    return "";
  }

  return sanitizeHistoryText(text).slice(0, MAX_WISH_TEXT_LENGTH);
}

function isAdmin(userId) {
  return getAdminIds().has(String(userId || ""));
}

function getAdminIds() {
  return new Set(
    String(process.env.TELEGRAM_ADMIN_IDS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

function getWishesKey() {
  return "mc-tg-bot:wishes";
}

async function createMinecraftAnswer(text, firstName, history = []) {
  const response = await getOpenAI().responses.create(
    {
      model: process.env.OPENAI_MODEL || DEFAULT_MODEL,
      instructions: SYSTEM_PROMPT,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: buildUserInput(text, firstName, history),
            },
          ],
        },
      ],
      max_output_tokens: 600,
      store: false,
    },
    {
      timeout: OPENAI_TIMEOUT_MS,
    },
  );

  return trimTelegramMessage(
    response.output_text ||
      "Давай поговорим про Minecraft! Что хочешь построить: дом, замок или секретную базу?",
  );
}

async function parseTelegramUpdate(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) {
    return req.body;
  }

  if (typeof req.body === "string") {
    return JSON.parse(req.body);
  }

  if (Buffer.isBuffer(req.body)) {
    return JSON.parse(req.body.toString("utf8"));
  }

  const chunks = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function getOpenAI() {
  if (!openai) {
    openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }

  return openai;
}

function buildUserInput(text, firstName, history = []) {
  const safeName = sanitizeName(firstName);
  const parts = [];

  if (history.length > 0) {
    parts.push(`Контекст диалога:\n${formatConversationHistory(history)}`);
  }

  if (safeName) {
    parts.push(`Имя ребенка в Telegram: ${safeName}`);
  }

  parts.push(`Новое сообщение: ${text}`);

  return parts.join("\n\n");
}

function formatConversationHistory(history) {
  return history
    .map((entry) => {
      const speaker = entry.role === "assistant" ? "Бот" : "Ребенок";

      return `${speaker}: ${entry.text}`;
    })
    .join("\n");
}

function sanitizeName(name) {
  if (typeof name !== "string") {
    return "";
  }

  return name.replace(/[^\p{L}\p{N} _.-]/gu, "").trim().slice(0, 40);
}

function trimTelegramMessage(text) {
  const normalized = text.trim();

  if (normalized.length <= MAX_MESSAGE_LENGTH) {
    return normalized;
  }

  return `${normalized.slice(0, MAX_MESSAGE_LENGTH - 1)}...`;
}

async function loadConversationHistory(chatId) {
  const redisClient = getRedis();

  if (!redisClient) {
    return [];
  }

  try {
    const value = await redisClient.get(getConversationKey(chatId));
    const history = typeof value === "string" ? JSON.parse(value) : value;

    if (!Array.isArray(history)) {
      return [];
    }

    return normalizeConversationHistory(history);
  } catch (error) {
    console.warn("redis conversation load failed", compactError(error));
    return [];
  }
}

async function saveConversationHistory(chatId, history) {
  const redisClient = getRedis();

  if (!redisClient) {
    return;
  }

  try {
    const normalizedHistory = normalizeConversationHistory(history);

    await redisClient.set(getConversationKey(chatId), JSON.stringify(normalizedHistory), {
      ex: CONVERSATION_TTL_SECONDS,
    });
  } catch (error) {
    console.warn("redis conversation save failed", compactError(error));
  }
}

function normalizeConversationHistory(history) {
  return history
    .filter((entry) => entry?.role === "user" || entry?.role === "assistant")
    .map((entry) => ({
      role: entry.role,
      text: sanitizeHistoryText(entry.text),
    }))
    .filter((entry) => entry.text)
    .slice(-MAX_HISTORY_MESSAGES);
}

function sanitizeHistoryText(text) {
  if (typeof text !== "string") {
    return "";
  }

  return text
    .replace(/https?:\/\/\S+|www\.\S+/gi, "[ссылка скрыта]")
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, "[email скрыт]")
    .replace(/\+?\d[\d\s().-]{6,}\d/g, "[номер скрыт]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_HISTORY_TEXT_LENGTH);
}

function getConversationKey(chatId) {
  return `mc-tg-bot:conversation:${chatId}`;
}

function getRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

  if (!url || !token) {
    return null;
  }

  if (!redis) {
    redis = new Redis({ url, token });
  }

  return redis;
}

async function sendChatAction(chatId, action) {
  return callTelegram("sendChatAction", {
    chat_id: chatId,
    action,
  });
}

async function sendMessage(chatId, text, replyToMessageId) {
  return callTelegram("sendMessage", {
    chat_id: chatId,
    text,
    reply_parameters: replyToMessageId
      ? {
          message_id: replyToMessageId,
          allow_sending_without_reply: true,
        }
      : undefined,
  });
}

async function callTelegram(method, payload) {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  }

  const response = await fetch(`${TELEGRAM_API_BASE}/bot${token}/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram ${method} failed: ${response.status} ${body}`);
  }

  return response.json();
}

function compactError(error) {
  return {
    name: error?.name,
    message: error?.message,
    status: error?.status,
    code: error?.code,
  };
}
