import OpenAI from "openai";
import { Redis } from "@upstash/redis";
import { timingSafeEqual } from "node:crypto";

export const config = {
  maxDuration: 30,
};

const DEFAULT_MODEL = "gpt-4.1-mini";
const DEFAULT_BOT_USERNAME = "example_minecraft_bot";
const MCP_PROTOCOL_VERSION = "2025-06-18";
const OPENAI_TIMEOUT_MS = 15_000;
const MAX_INPUT_TEXT_LENGTH = 2000;
const MAX_WISH_TEXT_LENGTH = 800;
const MAX_LISTED_WISHES = 20;
let openai;
let redis;

const SYSTEM_PROMPT = `
Ты дружелюбный Telegram-бот для детей примерно 8 лет, которые любят Minecraft.
Отвечай на русском языке простыми словами, тепло и коротко: 2-5 предложений.
Говори только на безопасные темы Minecraft: постройки, биомы, мобы, крафт, фермы, приключения, идеи для игры и творчество.
Если ребенок спрашивает не про Minecraft, мягко верни разговор к Minecraft.
Не проси личные данные, адрес, школу, телефон, фото или контакты. Не предлагай уходить в другие чаты и не давай внешние ссылки.
Не обсуждай взрослые, страшные, опасные или вредные темы. Если вопрос опасный, спокойно откажись и предложи безопасную идею для Minecraft.
Не притворяйся человеком. Ты игровой помощник по Minecraft.
`.trim();

const TOOLS = [
  {
    name: "bot_status",
    description:
      "Return non-secret configuration status for the Minecraft Telegram bot.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "list_website_wishes",
    description:
      "List recent website wishes collected by the Telegram bot. Does not expose personal contact data.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: MAX_LISTED_WISHES,
          description: "Maximum number of wishes to return.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "draft_minecraft_reply",
    description:
      "Draft a kid-friendly Russian Minecraft reply without sending anything to Telegram.",
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          minLength: 1,
          maxLength: MAX_INPUT_TEXT_LENGTH,
          description: "Message to answer as the Minecraft bot.",
        },
        firstName: {
          type: "string",
          maxLength: 40,
          description: "Optional first name for tone only.",
        },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
];

export default async function handler(req, res) {
  if (!hasValidMcpAuth(req)) {
    res.setHeader("WWW-Authenticate", 'Bearer realm="mc-tg-bot-mcp"');
    return res.status(getMcpToken() ? 401 : 503).json({
      ok: false,
      error: getMcpToken() ? "Unauthorized" : "MCP_BEARER_TOKEN is not configured",
    });
  }

  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      service: "mc-tg-bot-mcp",
      transport: "streamable-http",
      protocolVersion: MCP_PROTOCOL_VERSION,
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  let payload;

  try {
    payload = await parseJsonBody(req);
  } catch {
    return res.status(400).json(createError(null, -32700, "Parse error"));
  }

  const requests = Array.isArray(payload) ? payload : [payload];
  const responses = [];

  for (const request of requests) {
    const response = await handleJsonRpcRequest(request);

    if (response) {
      responses.push(response);
    }
  }

  if (responses.length === 0) {
    return res.status(204).end();
  }

  return res.status(200).json(Array.isArray(payload) ? responses : responses[0]);
}

async function handleJsonRpcRequest(request) {
  if (!request || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
    return createError(request?.id ?? null, -32600, "Invalid Request");
  }

  if (request.id === undefined) {
    return null;
  }

  try {
    if (request.method === "initialize") {
      return createResult(request.id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: "mc-tg-bot",
          version: "1.0.0",
        },
      });
    }

    if (request.method === "tools/list") {
      return createResult(request.id, { tools: TOOLS });
    }

    if (request.method === "tools/call") {
      const result = await callTool(request.params);

      return createResult(request.id, result);
    }

    if (request.method === "ping") {
      return createResult(request.id, {});
    }

    return createError(request.id, -32601, "Method not found");
  } catch (error) {
    console.error("mcp request failed", compactError(error));

    return createError(request.id, -32603, error?.message || "Internal error");
  }
}

