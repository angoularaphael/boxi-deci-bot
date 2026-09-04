# BOXPLUS Deciplus Bot — BotHosting

Bot Playwright 24/7 : **reçoit les commandes Vercel → membre → RIB → abo → badge**.

Repo : [boxi-deci-bot](https://github.com/angoularaphael/boxi-deci-bot)  
Boutique : [box-plus.vercel.app](https://box-plus.vercel.app)

---

## Schéma

```
Client paie sur box-plus.vercel.app (Stripe TEST)
        ↓ webhook Stripe
Vercel POST → https://TON-BOT/api/jobs
        ↓
BotHosting : file d'attente + Playwright Deciplus
        ↓
Membre + IBAN + abonnement + badge (auto)
```

---

## 1. Créer l'app BotHosting

| Paramètre | Valeur |
|-----------|--------|
| **Repo GitHub** | `https://github.com/angoularaphael/boxi-deci-bot` |
| **Branche** | `main` |
| **Commande de démarrage** | `node start.js` |
| **Node.js** | 18 ou 20 |

`start.js` fait : `npm install` → `playwright install chromium` → lance le bot.

---

## 2. Volume persistant (obligatoire)

Monter un volume sur le dossier **`data/`** :

| Sous-dossier | Rôle |
|--------------|------|
| `data/session/` | Session Deciplus (évite re-login) |
| `data/queue/` | Commandes en attente |

Sans volume → à chaque redémarrage, session perdue + jobs perdus.

---

## 3. Variables d'environnement BotHosting

Copier `.env.example` → remplir :

```env
# Deciplus
DECIPLUS_URL=https://boxingcenter.deciplus.pro/
DECIPLUS_USER=BRAD
DECIPLUS_PASSWORD=***
DECIPLUS_HEADLESS=true
DECIPLUS_SLOW_MO=50

# HTTP — BotHosting expose souvent PORT automatiquement
BOT_HTTP_PORT=3050
# (ou laisser PORT assigné par BotHosting — le bot le détecte)

# Secret partagé avec Vercel — IDENTIQUE des 2 côtés
SYNC_SECRET=boxplus-test-2026-xxx

# Push catalogue vers la boutique Vercel
STORE_INGEST_URL=https://box-plus.vercel.app/api/admin/ingest-catalog

# Bot loop
BOT_POLL_MS=5000
BOT_MAX_RETRIES=3
BOT_CATALOG_PUSH_ENABLED=true
BOT_CATALOG_PUSH_MS=21600000
```

---

## 4. Variables Vercel (côté boutique)

Dans le dashboard Vercel du projet **box-plus** :

| Variable | Valeur |
|----------|--------|
| `BOXPLUS_BOT_URL` | URL publique du bot BotHosting (ex. `https://boxi-deci-bot.xxx.bothosting.com`) |
| `SYNC_SECRET` | **Même valeur** que sur le bot |
| `STORE_URL` | `https://box-plus.vercel.app` |
| `STRIPE_SECRET_KEY` | `sk_test_...` |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` |

Puis **redéployer** Vercel après avoir ajouté `BOXPLUS_BOT_URL`.

---

## 5. Vérifications après démarrage

### Health check (navigateur ou curl)

```
GET https://TON-BOT/health
```

Réponse attendue :
```json
{"ok":true,"service":"boxi-deci-bot","stats":{...}}
```

### Test envoi commande manuelle

```bash
curl -X POST https://TON-BOT/api/jobs \
  -H "Content-Type: application/json" \
  -H "x-sync-secret: TON_SYNC_SECRET" \
  -d "{\"order_id\":\"TEST-BOT-1\",\"product_name\":\"OFFRE A 29€\",\"gym\":\"minimes\",\"customer\":{\"first_name\":\"Test\",\"last_name\":\"Bot\",\"email\":\"test-unique@example.com\",\"phone\":\"0612345678\",\"birthdate\":\"1990-01-01\",\"gender\":\"M\"},\"payment\":{\"amount\":29,\"status\":\"paid\",\"iban\":\"FR7630001007941234567890185\"}}"
```

Logs BotHosting → `Job reçu depuis boutique` → `Traitement job` → `Job Deciplus traité` (`status: success`).

---

## 6. Test bout en bout (Stripe test)

1. Ouvre **https://box-plus.vercel.app**
2. Choisis une offre → remplis le formulaire (email **unique**, salle, IBAN)
3. Paie avec `4242 4242 4242 4242`
4. Vercel envoie la commande au bot → Deciplus traité en ~1–2 min

**Badge** : ajouté automatiquement après l'abonnement (pas de 2ᵉ achat boutique).

---

## 7. Dépannage

| Problème | Solution |
|----------|----------|
| Paiement OK, rien côté bot | `BOXPLUS_BOT_URL` manquant sur Vercel |
| `401 unauthorized` | `SYNC_SECRET` différent Vercel ↔ bot |
| Playwright crash au démarrage | Attendre fin `playwright install chromium` (1er lancement long) |
| Produit introuvable Deciplus | Attendre sync catalogue ou vérifier nom produit = Deciplus |
| 2 Chrome ouverts | Redémarrer bot (session unique incluse) |

---

## Mise à jour du bot

Depuis la machine dev :

```powershell
cd BOXPLUS
powershell -File scripts/publish-github.ps1
cd ..\boxi-deci-bot
git add -A && git commit -m "sync bot" && git push
```

Puis **redeploy** sur BotHosting (pull `main`).
