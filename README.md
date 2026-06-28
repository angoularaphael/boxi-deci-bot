# BOXPLUS Deciplus Bot (RPA)

Bot Playwright : **membre → RIB → abonnement → badge**.

Repo principal boutique : [box-plus](https://github.com/angoularaphael/box-plus)

## BotHosting / VPS

```bash
git clone https://github.com/angoularaphael/boxi-deci-bot.git
cd boxi-deci-bot
cp .env.example .env
# Remplir DECIPLUS_* et STORE_INGEST_URL + SYNC_SECRET
node start.js
```

`start.js` installe les dépendances, Playwright Chromium, puis lance le bot en boucle.

## Variables `.env`

| Variable | Description |
|----------|-------------|
| `DECIPLUS_URL` | https://boxingcenter.deciplus.pro/ |
| `DECIPLUS_USER` / `DECIPLUS_PASSWORD` | Compte manager |
| `STORE_INGEST_URL` | URL ingest catalogue Vercel |
| `SYNC_SECRET` | Même secret que la boutique |
| `BOT_CATALOG_PUSH_MS` | Intervalle push catalogue (défaut 6h) |

## Sync catalogue

Le bot synchronise Deciplus et pousse le catalogue vers la boutique Vercel automatiquement (plus besoin de `npm run store:sync` manuel).

## File d'attente

Le bot expose `POST /api/jobs` (port `BOT_HTTP_PORT`, défaut 3050).  
La boutique Vercel envoie les commandes Stripe ici via `BOXPLUS_BOT_URL`.

Sur BotHosting, monter un volume persistant sur `data/` (session + queue).