async function callTool(params) {
  const name = params?.name;
  const args = params?.arguments || {};

  if (name === "bot_status") {
    return createToolResult(getBotStatus());
  }

  if (name === "list_website_wishes") {
    const limit = clampInteger(args.limit, 1, MAX_LISTED_WISHES, MAX_LISTED_WISHES);
    const wishes = await loadWishes(limit);

    return createToolResult({
      count: wishes.length,
      wishes,
      storageConfigured: Boolean(getRedis()),
    });
  }

  if (name === "draft_minecraft_reply") {
    const text = normalizeInputText(args.text);

    if (!text) {
      return createToolResult(
        { error: "text is required" },
        "The text argument is required.",
        true,
      );
    }

    const answer = await createMinecraftAnswer(text, args.firstName);

    return createToolResult({ answer }, answer);
  }

  return createToolResult({ error: `Unknown tool: ${name}` }, `Unknown tool: ${name}`, true);
}

function createToolResult(structuredContent, text, isError = false) {
  return {
    content: [
      {
        type: "text",
        text: text || JSON.stringify(structuredContent, null, 2),
      },
    ],
    structuredContent,
    isError,
  };
}

function getBotStatus() {
  return {
    botUsername: normalizeUsername(process.env.TELEGRAM_BOT_USERNAME || DEFAULT_BOT_USERNAME),
    openaiModel: process.env.OPENAI_MODEL || DEFAULT_MODEL,
    openaiConfigured: Boolean(process.env.OPENAI_API_KEY),
    telegramConfigured: Boolean(process.env.TELEGRAM_BOT_TOKEN),
    telegramWebhookSecretConfigured: Boolean(process.env.TELEGRAM_WEBHOOK_SECRET),
    redisConfigured: Boolean(getRedis()),
    mcpAuthConfigured: Boolean(getMcpToken()),
  };
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

  return (
    response.output_text ||
    "Давай поговорим про Minecraft! Что хочешь построить: дом, замок или секретную базу?"
  ).trim();
}

function buildUserInput(text, firstName) {
  const safeName = sanitizeName(firstName);

  return safeName
    ? `Имя ребенка в Telegram: ${safeName}\n\nНовое сообщение: ${text}`
    : `Новое сообщение: ${text}`;
}

async function loadWishes(limit) {
  const redisClient = getRedis();

  if (!redisClient) {
    return [];
  }

  try {
    const values = await redisClient.lrange(getWishesKey(), 0, limit - 1);

    return values.map(parseStoredWish).filter(Boolean);
  } catch (error) {
    console.warn("redis wishes load failed", compactError(error));
    return [];
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

function hasValidMcpAuth(req) {
  const expectedToken = getMcpToken();
  const actualToken = getBearerToken(req.headers.authorization);

  if (!expectedToken || !actualToken) {
    return false;
  }

  return constantTimeEqual(actualToken, expectedToken);
}

function getMcpToken() {
  return process.env.MCP_BEARER_TOKEN || "";
}

function getBearerToken(value) {
  const match = String(value || "").match(/^Bearer\s+(.+)$/i);

  return match ? match[1].trim() : "";
}

function constantTimeEqual(actual, expected) {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);

  if (actualBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(actualBuffer, expectedBuffer);
}

async function parseJsonBody(req) {
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

  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function createResult(id, result) {
  return {
    jsonrpc: "2.0",
    id,
    result,
  };
}

function createError(id, code, message) {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
    },
  };
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

function getOpenAI() {
  if (!openai) {
    openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }

  return openai;
}

function getWishesKey() {
  return "mc-tg-bot:wishes";
}

function normalizeInputText(text) {
  if (typeof text !== "string") {
    return "";
  }

  return text.replace(/\s+/g, " ").trim().slice(0, MAX_INPUT_TEXT_LENGTH);
}

function sanitizeWishText(text) {
  if (typeof text !== "string") {
    return "";
  }

  return text
    .replace(/https?:\/\/\S+|www\.\S+/gi, "[ссылка скрыта]")
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, "[email скрыт]")
    .replace(/\+?\d[\d\s().-]{6,}\d/g, "[номер скрыт]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_WISH_TEXT_LENGTH);
}

function sanitizeName(name) {
  if (typeof name !== "string") {
    return "";
  }

  return name.replace(/[^\p{L}\p{N} _.-]/gu, "").trim().slice(0, 40);
}

function normalizeUsername(username) {
  return String(username || "")
    .replace(/^@/, "")
    .trim()
    .toLowerCase();
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);

  if (!Number.isInteger(number)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, number));
}

function compactError(error) {
  return {
    name: error?.name,
    message: error?.message,
    status: error?.status,
    code: error?.code,
  };
}
