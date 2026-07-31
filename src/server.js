import "dotenv/config";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import jwt from "jsonwebtoken";
import { Resend } from "resend";
import { createClient } from "@supabase/supabase-js";

const requiredEnv = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "RESEND_API_KEY",
  "RESEND_FROM",
  "JWT_SECRET",
  "MINECRAFT_SERVER_SECRET"
];

for (const key of requiredEnv) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

const app = express();
const port = Number(process.env.PORT || 3000);
const sessionDays = Number(process.env.SESSION_DAYS || 14);
const emailCodeTtlMinutes = Number(process.env.EMAIL_CODE_TTL_MINUTES || 10);
const minecraftTicketTtlMinutes = Number(process.env.MINECRAFT_TICKET_TTL_MINUTES || 30);
const externalTimeoutMs = Number(process.env.EXTERNAL_TIMEOUT_MS || 25000);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});
const resend = new Resend(process.env.RESEND_API_KEY);

const allowedOrigins = (process.env.CORS_ORIGINS || "*")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(helmet());
app.use(express.json({ limit: "64kb" }));
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes("*") || allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error("Origin is not allowed"));
  }
}));

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function normalizeNickname(nickname) {
  return String(nickname || "").trim();
}

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validateNickname(nickname) {
  return /^[A-Za-z0-9_]{3,16}$/.test(nickname);
}

function validatePassword(password) {
  return typeof password === "string" && password.length >= 8 && password.length <= 128;
}

function generateCode() {
  return String(crypto.randomInt(100000, 1000000));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    nickname: user.nickname,
    emailVerified: user.email_verified,
    role: user.role || "user"
  };
}

function maskEmail(email) {
  const value = normalizeEmail(email);
  const at = value.indexOf("@");
  if (at <= 0) return "*****";
  const visible = value.slice(Math.min(5, at));
  return `${"*".repeat(Math.min(5, at))}${visible}${value.slice(at)}`;
}

function sendError(res, status, code, message) {
  res.status(status).json({ ok: false, code, message });
}

