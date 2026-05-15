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
```

`TELEGRAM_WEBHOOK_SECRET` can be any long random string. Telegram will send it back in the `X-Telegram-Bot-Api-Secret-Token` header.

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
- someone replies to one of the bot's messages.

If Telegram privacy mode is enabled for the bot, Telegram may deliver only commands and replies in groups. To let the bot see regular `@username` mentions, disable privacy mode in BotFather with `/setprivacy`.

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
