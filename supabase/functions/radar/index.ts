// Китай-радар: серверная функция в Supabase.
//
//   POST {action:"refresh"}  — найти свежие цены прямо сейчас (сайт, кнопка в Telegram, расписание)
//   POST ?tg=1               — вебхук Telegram: бот отвечает на команды мгновенно
//   POST {action:"sync"}     — GitHub передаёт токены из своих секретов (проверяется подпись GitHub OIDC)
//
// Готовые данные лежат в таблице radar_blob (data, prices, history): сайт читает их напрямую.
// Токены, подписчики и служебные отметки лежат в radar_kv и radar_chat, снаружи они недоступны.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { createRemoteJWKSet, jwtVerify } from "npm:jose@5";
import { CONFIG } from "./config.ts";
import { PHRASES } from "./phrases.ts";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const db = createClient(SB_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const FN_URL = SB_URL + "/functions/v1/radar";
const PAGE = "https://111l9lpa.github.io/Haiku-/trip/";
const PHOTO_URL = PAGE + "china.jpg";
const REPO = "111l9lpa/haiku-";
const BOT_ID = 7266618332;
const MAX_CHATS = 10;
const FRESH_MS = 60_000;       // чаще раза в минуту заново не ищем
const LOCK_MS = 120_000;       // один поиск за раз
const HISTORY_LIMIT = 400;
const PW = CONFIG.plan_window;

type Item = { o: string; x: string; d: string; r: string; p: number; a?: string; t?: number; rt?: number; l?: string; pp?: number };
type Point = { t: string; min: number; plan: number | null; c: Record<string, number> };
type Data = Record<string, any>;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- хранилище ----------
async function kv<T>(key: string): Promise<T | null> {
  const { data } = await db.from("radar_kv").select("value").eq("key", key).maybeSingle();
  return (data?.value ?? null) as T | null;
}
async function setKv(key: string, value: unknown) {
  await db.from("radar_kv").upsert({ key, value, updated_at: new Date().toISOString() });
}
async function blob<T>(name: string): Promise<T | null> {
  const { data } = await db.from("radar_blob").select("body").eq("name", name).maybeSingle();
  return (data?.body ?? null) as T | null;
}
async function setBlob(name: string, body: unknown) {
  const { error } = await db.from("radar_blob").upsert({ name, body, updated_at: new Date().toISOString() });
  if (error) throw new Error("radar_blob: " + error.message);
}

// ---------- даты ----------
const dayNum = (iso: string) => Date.parse(iso + "T00:00:00Z") / 864e5;
const nights = (i: { d: string; r: string }) => Math.round(dayNum(i.r) - dayNum(i.d));
const inPlan = (i: { d: string; r: string }) =>
  PW.depart_from <= i.d && i.d <= PW.depart_to && PW.return_from <= i.r && i.r <= PW.return_to;

// ---------- Travelpayouts ----------
async function fetchRoute(token: string, o: string, x: string, dm: string, rm: string): Promise<any[] | null> {
  const u = new URL("https://api.travelpayouts.com/aviasales/v3/prices_for_dates");
  const params: Record<string, string> = {
    origin: o, destination: x, departure_at: dm, return_at: rm, currency: "rub", sorting: "price",
    direct: "false", one_way: "false", unique: "false", limit: "1000", token,
  };
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(25_000) });
      if (r.ok) return (await r.json()).data ?? [];
      await r.body?.cancel();
      if (r.status === 401 || r.status === 403) return null;
    } catch (_) { /* сеть: пробуем ещё раз */ }
    await sleep(1200 * (attempt + 1));
  }
  return null;
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

function shortLink(link?: string): string | undefined {
  if (!link) return undefined;
  const u = new URL(link, "https://www.aviasales.ru");
  const t = u.searchParams.get("t");
  return u.pathname + (t ? "?t=" + t : "");
}

