# Minecraft Telegram Bot

Small Vercel webhook app for a Telegram bot that answers private messages about Minecraft in kid-friendly Russian.

## Environment

Create the same variables in Vercel Project Settings:

```bash
OPENAI_API_KEY=sk-proj...
OPENAI_MODEL=gpt-4.1-mini
TELEGRAM_BOT_TOKEN=123456789:telegram-token
TELEGRAM_BOT_USERNAME=example_minecraft_bot
TELEGRAM_WEBHOOK_SECRET=make-a-long-random-secret
TELEGRAM_ADMIN_IDS=123456789
UPSTASH_REDIS_REST_URL=https://example.upstash.io
UPSTASH_REDIS_REST_TOKEN=example-token
MCP_BEARER_TOKEN=make-a-different-long-random-secret
```

`TELEGRAM_WEBHOOK_SECRET` can be any long random string. Telegram will send it back in the `X-Telegram-Bot-Api-Secret-Token` header.

`TELEGRAM_ADMIN_IDS` is a comma-separated list of Telegram user ids that can read and clear website wishes.
To find your id, send `/myid` to the bot in a private chat.

`UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are optional but enable short conversation memory per Telegram chat. `KV_REST_API_URL` and `KV_REST_API_TOKEN` work too if Redis is attached through Vercel KV. The bot stores only the latest user/bot message chain, trims long messages, hides links/emails/phone-like strings, and expires it after 14 days.

`MCP_BEARER_TOKEN` protects the Codex MCP endpoint. Generate a long random value that is different from the Telegram webhook secret.

## Codex MCP

The same Vercel app exposes a remote MCP endpoint:

```text
https://mc-tg-bot.vercel.app/api/mcp
```

Use Streamable HTTP with:

```text
Authorization: Bearer $MCP_BEARER_TOKEN
```

Codex can be pointed at the remote MCP server with:

```bash
export MCP_BEARER_TOKEN=replace_with_the_real_token
codex mcp add mc-tg-bot-vercel \
  --url https://mc-tg-bot.vercel.app/api/mcp \
  --bearer-token-env-var MCP_BEARER_TOKEN
```

Equivalent `~/.codex/config.toml` entry:

```toml
[mcp_servers.mc-tg-bot-vercel]
url = "https://mc-tg-bot.vercel.app/api/mcp"
bearer_token_env_var = "MCP_BEARER_TOKEN"
enabled = true
```

The MCP server exposes a narrow admin surface:

- `bot_status` checks non-secret production configuration.
- `list_website_wishes` reads recent sanitized `/wish` submissions.
- `draft_minecraft_reply` drafts a kid-friendly Russian Minecraft answer without sending anything to Telegram.

Local smoke test:

```bash
curl http://localhost:3000/api/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $MCP_BEARER_TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

## Website Wishes

Anyone can send a website wish with:

```text
/myid
/wish хочу карту сервера на сайте
```

`/myid` shows the sender's Telegram user id in a private chat, so the id can be added to `TELEGRAM_ADMIN_IDS`.

The bot stores the wish in Redis, trims long text, and hides link/email/phone-like strings before saving. It keeps the latest 100 wishes.

Only users listed in `TELEGRAM_ADMIN_IDS` can use:

```text
/wishes
/clear_wishes
```

Admin commands show or clear wishes only in a private chat with the bot, so the list is not posted into a group by accident. You can leave these commands out of the public BotFather command menu.

## Deploy

```bash
npm install
npm i -g vercel
vercel
vercel --prod
```

After production deploy, set the Telegram webhook:

```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -d "url=https://YOUR-VERCEL-DOMAIN.vercel.app/api/telegram" \
  -d "secret_token=$TELEGRAM_WEBHOOK_SECRET" \
  -d "allowed_updates=[\"message\"]"
```

## Group Chats

The bot replies in private chats by default. In groups and supergroups it replies only when:

- a message mentions `@example_minecraft_bot`;
- a command is addressed to it, for example `/help@example_minecraft_bot`;
- a supported command is sent without a username, for example `/help`, `/start`, `/mc`, or `/minecraft`;
- someone replies to one of the bot's messages.

If Telegram privacy mode is enabled for the bot, Telegram may deliver only bot-specific commands and replies in groups. To let the bot see regular text messages with `@username` mentions, disable privacy mode in BotFather with `/setprivacy` or make the bot a group admin, then remove and add the bot to the group again.

Check the webhook:

```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getWebhookInfo"
```

## Local Smoke Test

Run the Vercel dev server:

```bash
npm start
```

Then send a fake Telegram update:

```bash
curl http://localhost:3000/api/telegram \
  -H "Content-Type: application/json" \
  -H "X-Telegram-Bot-Api-Secret-Token: $TELEGRAM_WEBHOOK_SECRET" \
  -d '{
    "message": {
      "message_id": 1,
      "chat": { "id": 123, "type": "private" },
      "from": { "first_name": "Егор" },
      "text": "Как построить дом в майнкрафте?"
    }
  }'
```

The local test will try to send a real Telegram reply to `chat.id`, so use it with a real chat id or just deploy and message the bot.
