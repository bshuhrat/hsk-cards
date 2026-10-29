// Telegram-бот «Китайский каждый день» (HSK 3.0) на Cloudflare Workers.
//
// * Кнопки работают сразу: Telegram присылает каждое нажатие на адрес воркера (webhook).
// * Раз в 10 минут воркер проверяет, у кого наступило выбранное время, и отправляет урок.
// * Данные (настройки, ответы, повторения) хранятся в Workers KV.
// * Администратор (/admin — первый, кто отправит) получает уведомления о пользователях и отзывы
//   и кнопку «👥 Пользователи» со списком и статистикой.
// * Слова берутся из daily_quiz.py при установке (см. .github/workflows/daily-quiz.yaml).
import WORDS from "./words.json";

// ---------------- Настройки ----------------
const LEVELS = [1, 2, 3, 4, 5];            // уровни HSK
const DEFAULT_LEVEL = 1;                   // уровень для новых подписчиков
const MAIN_LEVEL_SHARE = 0.6;              // доля вопросов из выбранного уровня, остальные — из уровней ниже
const SEND_HOURS = [8, 10, 13, 18, 21];    // варианты времени отправки (часы по Москве)
const DEFAULT_HOUR = 13;
const QUESTIONS_PER_DAY = 5;
const QUESTION_TYPES = ["py2han", "han2ru", "ru2han"];
const REVIEW_PER_DAY = 2;                  // сколько слов с ошибками повторять в урок
const MAX_LESSONS_PER_RUN = 7;             // лимит бесплатного тарифа: ~50 запросов за запуск
const CARDS_URL = "https://bshuhrat.github.io/hsk-cards/";
const BTN_LESSON = "▶️ Урок сейчас";
const BTN_SETTINGS = "⚙️ Настройки";
const BTN_USERS = "👥 Пользователи";             // только у администратора
const BTN_FEEDBACK = "💬 Отзыв";
const FEEDBACK_WAIT = 15 * 60000;                // сколько ждать текст отзыва после нажатия кнопки
const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля",
  "августа", "сентября", "октября", "ноября", "декабря"];
// -------------------------------------------

// слово: [id, иероглифы, пиньинь, перевод, уровень, эмодзи]
const BY_ID = new Map(WORDS.map((w) => [w[0], w]));
const BY_LEVEL = new Map(LEVELS.map((lv) => [lv, WORDS.filter((w) => w[4] === lv)]));
const DAY = 86400000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/telegram") {
      return new Response("HSK quiz bot работает");
    }
    if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== await webhookSecret(env)) {
      return new Response("forbidden", { status: 403 });
    }
    const update = await request.json();
    try {
      await handleUpdate(env, update);
    } catch (e) {
      console.log("Ошибка при обработке:", e && e.stack || e);
    }
    return new Response("ok"); // всегда 200, иначе Telegram будет повторять
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(sendDue(env));
  },
};

// ---------- утилиты ----------
async function webhookSecret(env) {
  const data = new TextEncoder().encode("hsk-webhook:" + env.TELEGRAM_BOT_TOKEN);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return [...hash].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 48);
}

async function api(env, method, params) {
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const data = await r.json().catch(() => ({}));
  if (!data.ok) throw new Error(`${method}: ${data.description || r.status}`);
  return data.result;
}

async function quiet(promise) {
  try { return await promise; } catch (e) { return null; }
}

function mskNow() {
  return new Date(Date.now() + 3 * 3600000); // поля getUTC* = московское время
}

function isoDay(d) {
  return d.toISOString().slice(0, 10);
}

function today() {
  return isoDay(mskNow());
}

function daysBetween(a, b) {
  return Math.round((Date.parse(b) - Date.parse(a)) / DAY);
}

function shortRu(s, limit = 100) {
  s = s.split(";")[0].trim();
  return s.length <= limit ? s : s.slice(0, limit - 1) + "…";
}