async function collect(token: string) {
  const jobs: [string, string, string, string][] = [];
  for (const o of CONFIG.origins) for (const c of CONFIG.cities) for (const [dm, rm] of CONFIG.calendar_months) jobs.push([o.code, c.code, dm, rm]);
  const best = new Map<string, Item & { link?: string }>();
  let ok = 0;
  await pool(jobs, 10, async ([o, x, dm, rm]) => {
    const items = await fetchRoute(token, o, x, dm, rm);
    if (!items) return;
    ok++;
    for (const it of items) {
      const d = String(it.departure_at ?? "").slice(0, 10), r = String(it.return_at ?? "").slice(0, 10);
      if (!d || !r || r <= d || !it.price) continue;
      if (nights({ d, r }) < CONFIG.min_nights) continue;
      const key = `${o}|${x}|${d}|${r}`;
      const cur = best.get(key);
      if (!cur || it.price < cur.p) {
        best.set(key, { o, x, d, r, p: Math.round(it.price), a: it.airline ?? undefined, t: it.transfers ?? undefined, rt: it.return_transfers ?? undefined, link: it.link });
      }
    }
  });
  return { best, ok, total: jobs.length };
}

function trim(best: Map<string, Item & { link?: string }>): Item[] {
  const routes = new Map<string, (Item & { link?: string })[]>();
  for (const i of best.values()) {
    const k = i.o + i.x;
    if (!routes.has(k)) routes.set(k, []);
    routes.get(k)!.push(i);
  }
  const out: Item[] = [];
  for (const list of routes.values()) {
    list.sort((a, b) => a.p - b.p);
    list.forEach((i, n) => {
      if (n >= CONFIG.per_route_limit && !inPlan(i)) return;
      const { link, ...rest } = i;
      const item: Item = { ...rest };
      if (n < CONFIG.links_per_route || inPlan(i)) item.l = shortLink(link);
      for (const k of Object.keys(item) as (keyof Item)[]) if (item[k] === undefined) delete item[k];
      out.push(item);
    });
  }
  return out.sort((a, b) => a.p - b.p || a.d.localeCompare(b.d) || a.r.localeCompare(b.r));
}

async function cnyRate(old: number | null) {
  try {
    const j = await (await fetch("https://www.cbr-xml-daily.ru/daily_json.js", { signal: AbortSignal.timeout(10_000) })).json();
    const v = j.Valute.CNY;
    return Math.round((v.Value / v.Nominal) * 10000) / 10000;
  } catch (_) {
    return old;
  }
}

const threshold = (p: number) => Math.max(1000, p * 0.02);