function withTimeout(promise, label, timeoutMs = externalTimeoutMs) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${label} timed out`);
      error.status = 504;
      error.code = "TIMEOUT";
      reject(error);
    }, timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function sendEmailCode(email, code, purpose) {
  const title = purpose === "reset" ? "Password reset code" : "Project Battle verification code";
  const result = await withTimeout(resend.emails.send({
    from: process.env.RESEND_FROM,
    to: email,
    subject: title,
    html: `
      <div style="font-family:Arial,sans-serif;background:#101312;color:#f2f0e7;padding:24px">
        <h2 style="margin:0 0 16px">Project Battle</h2>
        <p>Your verification code:</p>
        <div style="font-size:32px;font-weight:700;letter-spacing:6px">${code}</div>
        <p style="color:#a9afa9">The code expires in ${emailCodeTtlMinutes} minutes.</p>
      </div>
    `
  }), "Email provider");

  if (result?.error) {
    const error = new Error(result.error.message || "Email provider error");
    error.status = 502;
    error.code = result.error.name || "EMAIL_PROVIDER_ERROR";
    throw error;
  }
}

app.get("/debug/config", (_req, res) => {
  res.json({
    ok: true,
    hasSupabaseUrl: Boolean(process.env.SUPABASE_URL),
    hasSupabaseServiceRoleKey: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    hasResendApiKey: Boolean(process.env.RESEND_API_KEY),
    resendFrom: process.env.RESEND_FROM || null,
    hasJwtSecret: Boolean(process.env.JWT_SECRET),
    hasMinecraftServerSecret: Boolean(process.env.MINECRAFT_SERVER_SECRET),
    emailCodeTtlMinutes,
    sessionDays,
    externalTimeoutMs
  });
});

async function createSession(user) {
  const token = crypto.randomBytes(48).toString("base64url");
  const expiresAt = new Date(Date.now() + sessionDays * 24 * 60 * 60 * 1000);
  const { error } = await withTimeout(supabase.from("pb_sessions").insert({
    user_id: user.id,
    token_hash: sha256(token),
    expires_at: expiresAt.toISOString()
  }), "Database session insert");
  if (error) throw error;

  const jwtToken = jwt.sign(
    { sid: sha256(token), uid: user.id, nickname: user.nickname },
    process.env.JWT_SECRET,
    { expiresIn: `${sessionDays}d`, issuer: "project-battle-auth" }
  );

  return {
    token,
    jwt: jwtToken,
    expiresAt: expiresAt.toISOString()
  };
}

async function authenticatedUser(req) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) return null;

  const { data: session, error } = await withTimeout(supabase
    .from("pb_sessions")
    .select("*, pb_users(*)")
    .eq("token_hash", sha256(token))
    .gt("expires_at", new Date().toISOString())
    .maybeSingle(), "Database authenticated session lookup");
  if (error) throw error;
  return session?.pb_users || null;
}

async function getUserByEmail(email) {
  const { data, error } = await withTimeout(supabase
    .from("pb_users")
    .select("*")
    .eq("email", email)
    .maybeSingle(), "Database get user by email");
  if (error) throw error;
  return data;
}

async function getUserByNickname(nickname) {
  const { data, error } = await withTimeout(supabase
    .from("pb_users")
    .select("*")
    .eq("nickname", nickname)
    .maybeSingle(), "Database get user by nickname");
  if (error) throw error;
  return data;
}

async function verifyCode(email, code, purpose) {
  const { data, error } = await withTimeout(supabase
    .from("pb_email_codes")
    .select("*")
    .eq("email", email)
    .eq("purpose", purpose)
    .eq("code", String(code || "").trim())
    .eq("used", false)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle(), "Database verify code");
  if (error) throw error;
  if (!data) return false;

  const { error: updateError } = await withTimeout(supabase
    .from("pb_email_codes")
    .update({ used: true })
    .eq("id", data.id), "Database mark code used");
  if (updateError) throw updateError;
  return true;
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "project-battle-auth-api" });
});

app.post("/auth/start-register", async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body.email);
    if (!validateEmail(email)) {
      sendError(res, 400, "INVALID_EMAIL", "Invalid email");
      return;
    }

    const existing = await getUserByEmail(email);
    if (existing?.email_verified) {
      sendError(res, 409, "EMAIL_ALREADY_REGISTERED", "Email already registered");
      return;
    }

    if (!existing) {
      const { error } = await withTimeout(supabase.from("pb_users").insert({ email }), "Database user insert");
      if (error) throw error;
    }

    const code = generateCode();
    const expiresAt = new Date(Date.now() + emailCodeTtlMinutes * 60 * 1000);
    const { error } = await withTimeout(supabase.from("pb_email_codes").insert({
      email,
      purpose: "register",
      code,
      expires_at: expiresAt.toISOString()
    }), "Database email code insert");
    if (error) throw error;

    await sendEmailCode(email, code, "register");
    res.json({ ok: true, message: "Verification code sent" });
  } catch (error) {
    next(error);
  }
});

app.post("/auth/verify-email", async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body.email);
    const valid = await verifyCode(email, req.body.code, "register");
    if (!valid) {
      sendError(res, 400, "INVALID_CODE", "Invalid or expired code");
      return;
    }

    const { data, error } = await withTimeout(supabase
      .from("pb_users")
      .update({ email_verified: true, updated_at: new Date().toISOString() })
      .eq("email", email)
      .select("*")
      .single(), "Database verify email update");
    if (error) throw error;

    res.json({ ok: true, user: publicUser(data) });
  } catch (error) {
    next(error);
  }
});

app.post("/auth/finish-register", async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body.email);
    const nickname = normalizeNickname(req.body.nickname);
    const password = req.body.password;

    if (!validateNickname(nickname)) {
      sendError(res, 400, "INVALID_NICKNAME", "Nickname must be 3-16 chars: A-Z, a-z, 0-9, _");
      return;
    }
    if (!validatePassword(password)) {
      sendError(res, 400, "INVALID_PASSWORD", "Password must be 8-128 chars");
      return;
    }

    const user = await getUserByEmail(email);
    if (!user || !user.email_verified) {
      sendError(res, 403, "EMAIL_NOT_VERIFIED", "Email is not verified");
      return;
    }
    if (user.password_hash) {
      sendError(res, 409, "ACCOUNT_ALREADY_FINISHED", "Account already finished");
      return;
    }

    const nickOwner = await getUserByNickname(nickname);
    if (nickOwner && nickOwner.id !== user.id) {
      sendError(res, 409, "NICKNAME_TAKEN", "Nickname already taken");
      return;
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const { data, error } = await withTimeout(supabase
      .from("pb_users")
      .update({
        nickname,
        password_hash: passwordHash,
        updated_at: new Date().toISOString()
      })
      .eq("id", user.id)
      .select("*")
      .single(), "Database finish register update");
    if (error) throw error;

    const session = await createSession(data);
    res.json({ ok: true, user: publicUser(data), session });
  } catch (error) {
    next(error);
  }
});

app.post("/auth/login", async (req, res, next) => {
  try {
    const login = String(req.body.login || "").trim();
    const password = req.body.password;
    const isEmail = login.includes("@");
    const user = isEmail ? await getUserByEmail(normalizeEmail(login)) : await getUserByNickname(login);

    if (!user || !user.password_hash) {
      sendError(res, 401, "INVALID_LOGIN", "Invalid login or password");
      return;
    }

    const matches = await bcrypt.compare(String(password || ""), user.password_hash);
    if (!matches) {
      sendError(res, 401, "INVALID_LOGIN", "Invalid login or password");
      return;
    }

    if (!user.email_verified) {
      sendError(res, 403, "EMAIL_NOT_VERIFIED", "Email is not verified");
      return;
    }

    const code = generateCode();
    const expiresAt = new Date(Date.now() + emailCodeTtlMinutes * 60 * 1000);
    const { error } = await withTimeout(supabase.from("pb_email_codes").insert({
      email: user.email,
      purpose: "login",
      code,
      expires_at: expiresAt.toISOString()
    }), "Database login code insert");
    if (error) throw error;

    await sendEmailCode(user.email, code, "login");
    res.json({
      ok: true,
      requiresCode: true,
      emailMasked: maskEmail(user.email),
      nickname: user.nickname
    });
  } catch (error) {
    next(error);
  }
});

app.post("/auth/verify-login", async (req, res, next) => {
  try {
    const login = String(req.body.login || "").trim();
    const isEmail = login.includes("@");
    const user = isEmail ? await getUserByEmail(normalizeEmail(login)) : await getUserByNickname(login);
    if (!user || !user.password_hash || !user.email_verified) {
      sendError(res, 401, "INVALID_LOGIN", "Invalid login");
      return;
    }

    const valid = await verifyCode(user.email, req.body.code, "login");
    if (!valid) {
      sendError(res, 400, "INVALID_CODE", "Invalid or expired code");
      return;
    }

    const session = await createSession(user);
    res.json({ ok: true, user: publicUser(user), session });
  } catch (error) {
    next(error);
  }
});

app.post("/auth/forgot-password", async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body.email);
    if (!validateEmail(email)) {
      sendError(res, 400, "INVALID_EMAIL", "Invalid email");
      return;
    }

    const user = await getUserByEmail(email);
    if (user) {
      const code = generateCode();
      const expiresAt = new Date(Date.now() + emailCodeTtlMinutes * 60 * 1000);
      const { error } = await withTimeout(supabase.from("pb_email_codes").insert({
        email,
        purpose: "reset",
        code,
        expires_at: expiresAt.toISOString()
      }), "Database reset code insert");
      if (error) throw error;
      await sendEmailCode(email, code, "reset");
    }

    res.json({ ok: true, message: "If the account exists, a reset code was sent" });
  } catch (error) {
    next(error);
  }
});

app.post("/auth/reset-password", async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body.email);
    const password = req.body.password;
    if (!validatePassword(password)) {
      sendError(res, 400, "INVALID_PASSWORD", "Password must be 8-128 chars");
      return;
    }

    const valid = await verifyCode(email, req.body.code, "reset");
    if (!valid) {
      sendError(res, 400, "INVALID_CODE", "Invalid or expired code");
      return;
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const { error } = await withTimeout(supabase
      .from("pb_users")
      .update({ password_hash: passwordHash, updated_at: new Date().toISOString() })
      .eq("email", email), "Database reset password update");
    if (error) throw error;

    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get("/auth/me", async (req, res, next) => {
  try {
    const user = await authenticatedUser(req);
    if (!user) {
      sendError(res, 401, "INVALID_TOKEN", "Invalid token");
      return;
    }

    res.json({ ok: true, user: publicUser(user) });
  } catch (error) {
    next(error);
  }
});

app.post("/auth/logout", async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (token) {
      await withTimeout(supabase.from("pb_sessions").delete().eq("token_hash", sha256(token)), "Database logout");
    }
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post("/auth/minecraft/ticket", async (req, res, next) => {
  try {
    const user = await authenticatedUser(req);
    if (!user?.email_verified || !user.nickname) {
      sendError(res, 401, "INVALID_TOKEN", "Valid Project Battle account required");
      return;
    }

    const ticket = crypto.randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + minecraftTicketTtlMinutes * 60 * 1000);
    const { error } = await withTimeout(supabase.from("pb_game_tickets").insert({
      user_id: user.id,
      nickname: user.nickname,
      token_hash: sha256(ticket),
      expires_at: expiresAt.toISOString()
    }), "Database game ticket insert");
    if (error) throw error;

    res.json({
      ok: true,
      ticket,
      nickname: user.nickname,
      expiresAt: expiresAt.toISOString()
    });
  } catch (error) {
    next(error);
  }
});

app.post("/auth/minecraft/verify", async (req, res, next) => {
  try {
    const serverSecret = req.headers["x-server-secret"];
    if (serverSecret !== process.env.MINECRAFT_SERVER_SECRET) {
      sendError(res, 403, "BAD_SERVER_SECRET", "Bad server secret");
      return;
    }

    const nickname = normalizeNickname(req.body.nickname);
    const ticket = String(req.body.ticket || req.body.token || "");
    if (!nickname || !ticket) {
      sendError(res, 400, "BAD_REQUEST", "nickname and ticket are required");
      return;
    }

    const { data: gameTicket, error } = await withTimeout(supabase
      .from("pb_game_tickets")
      .select("*, pb_users(*)")
      .eq("token_hash", sha256(ticket))
      .is("used_at", null)
      .gt("expires_at", new Date().toISOString())
      .maybeSingle(), "Database minecraft ticket lookup");
    if (error) throw error;

    const user = gameTicket?.pb_users;
    const allowed = Boolean(user?.email_verified && user.nickname === nickname && gameTicket.nickname === nickname);
    if (allowed) {
      const { error: consumeError } = await withTimeout(supabase
        .from("pb_game_tickets")
        .update({ used_at: new Date().toISOString() })
        .eq("id", gameTicket.id)
        .is("used_at", null), "Database consume game ticket");
      if (consumeError) throw consumeError;
    }
    res.json({
      ok: true,
      allowed,
      nickname: user?.nickname || null,
      reason: allowed ? null : "Invalid or expired Project Battle game ticket"
    });
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  console.error(error);
  const status = Number(error.status || 500);
  const detail = error?.message || error?.details || error?.hint || error?.code;
  res.status(status).json({
    ok: false,
    code: error.code || "INTERNAL_ERROR",
    message: detail || "Internal server error"
  });
});

app.listen(port, () => {
  console.log(`Project Battle Auth API listening on port ${port}`);
  supabase
    .from("pb_users")
    .select("id", { count: "exact", head: true })
    .then(({ error }) => {
      if (error) {
        console.error("Supabase startup check failed:", error);
      } else {
        console.log("Supabase startup check passed.");
      }
    })
    .catch((error) => console.error("Supabase startup check failed:", error));
});
