# Repository Guidelines

## Project

This is a small Vercel serverless Telegram bot. The main endpoint is `api/telegram.js`.

The bot should:

- answer all private Telegram messages;
- answer in groups only when directly addressed by mention, bot-specific command, or reply to the bot;
- keep responses kid-friendly for children around 8 years old;
- keep the conversation focused on safe Minecraft topics;
- avoid asking for personal data, photos, contacts, locations, school names, or external chats.

## Development

Use Node.js ESM. Keep dependencies minimal.

Useful commands:

```bash
npm install
npm test
npx vercel --prod --yes
```

`npm test` currently performs a syntax check for the serverless function.

## Environment

Never commit `.env` or real credentials. Use `.env.example` for variable names only.

Required production variables:

- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_BOT_USERNAME`
- `TELEGRAM_WEBHOOK_SECRET`

## Telegram

The production webhook points to:

```text
https://mc-tg-bot.vercel.app/api/telegram
```

If group mentions do not reach the webhook, check BotFather privacy mode with `/setprivacy`.