async function buildData(token: string) {
  const now = new Date();
  const nowIso = now.toISOString().slice(0, 16) + "+00:00";
  const { best, ok, total } = await collect(token);
  if (!ok || !best.size) throw new Error(`Travelpayouts не вернул цен (ответило ${ok} из ${total})`);

  const items = trim(best);
  const oldPrices = await blob<{ items: Item[] }>("prices");
  const old = new Map((oldPrices?.items ?? []).map((i) => [`${i.o}|${i.x}|${i.d}|${i.r}`, i]));
  for (const i of items) {
    const prev = old.get(`${i.o}|${i.x}|${i.d}|${i.r}`);
    if (prev && prev.p !== i.p) i.pp = prev.p;
    else if (prev?.pp && prev.pp !== i.p) i.pp = prev.pp;
  }

  const plan = items.filter(inPlan);
  const cheapest = items[0];
  const board = new Map<string, Item>();
  for (const i of items) if (!board.has(i.x + i.o)) board.set(i.x + i.o, i);
  const cityMin: Record<string, number> = {};
  for (const i of board.values()) cityMin[i.x] = Math.min(cityMin[i.x] ?? i.p, i.p);

  const hist = await blob<{ points: Point[] }>("history");
  let points = (hist?.points ?? []).filter((p) => p.c);
  const prev = points.at(-1);
  const point: Point = { t: nowIso, min: cheapest.p, plan: plan[0]?.p ?? null, c: cityMin };
  points = [...points, point].slice(-HISTORY_LIMIT);

  const dayAgo = now.getTime() - 24 * 3600e3;
  let base = [...points.slice(0, -1)].reverse().find((p) => Date.parse(p.t) <= dayAgo) ?? null;
  if (!base && points.length > 1 && Date.parse(points[0].t) <= now.getTime() - 3 * 3600e3) base = points[0];
  const diff = (k: "min" | "plan") => (base && base[k] && point[k] ? (point[k] as number) - (base[k] as number) : null);

  const alerts: { kind: string; old: number; new: number; item: Item }[] = [];
  if (prev?.plan && point.plan && prev.plan - point.plan >= threshold(prev.plan)) alerts.push({ kind: "plan", old: prev.plan, new: point.plan, item: plan[0] });
  if (prev?.min && prev.min - point.min >= threshold(prev.min)) alerts.push({ kind: "min", old: prev.min, new: point.min, item: cheapest });

  const oldData = await blob<Data>("data");
  const data: Data = {
    updated_at: nowIso,
    trip_start: CONFIG.trip_start,
    plan_window: PW,
    min_nights: CONFIG.min_nights,
    origins: CONFIG.origins,
    cities: CONFIG.cities,
    plan: plan.slice(0, 40),
    best: cheapest,
    board: [...board.values()].sort((a, b) => a.p - b.p),
    trend: { plan_24h: diff("plan"), min_24h: diff("min") },
    spark: points.slice(-60).map((p) => ({ t: p.t, min: p.min, plan: p.plan })),
    cny: await cnyRate(oldData?.cny ?? null),
    count: items.length,
    routes_ok: ok,
    routes_total: total,
  };
  await setBlob("prices", { generated: nowIso, items });
  await setBlob("history", { points });
  await setBlob("data", data);
  return { data, alerts };
}

// ---------- обновление целиком ----------
async function refresh(source: string, force = false): Promise<{ status: string; data?: Data; error?: string }> {
  const data = await blob<Data>("data");
  if (!force && data?.updated_at && Date.now() - Date.parse(data.updated_at) < FRESH_MS) return { status: "fresh", data };
  const lock = await kv<number>("lock");
  if (lock && Date.now() - lock < LOCK_MS) {
    // кто-то уже ищет: ждём его результат
    for (let i = 0; i < 45; i++) {
      await sleep(1000);
      const d = await blob<Data>("data");
      if (d?.updated_at !== data?.updated_at) return { status: "ok", data: d! };
    }
    return { status: "busy", data: data ?? undefined };
  }
  await setKv("lock", Date.now());
  try {
    const token = await kv<string>("tp");
    if (!token) throw new Error("Нет токена Travelpayouts: запустите в GitHub workflow «Sync radar»");
    const t0 = Date.now();
    const { data: fresh, alerts } = await buildData(token);
    console.log(`refresh (${source}): ${fresh.count} вариантов за ${Date.now() - t0} мс`);
    await updateTelegram(fresh, alerts);
    return { status: "ok", data: fresh };
  } catch (e) {
    console.error("refresh error", e);
    return { status: "error", error: String((e as Error).message ?? e), data: data ?? undefined };
  } finally {
    await setKv("lock", null);
  }
}

