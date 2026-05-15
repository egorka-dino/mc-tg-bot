import OpenAI from "openai";

export const config = {
  maxDuration: 30,
};

const TELEGRAM_API_BASE = "https://api.telegram.org";
const DEFAULT_MODEL = "gpt-4.1-mini";
const DEFAULT_BOT_USERNAME = "example_minecraft_bot";
const MAX_MESSAGE_LENGTH = 3900;
const OPENAI_TIMEOUT_MS = 15_000;
const TELEGRAM_TIMEOUT_MS = 8_000;
let openai;

const SYSTEM_PROMPT = `
Ты дружелюбный Telegram-бот для детей примерно 8 лет, которые любят Minecraft.
Отвечай на русском языке простыми словами, тепло и коротко: 2-5 предложений.
Говори только на безопасные темы Minecraft: постройки, биомы, мобы, крафт, фермы, приключения, идеи для игры и творчество.
Если ребенок спрашивает не про Minecraft, мягко верни разговор к Minecraft.
Не проси личные данные, адрес, школу, телефон, фото или контакты. Не предлагай уходить в другие чаты и не давай внешние ссылки.
Не обсуждай взрослые, страшные, опасные или вредные темы. Если вопрос опасный, спокойно откажись и предложи безопасную идею для Minecraft.
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

    sendChatAction(chat.id, "typing").catch((error) => {
      console.warn("telegram typing action failed", compactError(error));
    });

    const answer = await createMinecraftAnswer(chatMode.promptText, message.from?.first_name);
    console.info("openai answer created", {
      chatId: chat.id,
      messageId: message.message_id,
      answerLength: answer.length,
    });

    await sendMessage(chat.id, answer, message.message_id);
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
  const hasCommandForBot = new RegExp(`^/[a-z0-9_]+@${escapeRegExp(botUsername)}\\b`, "i").test(
    text,
  );

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
    reason: isReplyToBot ? "group_reply_to_bot" : "group_mention",
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

async function createMinecraftAnswer(text, firstName) {
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
              text: buildUserInput(text, firstName),
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

function buildUserInput(text, firstName) {
  const safeName = sanitizeName(firstName);

  if (!safeName) {
    return text;
  }

  return `Имя ребенка в Telegram: ${safeName}\nСообщение: ${text}`;
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
