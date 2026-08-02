import crypto from "node:crypto";
import bcrypt from "bcryptjs";

const TELEGRAM_API = "https://api.telegram.org";
const MAX_SUPPORT_MESSAGE = 3000;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function maskEmail(email) {
  const value = String(email || "").trim().toLowerCase();
  const at = value.indexOf("@");
  if (at <= 0) return "не указан";
  return `${"•".repeat(Math.min(5, at))}${value.slice(Math.min(5, at))}`;
}

function mainKeyboard() {
  return {
    keyboard: [
      [{ text: "🛟 Поддержка" }, { text: "👤 Профиль" }],
      [{ text: "❓ FAQ" }, { text: "📜 Правила" }],
      [{ text: "🔐 Пароль" }, { text: "🔗 Привязать аккаунт" }]
    ],
    resize_keyboard: true
  };
}

export class ProjectBattleTelegramBot {
  constructor({ token, supabase, sendEmailCode, adminChatIds = [], faqText, rulesText, supportEmail }) {
    this.token = token;
    this.supabase = supabase;
    this.sendEmailCode = sendEmailCode;
    this.adminChatIds = adminChatIds;
    this.faqText = faqText;
    this.rulesText = rulesText;
    this.supportEmail = supportEmail;
    this.states = new Map();
  }