// ---------- Telegram: форматирование ----------
const MONTHS = ["", "янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
const money = (n: number) => Math.round(n).toLocaleString("ru-RU").replace(/[\u00a0\u202f]/g, " ") + " ₽";
const kRub = (n: number) => Math.round(n / 1000) + "к";
const sd = (iso: string) => `${+iso.slice(8, 10)} ${MONTHS[+iso.slice(5, 7)]}`;
const plural = (n: number, a: string, b: string, c: string) => {
  const m = Math.abs(n) % 100, k = m % 10;
  return m > 10 && m < 20 ? c : k === 1 ? a : k > 1 && k < 5 ? b : c;
};
const cityName = (x: string) => CONFIG.cities.find((c) => c.code === x)?.name ?? x;
const originName = (o: string) => CONFIG.origins.find((c) => c.code === o)?.name ?? o;
const route = (i: Item) => `${originName(i.o)} → ${cityName(i.x)}`;
const ticketUrl = (i: Item) => {
  if (i.l) return "https://www.aviasales.ru" + i.l;
  const dd = (iso: string) => iso.slice(8, 10) + iso.slice(5, 7);
  return `https://www.aviasales.ru/search/${i.o}${dd(i.d)}${i.x}${dd(i.r)}1`;
};
const todayIdx = () => Math.floor(Date.now() / 864e5) + 719163; // тот же номер дня, что на сайте
const phrase = (random = false) => {
  const p = PHRASES[random ? Math.floor(Math.random() * PHRASES.length) : todayIdx() % PHRASES.length];
  return `🀄 ${p.h} <i>(${p.p})</i> — ${p.ru}`;
};
const KEYBOARD = {
  inline_keyboard: [
    [{ text: "🔄 Обновить цены", callback_data: "refresh" }],
    [{ text: "🗺 Все города", url: PAGE + "#cities" }, { text: "📅 Календарь", url: PAGE + "search.html" }],
  ],
};
const HELP = "Я <b>Китай-радар</b> 🇨🇳 Слежу за ценами на билеты туда-обратно из Москвы и Краснодара во все крупные города Китая (поездки от 12 дней).\n\n" +
  "/top — 10 самых дешёвых вариантов\n/update — найти свежие цены прямо сейчас\n/bought — отметить, что билет куплен\n" +
  "/phrase — случайная фраза по-китайски\n/stop — не присылать обновления\n\nИли жмите «🔄 Обновить цены» под закреплённым сообщением.";

function caption(d: Data, bought: boolean): string {
  const left = Math.max(Math.ceil(dayNum(d.trip_start) - Date.now() / 864e5), 0);
  const head = [`🇨🇳 <b>Китай-радар</b> · до вылета <b>${left}</b> ${plural(left, "день", "дня", "дней")}`, ""];
  const plan: Item[] = d.plan ?? [];
  const blockPlan = [`🎯 <b>Наши даты</b> · ${+PW.depart_from.slice(8)}–${sd(PW.depart_to)} → ${+PW.return_from.slice(8)}–${sd(PW.return_to)}`];
  if (plan.length) ["🥇", "🥈", "🥉"].forEach((m, n) => {
    const i = plan[n];
    if (i) blockPlan.push(`${m} <b>${money(i.p)}</b> ${route(i)} · ${sd(i.d)}→${sd(i.r)}`);
  });
  else blockPlan.push("пока ничего не нашлось на эти даты");
  const best: Item | undefined = d.best;
  const blockBest = best && (!plan.length || best.p < plan[0].p)
    ? ["", "🔥 <b>Дешевле всего в ноябре–декабре</b> (от 12 дней)", `<b>${money(best.p)}</b> ${route(best)} · ${sd(best.d)}→${sd(best.r)} (${nights(best)} дн.)`]
    : [];
  const seen = new Set<string>(), top: string[] = [];
  for (const i of (d.board ?? []) as Item[]) {
    if (seen.has(i.x)) continue;
    seen.add(i.x);
    top.push(`${cityName(i.x)} ${kRub(i.p)}`);
    if (top.length === 4) break;
  }
  const blockTop = top.length ? ["", "🗺 " + top.join(" · ")] : [];
  const extra = [""];
  const tr = d.trend?.plan_24h ?? d.trend?.min_24h;
  if (tr) extra.push((tr < 0 ? "📉 за сутки −" : "📈 за сутки +") + money(Math.abs(tr)));
  else if (tr === 0) extra.push("➖ за сутки без изменений");
  if (d.cny) extra.push(`💴 1 ¥ = ${d.cny.toFixed(2).replace(".", ",")} ₽`);
  extra.push(phrase());
  const upd = new Date(Date.parse(d.updated_at) + 3 * 3600e3);
  const fresh = `🕒 обновлено ${upd.getUTCDate()} ${MONTHS[upd.getUTCMonth() + 1]}, ${String(upd.getUTCHours()).padStart(2, "0")}:${String(upd.getUTCMinutes()).padStart(2, "0")} МСК`;
  const tail = ["", bought ? "✅ билет куплен!" : "⏳ билет ещё не куплен", fresh];
  for (const blocks of [[blockBest, blockTop, extra], [blockBest, blockTop], [blockBest], []]) {
    const text = [...head, ...blockPlan, ...blocks.flat(), ...tail].join("\n");
    if (text.length <= 1024) return text;
  }
  return [...head, ...blockPlan, ...tail].join("\n").slice(0, 1020);
}

function topText(d: Data | null): string {
  if (!d) return "Цен пока нет. Напишите /update, и я поищу.";
  const seen = new Set<string>(), rows: Item[] = [];
  for (const i of [...(d.plan ?? []).slice(0, 5), ...(d.board ?? [])].sort((a: Item, b: Item) => a.p - b.p)) {
    const k = `${i.o}${i.x}${i.d}${i.r}`;
    if (!seen.has(k)) { seen.add(k); rows.push(i); }
  }
  return ["🏆 <b>10 самых дешёвых вариантов</b>", "",
    ...rows.slice(0, 10).map((i, n) => `${n + 1}. <a href="${ticketUrl(i)}">${money(i.p)}</a> ${route(i)} · ${sd(i.d)}→${sd(i.r)}`),
    "", `Все даты и города: ${PAGE}search.html`].join("\n");
}

// ---------- Telegram: отправка ----------
let tgToken: string | null = null;
async function tg(method: string, body: Record<string, unknown>): Promise<any> {
  tgToken ??= await kv<string>("tg");
  if (!tgToken) return { ok: false, description: "no token" };
  try {
    const r = await fetch(`https://api.telegram.org/bot${tgToken}/${method}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    return await r.json();
  } catch (e) {
    return { ok: false, description: String(e) };
  }
}
const say = (chat: string | number, text: string, markup?: unknown) =>
  tg("sendMessage", { chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true, ...(markup ? { reply_markup: markup } : {}) });

async function isBought() {
  const { data } = await db.from("trip_state").select("ticket_bought").eq("id", 1).maybeSingle();
  return !!data?.ticket_bought;
}

async function sendLive(chat: string, text: string): Promise<{ mid?: number; desc?: string }> {
  const photo = (await kv<string>("photo")) ?? PHOTO_URL;
  let res = await tg("sendPhoto", { chat_id: chat, photo, caption: text, parse_mode: "HTML", reply_markup: KEYBOARD });
  if (!res.ok && photo !== PHOTO_URL) res = await tg("sendPhoto", { chat_id: chat, photo: PHOTO_URL, caption: text, parse_mode: "HTML", reply_markup: KEYBOARD });
  if (!res.ok) return { desc: res.description ?? "" };
  const msg = res.result;
  await setKv("photo", msg.photo.at(-1).file_id);
  await tg("pinChatMessage", { chat_id: chat, message_id: msg.message_id, disable_notification: true });
  await db.from("radar_chat").update({ mid: msg.message_id }).eq("id", chat);
  return { mid: msg.message_id };
}

async function updateLive(d: Data, onlyChat?: string) {
  const text = caption(d, await isBought());
  const owner = await kv<string>("owner");
  let q = db.from("radar_chat").select("id, mid");
  if (onlyChat) q = q.eq("id", onlyChat);
  const { data: chats } = await q;
  await Promise.all((chats ?? []).map(async (c: { id: string; mid: number | null }) => {
    if (c.mid) {
      const res = await tg("editMessageCaption", { chat_id: c.id, message_id: c.mid, caption: text, parse_mode: "HTML", reply_markup: KEYBOARD });
      if (res.ok || String(res.description).includes("not modified")) return;
    }
    const { mid, desc = "" } = await sendLive(c.id, text);
    if (!mid && c.id !== owner && /blocked|chat not found|kicked|deactivated/.test(desc)) {
      await db.from("radar_chat").delete().eq("id", c.id);
    }
  }));
}

async function updateTelegram(d: Data, alerts: { kind: string; old: number; new: number; item: Item }[]) {
  if (!(await kv<string>("tg"))) return;
  await updateLive(d);
  if (!alerts.length) return;
  const { data: chats } = await db.from("radar_chat").select("id");
  for (const a of alerts) {
    const i = a.item;
    const text = `📉 <b>Цена ${a.kind === "plan" ? "на наши даты" : "в Китай"} упала!</b>\n\n<b>${money(a.new)}</b> вместо ${money(a.old)}\n✈️ ${route(i)} · ${sd(i.d)} → ${sd(i.r)}`;
    const markup = { inline_keyboard: [[{ text: "🎫 Открыть билет", url: ticketUrl(i) }], [{ text: "📅 Все варианты", url: PAGE + "search.html" }]] };
    await Promise.all((chats ?? []).map((c: { id: string }) => say(c.id, text, markup)));
  }
}

// ---------- Telegram: команды ----------
async function onUpdate(u: any) {
  if (u.callback_query) {
    const cq = u.callback_query;
    if (cq.data === "refresh") {
      const data = await blob<Data>("data");
      const fresh = data?.updated_at && Date.now() - Date.parse(data.updated_at) < FRESH_MS;
      await tg("answerCallbackQuery", { callback_query_id: cq.id, text: fresh ? "Цены только что обновлены ✨" : "Ищу свежие цены по всему Китаю… ~20 секунд" });
      if (!fresh) await refresh("telegram-button");
    } else {
      await tg("answerCallbackQuery", { callback_query_id: cq.id });
    }
    return;
  }
  const msg = u.message;
  if (!msg?.chat?.id || !msg.text) return;
  const chat = String(msg.chat.id);
  const text = String(msg.text).trim();
  const low = text.toLowerCase();
  const cmd = low.split(/\s+/)[0].split("@")[0];
  const { data: row } = await db.from("radar_chat").select("id").eq("id", chat).maybeSingle();

  if (cmd === "/start") {
    if (!row) {
      const { count } = await db.from("radar_chat").select("id", { count: "exact", head: true });
      if ((count ?? 0) >= MAX_CHATS) return void (await say(chat, "Извините, у радара уже максимум подписчиков."));
      await db.from("radar_chat").insert({ id: chat });
    }
    await say(chat, "Ни хао! 👋\n\n" + HELP + "\n\nВот живое сообщение с ценами, я его закреплю. Оно обновляется само 👇");
    const d = await blob<Data>("data");
    if (d) {
      await db.from("radar_chat").update({ mid: null }).eq("id", chat);
      await updateLive(d, chat);
    }
    return;
  }
  if (!row) return void (await say(chat, "Напишите /start, чтобы подключиться к Китай-радару 🇨🇳"));

  if (cmd === "/stop") {
    await db.from("radar_chat").delete().eq("id", chat);
    await say(chat, "Окей, больше не присылаю обновления. Вернуться: /start");
  } else if (cmd === "/update" || cmd === "/refresh" || low.startsWith("обнови")) {
    await say(chat, "Ищу свежие цены по всему Китаю 🔎 Секунд 20…");
    const res = await refresh("telegram-command");
    const d = res.data;
    if (res.status === "error") await say(chat, "Не получилось обновить: " + res.error);
    else if (d?.plan?.[0]) await say(chat, `Готово ✨ Закреплённое сообщение обновлено.\nЛучшее на наши даты: <b>${money(d.plan[0].p)}</b> ${route(d.plan[0])}`);
    else await say(chat, "Готово ✨ Закреплённое сообщение обновлено.");
  } else if (cmd === "/bought" || cmd === "/kupil" || low.includes("купил")) {
    const next = !(await isBought());
    await db.from("trip_state").update({ ticket_bought: next }).eq("id", 1);
    await say(chat, next ? "🎉 Отметил: билет куплен! Китай, жди." : "Снял отметку: билет пока не куплен.");
    const d = await blob<Data>("data");
    if (d) await updateLive(d);
  } else if (cmd === "/top") {
    await say(chat, topText(await blob<Data>("data")));
  } else if (cmd === "/phrase") {
    await say(chat, phrase(true));
  } else {
    await say(chat, HELP);
  }
}

// ---------- синхронизация токенов из GitHub ----------
const GITHUB_JWKS = createRemoteJWKSet(new URL("https://token.actions.githubusercontent.com/.well-known/jwks"));
async function onSync(req: Request, body: any) {
  const jwt = req.headers.get("x-github-oidc") ?? "";
  try {
    const { payload } = await jwtVerify(jwt, GITHUB_JWKS, { issuer: "https://token.actions.githubusercontent.com", audience: "kitai-radar" });
    if (String(payload.repository ?? "").toLowerCase() !== REPO) throw new Error("чужой репозиторий");
  } catch (e) {
    return reply({ ok: false, error: "GitHub OIDC: " + String((e as Error).message ?? e) }, 401);
  }
  const report: Record<string, unknown> = {};
  if (body.tp) { await setKv("tp", String(body.tp).trim()); report.tp = "сохранён"; }
  if (body.owner) {
    await setKv("owner", String(body.owner).trim());
    await db.from("radar_chat").upsert({ id: String(body.owner).trim() }, { onConflict: "id", ignoreDuplicates: true });
    report.owner = "сохранён";
  }
  if (body.tg) {
    const token = String(body.tg).trim();
    const me = await (await fetch(`https://api.telegram.org/bot${token}/getMe`)).json().catch(() => ({}));
    if (me?.result?.id !== BOT_ID) {
      report.tg = "токен не от того бота, пропускаю";
    } else {
      await setKv("tg", token);
      tgToken = token;
      let hook = await kv<string>("hook");
      if (!hook) { hook = crypto.randomUUID().replace(/-/g, ""); await setKv("hook", hook); }
      const res = await tg("setWebhook", { url: FN_URL + "?tg=1", secret_token: hook, allowed_updates: ["message", "callback_query"] });
      report.tg = res.ok ? "сохранён, вебхук включён" : "вебхук: " + res.description;
      report.bot = "@" + me.result.username;
    }
  }
  EdgeRuntime.waitUntil(refresh("sync", true));
  return reply({ ok: true, ...report, refresh: "запущен" });
}

// ---------- маршрутизация ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);

  if (url.searchParams.get("tg") === "1") {
    const hook = await kv<string>("hook");
    if (!hook || req.headers.get("x-telegram-bot-api-secret-token") !== hook) return reply({ ok: false }, 401);
    const update = await req.json().catch(() => null);
    if (update) EdgeRuntime.waitUntil(onUpdate(update).catch((e) => console.error("telegram", e)));
    return reply({ ok: true });
  }

  if (req.method === "GET") {
    const d = await blob<Data>("data");
    return reply({ ok: true, updated_at: d?.updated_at ?? null, count: d?.count ?? 0 });
  }

  const body = await req.json().catch(() => ({}));
  if (body.action === "sync") return onSync(req, body);
  if (body.action === "refresh") {
    if (body.source === "cron") {
      EdgeRuntime.waitUntil(refresh("cron"));
      return reply({ ok: true, status: "started" });
    }
    const res = await refresh("site");
    return reply({ ok: res.status !== "error", ...res }, res.status === "error" ? 500 : 200);
  }
  return reply({ ok: false, error: "unknown action" }, 400);
});
