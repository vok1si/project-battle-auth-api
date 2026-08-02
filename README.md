# Project Battle Auth API

Backend for Project Battle account registration, email verification, login, password reset, and Minecraft server session checks.

## What This API Does

- Sends email verification codes through Resend.
- Stores users, codes, and sessions in Supabase PostgreSQL.
- Lets the launcher register/login players.
- Lets the Minecraft server mod verify that a player has a valid Project Battle session.

## 1. Supabase Setup

Create a Supabase project and save:

```env
SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_secret_service_role_key
```

Open Supabase SQL Editor and run:

```sql
-- paste sql/schema.sql here
```

If tables already exist, this file is safe to run again because it uses `if not exists`.

## 2. Resend Setup

Verify the domain and save:

```env
RESEND_API_KEY=your_secret_resend_key
RESEND_FROM=Project Battle <noreply@projectbattle.online>
```

Do not put these secrets into GitHub.

## 3. Local Setup

Install Node.js 20 or newer.

```powershell
cd work\ProjectBattleAuthApi
npm install
Copy-Item .env.example .env
```

Open `.env` and paste your real secrets.

Generate two long random secrets for:

```env
JWT_SECRET=...
MINECRAFT_SERVER_SECRET=...
```

Then run:

```powershell
npm run dev
```

Check:

```text
http://localhost:3000/health
```

## 4. Deploy To Render

1. Create a new GitHub repository, for example `project-battle-auth-api`.
2. Upload this whole `ProjectBattleAuthApi` folder.
3. Go to Render.
4. Click **New +**.
5. Click **Web Service**.
6. Connect the GitHub repository.
7. Runtime: **Node**.
8. Build command:
   ```text
   npm install
   ```
9. Start command:
   ```text
   npm start
   ```
10. Add Environment Variables:
   ```env
   SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=your_secret_service_role_key
   RESEND_API_KEY=your_secret_resend_key
   RESEND_FROM=Project Battle <noreply@projectbattle.online>
   JWT_SECRET=your_long_random_secret
   MINECRAFT_SERVER_SECRET=your_other_long_random_secret
   SESSION_DAYS=14
   EMAIL_CODE_TTL_MINUTES=10
   MINECRAFT_TICKET_TTL_MINUTES=30
   EXTERNAL_TIMEOUT_MS=25000
   CORS_ORIGINS=*
   ```
11. Deploy.

Render will give you a URL like:

```text
https://project-battle-auth-api.onrender.com
```

That URL is what the launcher and Minecraft auth mod will use.

## 5. API Endpoints

### Start Registration

```http
POST /auth/start-register
Content-Type: application/json

{
  "email": "player@example.com"
}
```

### Verify Email Code

```http
POST /auth/verify-email
Content-Type: application/json

{
  "email": "player@example.com",
  "code": "123456"
}
```

### Finish Registration

```http
POST /auth/finish-register
Content-Type: application/json

{
  "email": "player@example.com",
  "nickname": "Player_123",
  "password": "strongpassword"
}
```

Returns:

```json
{
  "ok": true,
  "user": {},
  "session": {
    "token": "launcher_token",
    "jwt": "jwt_token",
    "expiresAt": "..."
  }
}
```

The launcher should store `session.token`.

### Login

```http
POST /auth/login
Content-Type: application/json

{
  "login": "Player_123",
  "password": "strongpassword"
}
```

`login` can be nickname or email.

### Current User

```http
GET /auth/me
Authorization: Bearer launcher_token
```

### Password Reset

```http
POST /auth/forgot-password
POST /auth/reset-password
```

### Minecraft Server Verification

Only the server-side mod should call this endpoint.

```http
POST /auth/minecraft/verify
X-Server-Secret: MINECRAFT_SERVER_SECRET
Content-Type: application/json

{
  "nickname": "Player_123",
  "token": "launcher_token"
}
```

Returns:

```json
{
  "ok": true,
  "allowed": true,
  "nickname": "Player_123",
  "reason": null
}
```

## 6. Important Security Notes

- Never put `SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`, or `MINECRAFT_SERVER_SECRET` inside launcher code.
- The launcher only receives the player session token.
- The Minecraft server mod should keep `MINECRAFT_SERVER_SECRET` only on the server.
- Because the Minecraft server is offline-mode, the server-side auth mod is required. Without it, players can spoof nicknames.

## 7. Telegram Bot

The Telegram bot is built into this API. It provides support tickets, FAQ, rules, linked-account profiles, and password reset confirmed through the account email.

1. In Telegram, open `@BotFather` and send `/newbot`.
2. Choose a display name, then a unique username ending in `bot` (for example `ProjectBattleSupportBot`).
3. Copy the token BotFather sends. It is a secret: never put it in GitHub or the launcher.
4. In Render, add these environment variables:

```env
PUBLIC_BASE_URL=https://your-existing-auth-service.onrender.com
TELEGRAM_BOT_TOKEN=token_from_botfather
TELEGRAM_WEBHOOK_SECRET=a_long_random_value
TELEGRAM_ADMIN_CHAT_IDS=your_telegram_numeric_chat_id
```

5. Run `sql/upgrade-0.2.0-telegram.sql` once in the Supabase SQL Editor and redeploy.

On startup the API registers `https://your-existing-auth-service.onrender.com/telegram/webhook` automatically. Telegram will then expose the bot at `https://t.me/your_bot_username`.

The launcher should call `POST /auth/telegram/link-code` with the existing account token. It returns a one-time link such as `https://t.me/your_bot_username?start=link_AB12CD34`; opening it links the player's Telegram profile without asking for their launcher password.