  async api(method, body) {
    const response = await fetch(`${TELEGRAM_API}/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.description || `Telegram ${method} failed`);
    return result.result;
  }

  async send(chatId, text, extra = {}) {
    return this.api("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      ...extra
    });
  }

  async getLinkedUser(telegramUserId) {
    const { data, error } = await this.supabase
      .from("pb_telegram_links")
      .select("telegram_user_id, pb_users(*)")
      .eq("telegram_user_id", telegramUserId)
      .maybeSingle();
    if (error) throw error;
    return data?.pb_users || null;
  }

  async sendWelcome(chatId) {
    await this.send(chatId,
      "<b>Project Battle</b>\n\nПоддержка, информация о проекте и управление привязанным аккаунтом — в одном месте.",
      { reply_markup: mainKeyboard() }
    );
  }

  async linkAccount(chatId, telegramUser, rawCode) {
    const code = String(rawCode || "").trim().toUpperCase();
    if (!/^[A-Z0-9]{8}$/.test(code)) {
      await this.send(chatId, "Код должен состоять из 8 символов. Получите его в профиле лаунчера и пришлите сюда.");
      return;
    }
    const codeHash = crypto.createHash("sha256").update(code).digest("hex");
    const { data: linkCode, error } = await this.supabase
      .from("pb_telegram_link_codes")
      .select("*, pb_users(*)")
      .eq("code_hash", codeHash)
      .is("used_at", null)
      .gt("expires_at", new Date().toISOString())
      .maybeSingle();
    if (error) throw error;
    if (!linkCode?.pb_users) {
      await this.send(chatId, "Этот код не найден или уже истёк. Создайте новый в лаунчере.");
      return;
    }

    const { error: linkError } = await this.supabase.from("pb_telegram_links").upsert({
      telegram_user_id: telegramUser.id,
      user_id: linkCode.user_id,
      telegram_username: telegramUser.username || null,
      updated_at: new Date().toISOString()
    }, { onConflict: "telegram_user_id" });
    if (linkError) throw linkError;
    const { error: usedError } = await this.supabase
      .from("pb_telegram_link_codes")
      .update({ used_at: new Date().toISOString() })
      .eq("id", linkCode.id)
      .is("used_at", null);
    if (usedError) throw usedError;
    this.states.delete(telegramUser.id);
    await this.send(chatId, `Аккаунт <b>${escapeHtml(linkCode.pb_users.nickname)}</b> успешно привязан.`, { reply_markup: mainKeyboard() });
  }

  async createTicket(chatId, telegramUser, category, message) {
    const user = await this.getLinkedUser(telegramUser.id);
    const { data: ticket, error } = await this.supabase.from("pb_support_tickets").insert({
      user_id: user?.id || null,
      telegram_user_id: telegramUser.id,
      category,
      message
    }).select("id").single();
    if (error) throw error;
    const shortId = ticket.id.slice(0, 8).toUpperCase();
    await this.send(chatId, `Заявка <b>#${shortId}</b> принята. Ответ команды придёт сюда.`, { reply_markup: mainKeyboard() });
    const account = user ? `${user.nickname} (${maskEmail(user.email)})` : "не привязан";
    for (const adminChatId of this.adminChatIds) {
      await this.send(adminChatId,
        `<b>Новая заявка #${shortId}</b>\nКатегория: ${escapeHtml(category)}\nАккаунт: ${escapeHtml(account)}\nTelegram: ${escapeHtml(telegramUser.username ? `@${telegramUser.username}` : telegramUser.id)}\n\n${escapeHtml(message)}`
      );
    }
  }

  async startPasswordReset(chatId, telegramUser) {
    const user = await this.getLinkedUser(telegramUser.id);
    if (!user) {
      await this.send(chatId, "Сначала привяжите аккаунт через лаунчер. Это защищает восстановление пароля от чужих запросов.");
      return;
    }
    const code = String(crypto.randomInt(100000, 1000000));
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const { error } = await this.supabase.from("pb_email_codes").insert({
      email: user.email,
      purpose: "reset",
      code,
      expires_at: expiresAt
    });
    if (error) throw error;
    await this.sendEmailCode(user.email, code, "reset");
    this.states.set(telegramUser.id, { type: "password-code", email: user.email, expiresAt: Date.now() + 10 * 60 * 1000 });
    await this.send(chatId, `Код отправлен на ${escapeHtml(maskEmail(user.email))}. Пришлите его сюда. Код действует 10 минут.`);
  }

  async handleState(chatId, telegramUser, text, state) {
    if (state.type === "link") return this.linkAccount(chatId, telegramUser, text);
    if (state.type === "support-category") {
      const categories = ["Ошибка лаунчера", "Проблема с аккаунтом", "Ошибка на сервере", "Жалоба", "Другое"];
      if (!categories.includes(text)) {
        await this.send(chatId, "Выберите категорию кнопкой ниже.", { reply_markup: { keyboard: categories.map((x) => [{ text: x }]), resize_keyboard: true } });
        return;
      }
      this.states.set(telegramUser.id, { type: "support-message", category: text });
      await this.send(chatId, "Опишите проблему одним сообщением. Не присылайте пароль, коды из почты или токены.");
      return;
    }
    if (state.type === "support-message") {
      if (text.length < 5 || text.length > MAX_SUPPORT_MESSAGE) {
        await this.send(chatId, `Сообщение должно быть от 5 до ${MAX_SUPPORT_MESSAGE} символов.`);
        return;
      }
      this.states.delete(telegramUser.id);
      await this.createTicket(chatId, telegramUser, state.category, text);
      return;
    }
    if (state.type === "password-code") {
      if (Date.now() > state.expiresAt || !/^\d{6}$/.test(text)) {
        this.states.delete(telegramUser.id);
        await this.send(chatId, "Код неверный или истёк. Нажмите «🔐 Пароль», чтобы запросить новый.", { reply_markup: mainKeyboard() });
        return;
      }
      const { data, error } = await this.supabase.from("pb_email_codes")
        .select("id")
        .eq("email", state.email).eq("purpose", "reset").eq("code", text)
        .eq("used", false).gt("expires_at", new Date().toISOString()).order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (error) throw error;
      if (!data) {
        await this.send(chatId, "Код неверный. Попробуйте ещё раз или запросите новый.");
        return;
      }
      this.states.set(telegramUser.id, { type: "password-new", email: state.email, codeId: data.id });
      await this.send(chatId, "Теперь пришлите новый пароль (8–128 символов). Не пересылайте его никому — поддержка никогда не просит пароль в заявках.");
      return;
    }
    if (state.type === "password-new") {
      if (text.length < 8 || text.length > 128) {
        await this.send(chatId, "Пароль должен быть длиной от 8 до 128 символов.");
        return;
      }
      const passwordHash = await bcrypt.hash(text, 12);
      const { error: userError } = await this.supabase.from("pb_users").update({ password_hash: passwordHash, updated_at: new Date().toISOString() }).eq("email", state.email);
      if (userError) throw userError;
      const { error: codeError } = await this.supabase.from("pb_email_codes").update({ used: true }).eq("id", state.codeId).eq("used", false);
      if (codeError) throw codeError;
      this.states.delete(telegramUser.id);
      await this.send(chatId, "Пароль изменён. Для безопасности войдите в лаунчер заново.", { reply_markup: mainKeyboard() });
    }
  }

  async handleMessage(message) {
    if (!message?.chat || message.chat.type !== "private" || !message.from || !message.text) return;
    const chatId = message.chat.id;
    const telegramUser = message.from;
    const text = message.text.trim();
    const state = this.states.get(telegramUser.id);
    if (state) {
      await this.handleState(chatId, telegramUser, text, state);
      return;
    }
    const startPayload = text.match(/^\/start(?:\s+(.+))?$/i)?.[1];
    if (text === "/start" || text === "/menu") return this.sendWelcome(chatId);
    if (text === "/myid") return this.send(chatId, `Ваш Telegram ID: <code>${telegramUser.id}</code>\nСообщите его владельцу проекта, чтобы получать уведомления о заявках.`);
    if (startPayload?.startsWith("link_")) return this.linkAccount(chatId, telegramUser, startPayload.slice(5));
    if (text === "🔗 Привязать аккаунт") {
      this.states.set(telegramUser.id, { type: "link" });
      return this.send(chatId, "Откройте профиль в лаунчере → «Привязать Telegram», затем пришлите сюда одноразовый код.");
    }
    if (text === "👤 Профиль") {
      const user = await this.getLinkedUser(telegramUser.id);
      return this.send(chatId, user
        ? `<b>Профиль Project Battle</b>\nНик: <b>${escapeHtml(user.nickname)}</b>\nEmail: ${escapeHtml(maskEmail(user.email))}\nРоль: ${escapeHtml(user.role || "user")}`
        : "Аккаунт пока не привязан. Нажмите «🔗 Привязать аккаунт»."
      );
    }
    if (text === "❓ FAQ") return this.send(chatId, this.faqText);
    if (text === "📜 Правила") return this.send(chatId, this.rulesText);
    if (text === "🛟 Поддержка") {
      this.states.set(telegramUser.id, { type: "support-category" });
      return this.send(chatId, "Выберите категорию обращения.", { reply_markup: { keyboard: ["Ошибка лаунчера", "Проблема с аккаунтом", "Ошибка на сервере", "Жалоба", "Другое"].map((x) => [{ text: x }]), resize_keyboard: true } });
    }
    if (text === "🔐 Пароль") return this.startPasswordReset(chatId, telegramUser);
    return this.send(chatId, "Выберите действие в меню ниже.", { reply_markup: mainKeyboard() });
  }

  async handleUpdate(update) {
    if (update?.message) await this.handleMessage(update.message);
  }
}