function choice(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ---------- хранилище ----------
// admin          — чат администратора (тот, кто первым отправил /admin)
// s:<чат>        — настройки и профиль подписчика
// u:<чат>        — прогресс: повторения, показанные слова, итоги по дням, дата последнего урока
// p:<опрос>      — к какому слову относится викторина (живёт 3 дня)
// a:<чат>:<опрос> — ответ на викторину (учитывается в прогрессе перед следующим уроком)
async function getJSON(env, key) {
  return await env.KV.get(key, "json");
}

async function getSub(env, cid) {
  return await getJSON(env, "s:" + cid);
}

async function putSub(env, cid, sub) {
  await env.KV.put("s:" + cid, JSON.stringify(sub));
}

function newSub(from) {
  return { since: today(), level: DEFAULT_LEVEL, hour: DEFAULT_HOUR, paused: false, ...profile(from) };
}

async function getProgress(env, cid) {
  return (await getJSON(env, "u:" + cid)) ||
    { review: [], seen: {}, right: 0, wrong: 0, days: {}, last_sent: null };
}

// ---------- профиль и администратор ----------
function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function profile(from) {
  from = from || {};
  return {
    name: [from.first_name, from.last_name].filter(Boolean).join(" "),
    username: from.username || "",
    lang: from.language_code || "",
    premium: !!from.is_premium,
  };
}

// обновляет имя/username, если человек их поменял; true — если что-то изменилось
function refreshProfile(sub, from) {
  const p = profile(from);
  let changed = false;
  for (const k of Object.keys(p)) {
    if (sub[k] !== p[k]) {
      sub[k] = p[k];
      changed = true;
    }
  }
  return changed;
}

function fmtDate(iso) {
  return iso ? iso.split("-").reverse().join(".") : "—";
}

async function adminId(env) {
  return await env.KV.get("admin");
}

async function userCard(env, cid, sub, us) {
  const chat = (await quiet(api(env, "getChat", { chat_id: cid }))) || {};
  const name = [chat.first_name, chat.last_name].filter(Boolean).join(" ") || sub.name || "без имени";
  const username = chat.username || sub.username;
  const lines = [
    `👤 <b>${esc(name)}</b>`,
    username ? `🔗 @${esc(username)}` : "🔗 без username",
    `🆔 <code>${esc(cid)}</code> · <a href="tg://user?id=${esc(cid)}">открыть профиль</a>`,
  ];
  const extra = [];
  if (sub.lang) extra.push(`🌐 ${esc(sub.lang)}`);
  if (sub.premium) extra.push("⭐ Premium");
  if (chat.birthdate) {
    const b = chat.birthdate;
    extra.push(`🎂 ${String(b.day).padStart(2, "0")}.${String(b.month).padStart(2, "0")}${b.year ? "." + b.year : ""}`);
  }
  if (extra.length) lines.push(extra.join(" · "));
  if (chat.bio) lines.push(`📝 ${esc(chat.bio)}`);
  lines.push(`📅 с ${fmtDate(sub.since)}`);
  const status = sub.blocked ? "🚫 заблокировал бота" : sub.paused ? "⏸ на паузе" : `⏰ ${String(sub.hour).padStart(2, "0")}:00`;
  lines.push(`📚 HSK ${sub.level} · ${status}`);
  if (us) {
    const total = us.right + us.wrong;
    const pct = total ? Math.round((us.right * 100) / total) : 0;
    lines.push(`✅ ${us.right} · ❌ ${us.wrong}` + (total ? ` (${pct}%)` : "") +
      ` · 🔁 ${us.review.length} · последний урок ${fmtDate(us.last_sent)}`);
  }
  return lines.join("\n");
}

async function notifyAdmin(env, cid, title, sub, withPhoto = false) {
  const admin = await adminId(env);
  if (!admin || admin === cid) return;
  const text = `${title}\n\n${await userCard(env, cid, sub, null)}`;
  if (withPhoto) {
    const photos = await quiet(api(env, "getUserProfilePhotos", { user_id: +cid, limit: 1 }));
    const sizes = photos && photos.photos && photos.photos[0];
    if (sizes && sizes.length && text.length <= 1024) {
      const ok = await quiet(api(env, "sendPhoto", {
        chat_id: admin, photo: sizes[sizes.length - 1].file_id, caption: text, parse_mode: "HTML",
      }));
      if (ok) return;
    }
  }
  await quiet(api(env, "sendMessage", { chat_id: admin, text, parse_mode: "HTML", link_preview_options: { is_disabled: true } }));
}

async function sendUsers(env, cid) {
  const cards = [];
  let active = 0;
  let cursor;
  do {
    const r = await env.KV.list({ prefix: "s:", cursor });
    for (const k of r.keys) {
      const ucid = k.name.slice(2);
      const sub = await getSub(env, ucid);
      if (!sub) continue;
      const us = await getProgress(env, ucid);
      await foldAnswers(env, ucid, us, true); // учесть ответы, которые ещё не попали в прогресс
      if (!sub.paused && !sub.blocked) active += 1;
      cards.push({ since: sub.since, text: await userCard(env, ucid, sub, us) });
    }
    cursor = r.list_complete ? null : r.cursor;
  } while (cursor);
  cards.sort((a, b) => (a.since < b.since ? -1 : 1));
  let msg = `👥 <b>Пользователи: ${cards.length}</b> (активных ${active})`;
  const chunks = [];
  cards.forEach((c, i) => {
    const part = `\n\n<b>${i + 1}.</b> ${c.text}`;
    if ((msg + part).length > 3800) {
      chunks.push(msg);
      msg = part.trim();
    } else {
      msg += part;
    }
  });
  chunks.push(msg);
  for (const m of chunks) {
    await api(env, "sendMessage", { chat_id: cid, text: m, parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  }
}

// ---------- кнопки ----------
function replyKeyboard(isAdmin) {
  const rows = [[{ text: BTN_LESSON }, { text: BTN_SETTINGS }],
    isAdmin ? [{ text: BTN_FEEDBACK }, { text: BTN_USERS }] : [{ text: BTN_FEEDBACK }]];
  return {
    keyboard: rows, resize_keyboard: true, is_persistent: true,
    input_field_placeholder: "Пользуйтесь кнопками 👇",
  };
}

function hh(h) {
  return String(h).padStart(2, "0") + ":00";
}

function settingsText(sub) {
  const lv = sub.level;
  const scope = lv === 1 ? "вопросы только из HSK 1" : `в основном HSK ${lv}, часть — из HSK 1–${lv - 1}`;
  const when = sub.paused ? "⏸ <b>на паузе</b>" : `⏰ Время: <b>${hh(sub.hour)}</b> по Москве`;
  return "⚙️ <b>Настройки</b>\n\n" +
    `📚 Уровень: <b>HSK ${lv}</b>\n<i>${scope}</i>\n\n` +
    `${when}\n\n` +
    "Выберите уровень и время 👇";
}

function settingsKeyboard(sub) {
  const btn = (text, data, on) => ({ text: on ? `• ${text} •` : text, callback_data: data });
  const lv = LEVELS.map((x) => btn(`HSK ${x}`, `lv:${x}`, sub.level === x));
  const hr = SEND_HOURS.map((h) => btn(hh(h), `h:${h}`, sub.hour === h && !sub.paused));
  return {
    inline_keyboard: [
      [{ text: "📚 Уровень", callback_data: "noop" }],
      lv.slice(0, 3), lv.slice(3),
      [{ text: "⏰ Время отправки", callback_data: "noop" }],
      hr.slice(0, 3), hr.slice(3),
      [{ text: sub.paused ? "▶️ Возобновить" : "⏸ Пауза", callback_data: "pause" },
        { text: "✖️ Закрыть", callback_data: "close" }],
    ],
  };
}

async function sendSettings(env, cid, sub) {
  if (sub.smid) await quiet(api(env, "deleteMessage", { chat_id: cid, message_id: sub.smid })); // старое меню убираем
  const m = await api(env, "sendMessage", {
    chat_id: cid, text: settingsText(sub), parse_mode: "HTML", reply_markup: settingsKeyboard(sub),
  });
  sub.smid = m.message_id;
  await putSub(env, cid, sub);
}

// ---------- входящие ----------
const lastHint = new Map(); // чтобы не отвечать на каждое лишнее сообщение

async function hint(env, cid, text, isAdmin) {
  const now = Date.now();
  if (now - (lastHint.get(cid) || 0) < 30000) return;
  lastHint.set(cid, now);
  await api(env, "sendMessage", { chat_id: cid, text, reply_markup: replyKeyboard(isAdmin) });
}

async function handleUpdate(env, u) {
  if (u.message) return handleMessage(env, u.message);
  if (u.callback_query) return handleCallback(env, u.callback_query);
  if (u.poll_answer) return handlePollAnswer(env, u.poll_answer);
  if (u.my_chat_member) return handleMemberChange(env, u.my_chat_member);
}

async function handleMessage(env, msg) {
  if (!msg.chat || msg.chat.type !== "private") return;
  const cid = String(msg.chat.id);
  const text = (msg.text || "").trim();
  const cmd = text.startsWith("/") ? text.split(/\s+/)[0].split("@")[0].toLowerCase() : "";
  const admin = await adminId(env);
  const isAdmin = admin === cid;
  const del = () => quiet(api(env, "deleteMessage", { chat_id: cid, message_id: msg.message_id }));
  let sub = await getSub(env, cid);

  if (isAdmin && msg.reply_to_message && !cmd) {
    const target = await env.KV.get("fb:" + msg.reply_to_message.message_id);
    if (target) {
      const ok = await quiet(api(env, "sendMessage", {
        chat_id: target, parse_mode: "HTML", text: "💬 <b>Ответ автора бота:</b>",
      }));
      const copied = ok && await quiet(api(env, "copyMessage", { chat_id: target, from_chat_id: cid, message_id: msg.message_id }));
      await api(env, "sendMessage", {
        chat_id: cid, reply_to_message_id: msg.message_id,
        text: copied ? "✅ Ответ отправлен" : "⚠️ Не удалось отправить — возможно, пользователь заблокировал бота",
      });
      return;
    }
  }

  if (cmd === "/admin" && (!admin || isAdmin)) {
    if (!admin) await env.KV.put("admin", cid);
    await api(env, "sendMessage", {
      chat_id: cid, parse_mode: "HTML", reply_markup: replyKeyboard(true),
      text: "👑 <b>Вы администратор бота</b>\n\nЯ буду писать вам о новых пользователях, паузах и блокировках. " +
        "Список всех пользователей — кнопка «👥 Пользователи».",
    });
    return;
  }

  if (cmd === "/start") {
    if (!sub) {
      sub = newSub(msg.from);
      await putSub(env, cid, sub);
      const first = (msg.from && msg.from.first_name) || "";
      await api(env, "sendMessage", {
        chat_id: cid, parse_mode: "HTML", reply_markup: replyKeyboard(isAdmin),
        text: `🀄 <b>Добро пожаловать${first ? ", " + esc(first) : ""}!</b>\n\n` +
          `Каждый день я буду присылать <b>${QUESTIONS_PER_DAY} вопросов</b> по словам HSK 3.0.\n\n` +
          "🔁 Слова с ошибками повторю в следующие дни\n" +
          "⚙️ Уровень и время — кнопка «Настройки» внизу\n\n" +
          "А вот первый урок 👇",
      });
      await notifyAdmin(env, cid, "🆕 <b>Новый пользователь</b>", sub, true);
      await sendLesson(env, cid, sub, true);
    } else {
      const wasOff = sub.paused || sub.blocked;
      sub.paused = false;
      sub.blocked = false;
      refreshProfile(sub, msg.from);
      await putSub(env, cid, sub);
      await api(env, "sendMessage", {
        chat_id: cid, parse_mode: "HTML", reply_markup: replyKeyboard(isAdmin),
        text: `✅ <b>Бот включён</b>\nВопросы придут в ${hh(sub.hour)}. Уровень и время — «⚙️ Настройки».`,
      });
      if (wasOff) await notifyAdmin(env, cid, "▶️ <b>Снова включил бота</b>", sub);
    }
    return;
  }
  if (!sub) {
    if (isAdmin) return; // администратору писать можно
    await del();
    await hint(env, cid, "Чтобы начать, нажмите /start", false);
    return;
  }
  if (refreshProfile(sub, msg.from)) await putSub(env, cid, sub);

  const isButton = [BTN_LESSON, BTN_SETTINGS, BTN_FEEDBACK, BTN_USERS].includes(text) || !!cmd;
  if (sub.fb_wait) {
    const waiting = Date.now() - sub.fb_wait < FEEDBACK_WAIT;
    delete sub.fb_wait;
    await putSub(env, cid, sub);
    if (waiting && !isButton) {
      await receiveFeedback(env, cid, sub, msg);
      return;
    }
  }

  if (cmd === "/stop") {
    sub.paused = true;
    await putSub(env, cid, sub);
    await api(env, "sendMessage", {
      chat_id: cid, parse_mode: "HTML", reply_markup: replyKeyboard(isAdmin),
      text: "⏸ <b>Пауза</b>\nВопросы больше не приходят. Включить — /start или «⚙️ Настройки».",
    });
    await notifyAdmin(env, cid, "⏸ <b>Поставил бота на паузу</b>", sub);
  } else if (text === BTN_SETTINGS || cmd === "/settings") {
    await del();
    await sendSettings(env, cid, sub);
  } else if (text === BTN_LESSON || cmd === "/lesson") {
    await del();
    await sendLesson(env, cid, sub, false);
  } else if (text === BTN_FEEDBACK || cmd === "/feedback") {
    await del();
    sub.fb_wait = Date.now();
    await putSub(env, cid, sub);
    await api(env, "sendMessage", {
      chat_id: cid, parse_mode: "HTML",
      text: "💬 <b>Отзыв о боте</b>\n\nЧто понравилось, что неудобно, чего не хватает? " +
        "Напишите одним сообщением — можно текстом, фото или голосовым. Я передам автору бота.",
      reply_markup: { inline_keyboard: [[{ text: "✖️ Отмена", callback_data: "fb_cancel" }]] },
    });
  } else if (isAdmin && (text === BTN_USERS || cmd === "/users")) {
    await del();
    await sendUsers(env, cid);
  } else if (isAdmin) {
    // администратору писать можно — его сообщения не трогаем
  } else { // у остальных текст, файлы, фото, стикеры удаляются
    await del();
    await hint(env, cid, "Я понимаю только кнопки 👇", false);
  }
}

async function receiveFeedback(env, cid, sub, msg) {
  await env.KV.put(`f:${new Date().toISOString()}:${cid}`, JSON.stringify({
    chat: cid, name: sub.name, username: sub.username, text: msg.text || msg.caption || "",
  }), { expirationTtl: 365 * 86400 });
  const admin = await adminId(env);
  let delivered = false;
  if (admin && admin !== cid) {
    const head = await quiet(api(env, "sendMessage", {
      chat_id: admin, parse_mode: "HTML", link_preview_options: { is_disabled: true },
      text: `💬 <b>Новый отзыв</b>\n\n${await userCard(env, cid, sub, null)}\n\n<i>Ответьте на сообщение с отзывом (свайп → Ответить), и я перешлю ответ пользователю.</i>`,
    }));
    const copy = await quiet(api(env, "copyMessage", { chat_id: admin, from_chat_id: cid, message_id: msg.message_id }));
    for (const m of [head, copy]) {
      if (m && m.message_id) await env.KV.put("fb:" + m.message_id, cid, { expirationTtl: 90 * 86400 });
    }
    delivered = !!copy;
  }
  await api(env, "sendMessage", {
    chat_id: cid, parse_mode: "HTML", reply_markup: replyKeyboard(admin === cid),
    text: delivered || admin === cid ? "🙏 <b>Спасибо за отзыв!</b>\nЯ передал его автору бота." :
      "🙏 <b>Спасибо за отзыв!</b>\nЯ его сохранил.",
  });
}

async function handleCallback(env, cq) {
  const cid = String(cq.from.id);
  const data = cq.data || "";
  const sub = await getSub(env, cid);
  const mid = cq.message && cq.message.message_id;
  let note = "";
  let changed = false;
  if (!sub) {
    note = "Сначала нажмите /start";
  } else if (/^lv:\d+$/.test(data) && LEVELS.includes(+data.slice(3))) {
    changed = sub.level !== +data.slice(3);
    sub.level = +data.slice(3);
    note = `📚 Уровень: HSK ${sub.level}`;
  } else if (/^h:\d+$/.test(data) && SEND_HOURS.includes(+data.slice(2))) {
    changed = sub.hour !== +data.slice(2) || sub.paused;
    sub.hour = +data.slice(2);
    sub.paused = false;
    note = `⏰ Вопросы в ${hh(sub.hour)}`;
  } else if (data === "pause") {
    sub.paused = !sub.paused;
    changed = true;
    note = sub.paused ? "⏸ Пауза" : "▶️ Вопросы включены";
  } else if (data === "fb_cancel") {
    if (sub && sub.fb_wait) {
      delete sub.fb_wait;
      await putSub(env, cid, sub);
    }
    await quiet(api(env, "answerCallbackQuery", { callback_query_id: cq.id, text: "Отменено" }));
    if (mid) await quiet(api(env, "deleteMessage", { chat_id: cid, message_id: mid }));
    return;
  } else if (data === "close") {
    await quiet(api(env, "answerCallbackQuery", { callback_query_id: cq.id }));
    if (mid) await quiet(api(env, "deleteMessage", { chat_id: cid, message_id: mid }));
    return;
  } else if (data === "now") { // кнопка из прошлых версий меню
    note = "Отправляю урок";
  }
  if (changed) {
    try {
      await putSub(env, cid, sub);
    } catch (e) {
      note = "Слишком быстро, нажмите ещё раз";
      changed = false;
    }
  }
  await quiet(api(env, "answerCallbackQuery", { callback_query_id: cq.id, text: note }));
  if (sub && mid && changed) {
    await quiet(api(env, "editMessageText", {
      chat_id: cid, message_id: mid, text: settingsText(sub), parse_mode: "HTML", reply_markup: settingsKeyboard(sub),
    }));
  }
  if (sub && changed && data === "pause") {
    await notifyAdmin(env, cid, sub.paused ? "⏸ <b>Поставил бота на паузу</b>" : "▶️ <b>Снял бота с паузы</b>", sub);
  }
  if (sub && data === "now") await sendLesson(env, cid, sub, false);
}

async function handleMemberChange(env, m) {
  if (!m.chat || m.chat.type !== "private") return;
  const cid = String(m.chat.id);
  const sub = await getSub(env, cid);
  if (!sub) return;
  const status = m.new_chat_member && m.new_chat_member.status;
  if (status === "kicked" && !sub.blocked) {
    sub.blocked = true;
    await putSub(env, cid, sub);
    await notifyAdmin(env, cid, "🚫 <b>Заблокировал бота</b>", sub);
  } else if (status === "member" && sub.blocked) {
    sub.blocked = false;
    await putSub(env, cid, sub);
    await notifyAdmin(env, cid, "✅ <b>Разблокировал бота</b>", sub);
  }
}

async function handlePollAnswer(env, pa) {
  const p = await getJSON(env, "p:" + pa.poll_id);
  if (!p) return;
  const ok = (pa.option_ids || []).length === 1 && pa.option_ids[0] === p.correct;
  // отдельный ключ на каждый ответ — никаких гонок при быстрых ответах подряд
  await env.KV.put(`a:${p.chat}:${pa.poll_id}`, "", {
    expirationTtl: 30 * 86400, metadata: { w: p.word, ok, d: p.date },
  });
}

// ---------- прогресс ----------
async function foldAnswers(env, cid, us, readOnly = false) {
  const keys = [];
  let cursor;
  do {
    const r = await env.KV.list({ prefix: `a:${cid}:`, cursor });
    keys.push(...r.keys);
    cursor = r.list_complete ? null : r.cursor;
  } while (cursor);
  for (const k of keys) {
    const m = k.metadata;
    if (!m) continue;
    const day = us.days[m.d] || (us.days[m.d] = [0, 0]);
    day[1] += 1;
    if (m.ok) {
      day[0] += 1;
      us.right += 1;
      us.review = us.review.filter((w) => w !== m.w);
    } else {
      us.wrong += 1;
      if (!us.review.includes(m.w)) us.review.push(m.w);
    }
  }
  return readOnly ? [] : keys.map((k) => k.name);
}

function prune(us) {
  const d = today();
  for (const [k, v] of Object.entries(us.seen)) if (daysBetween(v, d) >= 90) delete us.seen[k];
  for (const k of Object.keys(us.days)) if (daysBetween(k, d) > 30) delete us.days[k];
}

// ---------- выбор слов и вопросов ----------
function pickWords(us, n, level) {
  const d = today();
  const chosen = [];
  for (const wid of us.review) {
    const w = BY_ID.get(wid);
    if (chosen.length < Math.min(REVIEW_PER_DAY, n) && w && w[4] <= level && us.seen[wid] !== d) chosen.push(wid);
  }
  const lower = LEVELS.filter((lv) => lv < level);
  const left = n - chosen.length;
  const mainN = lower.length ? Math.max(1, Math.round(left * MAIN_LEVEL_SHARE)) : left;
  const plan = [];
  for (let i = 0; i < left; i++) plan.push(i < mainN ? level : lower[(i - mainN) % lower.length]);
  for (const lv of plan) {
    const all = BY_LEVEL.get(lv);
    let pool = all.filter((w) => !(w[0] in us.seen) && !chosen.includes(w[0]));
    if (!pool.length) pool = all.filter((w) => !chosen.includes(w[0]));
    chosen.push(choice(pool)[0]);
  }
  return shuffle(chosen);
}

function distractors(word, kind) {
  const [wid, han, py, ru, lv] = word;
  const ok = (o) => {
    if (o[0] === wid || o[1] === han) return false;
    if (kind === "han2ru") return shortRu(o[3]) !== shortRu(ru);
    return o[2].toLowerCase() !== py.toLowerCase() && shortRu(o[3]) !== shortRu(ru);
  };
  const near = LEVELS.filter((x) => Math.abs(x - lv) <= 1).flatMap((x) => BY_LEVEL.get(x));
  const sameLen = near.filter((o) => o[1].length === han.length && ok(o));
  const pool = sameLen.length >= 3 ? sameLen : near.filter(ok);
  const key = kind === "han2ru" ? (o) => shortRu(o[3]) : (o) => o[1];
  const right = kind === "han2ru" ? shortRu(ru) : han;
  const out = [];
  const texts = new Set();
  while (out.length < 3) {
    const o = choice(pool);
    if (!texts.has(key(o)) && key(o) !== right) {
      texts.add(key(o));
      out.push(o);
    }
  }
  return out;
}

function makeQuestion(word, kind) {
  const [, han, py, ru, lv, emo] = word;
  const others = distractors(word, kind);
  let q, right, opts;
  if (kind === "py2han") {
    [q, right, opts] = [`HSK ${lv} · Как пишется «${py}»?`, han, others.map((o) => o[1])];
  } else if (kind === "han2ru") {
    [q, right, opts] = [`HSK ${lv} · Что значит ${han}?`, shortRu(ru), others.map((o) => shortRu(o[3]))];
  } else {
    [q, right, opts] = [`HSK ${lv} · Как по-китайски «${shortRu(ru, 120)}»?`, han, others.map((o) => o[1])];
  }
  opts.push(right);
  shuffle(opts);
  let expl = `${emo ? emo + " " : ""}${han} · ${py} — ${ru}`;
  if (expl.length > 200) expl = expl.slice(0, 199) + "…";
  return [q.slice(0, 300), opts, opts.indexOf(right), expl];
}

// ---------- урок ----------
async function sendLesson(env, cid, sub, daily) {
  const us = await getProgress(env, cid);
  const answered = await foldAnswers(env, cid, us);
  prune(us);
  const now = mskNow();
  const d = isoDay(now);
  const y = us.days[isoDay(new Date(now.getTime() - DAY))];
  let head = `🀄 <b>Урок на ${now.getUTCDate()} ${MONTHS[now.getUTCMonth()]}</b>\n` +
    `📚 HSK ${sub.level} · ${QUESTIONS_PER_DAY} вопросов`;
  const stats = [];
  if (y && y[1]) stats.push(`📊 Вчера: <b>${y[0]} из ${y[1]}</b> верно` + (y[0] === y[1] ? " 🎉" : ""));
  if (us.review.length) stats.push(`🔁 На повторении: ${us.review.length} сл.`);
  if (stats.length) head += "\n\n" + stats.join("\n");
  await api(env, "sendMessage", {
    chat_id: cid, text: head, parse_mode: "HTML",
    reply_markup: { inline_keyboard: [[{ text: "📖 Открыть карточки", web_app: { url: CARDS_URL } }]] },
  });
  const dayNo = Math.floor(Date.parse(d) / DAY);
  const words = pickWords(us, QUESTIONS_PER_DAY, sub.level);
  for (let i = 0; i < words.length; i++) {
    const wid = words[i];
    const kind = QUESTION_TYPES[(i + dayNo) % QUESTION_TYPES.length];
    const [q, opts, correct, expl] = makeQuestion(BY_ID.get(wid), kind);
    const res = await api(env, "sendPoll", {
      chat_id: cid, question: q, options: opts.map((o) => ({ text: o })),
      type: "quiz", correct_option_id: correct, is_anonymous: false, explanation: expl,
    });
    await env.KV.put("p:" + res.poll.id, JSON.stringify({ chat: cid, word: wid, correct, date: d }),
      { expirationTtl: 3 * 86400 });
    us.seen[wid] = d;
  }
  if (daily) us.last_sent = d;
  await env.KV.put("u:" + cid, JSON.stringify(us));
  for (const k of answered) await quiet(env.KV.delete(k));
}

// ---------- рассылка по расписанию ----------
async function sendDue(env) {
  const now = mskNow();
  const d = isoDay(now);
  const hour = now.getUTCHours();
  let sent = 0;
  let cursor;
  do {
    const r = await env.KV.list({ prefix: "s:", cursor });
    for (const k of r.keys) {
      if (sent >= MAX_LESSONS_PER_RUN) return; // остальные — в следующий запуск через 10 минут
      const cid = k.name.slice(2);
      const sub = await getSub(env, cid);
      if (!sub || sub.paused || sub.blocked || hour < sub.hour) continue;
      const us = await getJSON(env, "u:" + cid);
      if (us && us.last_sent === d) continue;
      try {
        await sendLesson(env, cid, sub, true);
      } catch (e) {
        console.log("Не удалось отправить", cid, String(e));
        if (/blocked|chat not found|deactivated/.test(String(e))) {
          sub.blocked = true;
          await putSub(env, cid, sub);
          await notifyAdmin(env, cid, "🚫 <b>Заблокировал бота</b>", sub);
        }
      }
      sent += 1;
    }
    cursor = r.list_complete ? null : r.cursor;
  } while (cursor);
}
