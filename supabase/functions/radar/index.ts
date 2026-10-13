// Китай-радар: серверная функция в Supabase.
//
//   POST {action:"refresh"}  — найти свежие цены прямо сейчас (сайт, кнопки в Telegram, расписание)
//   POST {action:"digest"}   — итоги дня в Telegram (каждый день в 16:00 МСК, pg_cron)
//   POST ?tg=1               — вебхук Telegram: бот отвечает на команды и кнопки мгновенно
//   POST {action:"sync"}     — GitHub передаёт токены из своих секретов (проверяется подпись GitHub OIDC)
//
// Сезон поиска и «наши даты» берутся из таблицы trip_settings (их меняют на сайте).
// Готовые данные лежат в radar_blob (data, prices, history): сайт читает их напрямую.
// Слова, блюда, факты и советы берутся из trip/content.json на сайте: один источник для сайта и бота.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { createRemoteJWKSet, jwtVerify } from "npm:jose@5";

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
const HISTORY_LIMIT = 500;
const PER_ROUTE = 80;
const LINKS_PER_ROUTE = 20;

const ORIGINS = [
  { code: "MOW", name: "Москва", from: "из Москвы" },
  { code: "KRR", name: "Краснодар", from: "из Краснодара" },
];
const CITIES = [
  ["BJS", "Пекин", "北京", "Запретный город и утка по-пекински"], ["SHA", "Шанхай", "上海", "Небоскрёбы Пудуна и набережная Бунд"],
  ["CAN", "Гуанчжоу", "广州", "Димсамы и башня Кантон"], ["SZX", "Шэньчжэнь", "深圳", "Город будущего и рынки электроники"],
  ["HKG", "Гонконг", "香港", "Неон и пик Виктория"], ["CTU", "Чэнду", "成都", "Панды и огненный хого"],
  ["CKG", "Чунцин", "重庆", "Киберпанк-город на холмах"], ["XIY", "Сиань", "西安", "Терракотовая армия"],
  ["HGH", "Ханчжоу", "杭州", "Озеро Сиху и чай Лунцзин"], ["NKG", "Нанкин", "南京", "Старая столица и стены Мин"],
  ["KMG", "Куньмин", "昆明", "Город вечной весны"], ["KWL", "Гуйлинь", "桂林", "Горы с купюры в 20 юаней"],
  ["SYX", "Санья", "三亚", "Пальмы и море Хайнаня"], ["HAK", "Хайкоу", "海口", "Хайнань без толп"],
  ["XMN", "Сямэнь", "厦门", "Остров Гуланъюй и чай"], ["WUH", "Ухань", "武汉", "Горячая лапша и Янцзы"],
  ["CSX", "Чанша", "长沙", "Самая острая кухня Хунани"], ["TAO", "Циндао", "青岛", "Пиво Tsingtao у моря"],
  ["DLC", "Далянь", "大连", "Море, площади и трамваи"], ["TSN", "Тяньцзинь", "天津", "Европейские кварталы рядом с Пекином"],
  ["SHE", "Шэньян", "沈阳", "Мукденский дворец"], ["HRB", "Харбин", "哈尔滨", "Лёд, снег и русская архитектура"],
  ["URC", "Урумчи", "乌鲁木齐", "Шёлковый путь и базары"],
].map(([code, name, hanzi, vibe]) => ({ code, name, hanzi, vibe }));

type Plan = { depart_from: string; depart_to: string; return_from: string; return_to: string };
type Settings = { season_from: string; season_to: string; plan: Plan | null; min_nights: number };
type Item = { o: string; x: string; d: string; r: string; p: number; a?: string; t?: number; rt?: number; l?: string; pp?: number };
type Point = { t: string; k: string; min: number; plan: number | null; cny?: number | null; c: Record<string, number> };
type Data = Record<string, any>;
type Word = { id: number; cat: string; h: string; p: string; ru: string };

const DEFAULTS: Settings = { season_from: "2027-03", season_to: "2027-05", plan: null, min_nights: 12 };
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pick = <T>(list: T[]) => list[Math.floor(Math.random() * list.length)];

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

// ---------- контент сайта (слова, еда, факты, советы) ----------
let contentCache: { at: number; c: any } | null = null;
async function content(): Promise<any> {
  if (contentCache && Date.now() - contentCache.at < 10 * 60e3) return contentCache.c;
  try {
    const c = await (await fetch(PAGE + "content.json?v=" + Date.now(), { signal: AbortSignal.timeout(10_000) })).json();
    contentCache = { at: Date.now(), c };
    return c;
  } catch (_) {
    return contentCache?.c ?? { words: [], phrases: [], foods: [], tips: [], facts: [], spend: [] };
  }
}

// ---------- настройки и даты ----------
const isMonth = (s: unknown) => typeof s === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
const isDate = (s: unknown) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
async function settings(): Promise<Settings> {
  const { data } = await db.from("trip_settings").select("settings").eq("id", 1).maybeSingle();
  const s = { ...DEFAULTS, ...(data?.settings ?? {}) } as Settings;
  if (!isMonth(s.season_from) || !isMonth(s.season_to) || s.season_to < s.season_from) { s.season_from = DEFAULTS.season_from; s.season_to = DEFAULTS.season_to; }
  const p = s.plan;
  if (!p || ![p.depart_from, p.depart_to, p.return_from, p.return_to].every(isDate) || p.depart_to < p.depart_from || p.return_to < p.return_from) s.plan = null;
  s.min_nights = Math.min(Math.max(Number(s.min_nights) || 12, 1), 60);
  return s;
}
const nextMonth = (m: string) => {
  const [y, mo] = m.split("-").map(Number);
  return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`;
};
function seasonMonths(s: Settings) {
  const out: string[] = [];
  for (let m = s.season_from; m <= s.season_to && out.length < 4; m = nextMonth(m)) out.push(m);
  return out;
}
const seasonKey = (s: Settings) => JSON.stringify([s.season_from, s.season_to, s.plan, s.min_nights]);
const MONTH_NAMES = ["", "январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
function seasonLabel(s: Settings) {
  const [y1, m1] = s.season_from.split("-").map(Number), [y2, m2] = s.season_to.split("-").map(Number);
  if (s.season_from === s.season_to) return `${MONTH_NAMES[m1]} ${y1}`;
  return y1 === y2 ? `${MONTH_NAMES[m1]}–${MONTH_NAMES[m2]} ${y2}` : `${MONTH_NAMES[m1]} ${y1} – ${MONTH_NAMES[m2]} ${y2}`;
}
const dayNum = (iso: string) => Date.parse(iso + "T00:00:00Z") / 864e5;
const nights = (i: { d: string; r: string }) => Math.round(dayNum(i.r) - dayNum(i.d));
const inPlan = (p: Plan | null, i: { d: string; r: string }) =>
  !!p && p.depart_from <= i.d && i.d <= p.depart_to && p.return_from <= i.r && i.r <= p.return_to;
const tripStart = (s: Settings) => s.plan?.depart_from ?? s.season_from + "-01";

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

async function collect(token: string, s: Settings) {
  const jobs: [string, string, string, string][] = [];
  for (const m of seasonMonths(s)) for (const rm of [m, nextMonth(m)])
    for (const o of ORIGINS) for (const c of CITIES) jobs.push([o.code, c.code, m, rm]);
  const best = new Map<string, Item & { link?: string }>();
  let ok = 0;
  await pool(jobs, 10, async ([o, x, dm, rm]) => {
    const items = await fetchRoute(token, o, x, dm, rm);
    if (!items) return;
    ok++;
    for (const it of items) {
      const d = String(it.departure_at ?? "").slice(0, 10), r = String(it.return_at ?? "").slice(0, 10);
      if (!d || !r || r <= d || !it.price || d.slice(0, 7) !== dm) continue;
      if (nights({ d, r }) < s.min_nights) continue;
      const key = `${o}|${x}|${d}|${r}`;
      const cur = best.get(key);
      if (!cur || it.price < cur.p) {
        best.set(key, { o, x, d, r, p: Math.round(it.price), a: it.airline ?? undefined, t: it.transfers ?? undefined, rt: it.return_transfers ?? undefined, link: it.link });
      }
    }
  });
  return { best, ok, total: jobs.length };
}

function trim(best: Map<string, Item & { link?: string }>, plan: Plan | null): Item[] {
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
      if (n >= PER_ROUTE && !inPlan(plan, i)) return;
      const { link, ...rest } = i;
      const item: Item = { ...rest };
      if (n < LINKS_PER_ROUTE || inPlan(plan, i)) item.l = shortLink(link);
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

async function buildData(token: string, s: Settings) {
  const now = new Date();
  const nowIso = now.toISOString().slice(0, 16) + "+00:00";
  const key = seasonKey(s);
  const { best, ok, total } = await collect(token, s);
  if (!ok) throw new Error(`Travelpayouts не ответил (0 из ${total})`);

  const items = trim(best, s.plan);
  const oldPrices = await blob<{ k?: string; items: Item[] }>("prices");
  const old = new Map((oldPrices?.k === key ? oldPrices.items : []).map((i) => [`${i.o}|${i.x}|${i.d}|${i.r}`, i]));
  for (const i of items) {
    const prev = old.get(`${i.o}|${i.x}|${i.d}|${i.r}`);
    if (prev && prev.p !== i.p) i.pp = prev.p;
    else if (prev?.pp && prev.pp !== i.p) i.pp = prev.pp;
  }

  const plan = items.filter((i) => inPlan(s.plan, i));
  const cheapest = items[0] ?? null;
  const board = new Map<string, Item>();
  for (const i of items) if (!board.has(i.x + i.o)) board.set(i.x + i.o, i);
  const cityMin: Record<string, number> = {};
  for (const i of board.values()) cityMin[i.x] = Math.min(cityMin[i.x] ?? i.p, i.p);

  const oldData = await blob<Data>("data");
  const cny = await cnyRate(oldData?.cny ?? null);
  const hist = await blob<{ points: Point[] }>("history");
  let points = (hist?.points ?? []).filter((p) => p.k === key);
  const prev = points.at(-1);
  const point: Point = { t: nowIso, k: key, min: cheapest?.p ?? 0, plan: plan[0]?.p ?? null, cny, c: cityMin };
  if (cheapest) points = [...points, point].slice(-HISTORY_LIMIT);

  const dayAgo = now.getTime() - 24 * 3600e3;
  let base = [...points.slice(0, -1)].reverse().find((p) => Date.parse(p.t) <= dayAgo) ?? null;
  if (!base && points.length > 1 && Date.parse(points[0].t) <= now.getTime() - 3 * 3600e3) base = points[0];
  const diff = (k: "min" | "plan") => (base && base[k] && point[k] ? (point[k] as number) - (base[k] as number) : null);

  const alerts: { kind: string; old: number; new: number; item: Item }[] = [];
  if (prev?.plan && point.plan && prev.plan - point.plan >= threshold(prev.plan)) alerts.push({ kind: "plan", old: prev.plan, new: point.plan, item: plan[0] });
  if (cheapest && prev?.min && prev.min - point.min >= threshold(prev.min)) alerts.push({ kind: "min", old: prev.min, new: point.min, item: cheapest });

  const data: Data = {
    updated_at: nowIso,
    season_key: key,
    settings: s,
    season_label: seasonLabel(s),
    season_months: seasonMonths(s),
    trip_start: tripStart(s),
    plan_window: s.plan,
    min_nights: s.min_nights,
    origins: ORIGINS,
    cities: CITIES,
    plan: plan.slice(0, 40),
    best: cheapest,
    board: [...board.values()].sort((a, b) => a.p - b.p),
    trend: { plan_24h: diff("plan"), min_24h: diff("min") },
    spark: points.slice(-60).map((p) => ({ t: p.t, min: p.min, plan: p.plan })),
    cny,
    count: items.length,
    routes_ok: ok,
    routes_total: total,
  };
  await setBlob("prices", { generated: nowIso, k: key, items });
  await setBlob("history", { points });
  await setBlob("data", data);
  return { data, alerts, points };
}

// ---------- обновление целиком ----------
async function refresh(source: string, force = false): Promise<{ status: string; data?: Data; error?: string }> {
  const s = await settings();
  const data = await blob<Data>("data");
  const sameSeason = data?.season_key === seasonKey(s);
  if (!force && sameSeason && data?.updated_at && Date.now() - Date.parse(data.updated_at) < FRESH_MS) return { status: "fresh", data };
  const lock = await kv<number>("lock");
  if (lock && Date.now() - lock < LOCK_MS) {
    for (let i = 0; i < 45; i++) {  // кто-то уже ищет: ждём его результат
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
    const { data: fresh, alerts } = await buildData(token, s);
    console.log(`refresh (${source}): ${fresh.count} вариантов, ${fresh.routes_ok}/${fresh.routes_total} маршрутов, ${Date.now() - t0} мс`);
    await updateTelegram(fresh, alerts);
    return { status: "ok", data: fresh };
  } catch (e) {
    console.error("refresh error", e);
    return { status: "error", error: String((e as Error).message ?? e), data: data ?? undefined };
  } finally {
    await setKv("lock", null);
  }
}

// ---------- форматирование ----------
const MONTHS = ["", "янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
const money = (n: number) => Math.round(n).toLocaleString("ru-RU").replace(/[  ]/g, " ") + " ₽";
const kRub = (n: number) => Math.round(n / 1000) + "к";
const sd = (iso: string) => `${+iso.slice(8, 10)} ${MONTHS[+iso.slice(5, 7)]}`;
const plural = (n: number, a: string, b: string, c: string) => {
  const m = Math.abs(n) % 100, k = m % 10;
  return m > 10 && m < 20 ? c : k === 1 ? a : k > 1 && k < 5 ? b : c;
};
const cityName = (x: string) => CITIES.find((c) => c.code === x)?.name ?? x;
const originName = (o: string) => ORIGINS.find((c) => c.code === o)?.name ?? o;
const route = (i: Item) => `${originName(i.o)} → ${cityName(i.x)}`;
const ticketUrl = (i: Item) => {
  if (i.l) return "https://www.aviasales.ru" + i.l;
  const dd = (iso: string) => iso.slice(8, 10) + iso.slice(5, 7);
  return `https://www.aviasales.ru/search/${i.o}${dd(i.d)}${i.x}${dd(i.r)}1`;
};
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const todayIdx = () => Math.floor(Date.now() / 864e5) + 719163; // тот же номер дня, что на сайте
const daysLeft = (d: Data) => Math.max(Math.ceil(dayNum(d.trip_start) - Date.now() / 864e5), 0);
const span = (from: string, to: string) =>
  from === to ? sd(from) : from.slice(0, 7) === to.slice(0, 7) ? `${+from.slice(8)}–${sd(to)}` : `${sd(from)} – ${sd(to)}`;
const windowText = (p: Plan) => `${span(p.depart_from, p.depart_to)} → ${span(p.return_from, p.return_to)}`;
const mskTime = (iso: string) => {
  const u = new Date(Date.parse(iso) + 3 * 3600e3);
  return `${u.getUTCDate()} ${MONTHS[u.getUTCMonth() + 1]}, ${String(u.getUTCHours()).padStart(2, "0")}:${String(u.getUTCMinutes()).padStart(2, "0")} МСК`;
};
const SPARK = "▁▂▃▄▅▆▇█";
const sparkText = (vals: number[]) => {
  const lo = Math.min(...vals), hi = Math.max(...vals);
  return vals.map((v) => SPARK[hi === lo ? 3 : Math.round(((v - lo) / (hi - lo)) * 7)]).join("");
};
const arrow = (diff: number | null | undefined) => (diff == null ? "" : diff < 0 ? ` ↓${kRub(-diff)}` : diff > 0 ? ` ↑${kRub(diff)}` : " =");

const LIVE_KB = {
  inline_keyboard: [
    [{ text: "🔄 Обновить цены", callback_data: "refresh" }, { text: "💰 Все цены", callback_data: "prices" }],
    [{ text: "🀄 Учить слова", callback_data: "learn" }, { text: "💴 Юани", callback_data: "yuan" }],
    [{ text: "🌐 Открыть сайт", url: PAGE }],
  ],
};
const DIGEST_KB = {
  inline_keyboard: [
    [{ text: "💰 Показать цены", callback_data: "prices" }],
    [{ text: "🀄 Учить слова", callback_data: "learn" }, { text: "💴 Юани", callback_data: "yuan" }],
    [{ text: "🎲 Факт о Китае", callback_data: "fact" }, { text: "🍜 Что поесть", callback_data: "food" }],
  ],
};
const COMMANDS = [
  ["prices", "💰 Актуальные цены по нашему сезону"], ["top", "🏆 10 самых дешёвых вариантов"],
  ["update", "🔄 Найти свежие цены прямо сейчас"], ["learn", "🀄 Учить китайские слова"],
  ["progress", "📊 Мой прогресс в китайском"], ["yuan", "💴 Курс юаня и цены в Китае"],
  ["food", "🍜 Что попробовать в Китае"], ["fact", "🎲 Факт о Китае"], ["tips", "🧳 Шпаргалка путешественника"],
  ["phrase", "🗣 Полезная фраза"], ["season", "📅 Какой сезон ищем"], ["digest", "📊 Итоги дня прямо сейчас"],
  ["bought", "🎉 Отметить, что билет куплен"], ["start", "📌 Прислать живое сообщение"],
  ["help", "❓ Что умеет бот"], ["stop", "🔕 Не присылать обновления"],
].map(([command, description]) => ({ command, description }));
const HELP = "Я <b>Китай-радар</b> 🇨🇳 Ищу самые дешёвые билеты туда-обратно из Москвы и Краснодара во все крупные города Китая, " +
  "каждый день в 16:00 присылаю итоги, а ещё учу китайскому.\n\n" +
  "💰 /prices — актуальные цены по нашему сезону\n🏆 /top — 10 самых дешёвых\n🔄 /update — найти свежие цены сейчас\n" +
  "🀄 /learn — учить слова · 📊 /progress — прогресс\n💴 /yuan — курс и цены в Китае\n🍜 /food · 🎲 /fact · 🧳 /tips · 🗣 /phrase\n" +
  "📊 /digest — итоги дня сейчас · 📅 /season — какой сезон ищем\n🎉 /bought — билет куплен\n🔕 /stop — не присылать обновления";

function caption(d: Data, bought: boolean): string {
  const left = daysLeft(d);
  const head = [`🇨🇳 <b>Китай-радар</b> · до вылета <b>${left}</b> ${plural(left, "день", "дня", "дней")}`,
    `📅 Сезон: ${d.season_label} · от ${d.min_nights} дней`, ""];
  const plan: Item[] = d.plan ?? [];
  const block: string[] = [];
  if (d.plan_window) {
    block.push(`🎯 <b>Наши даты</b> · ${windowText(d.plan_window)}`);
    if (plan.length) ["🥇", "🥈", "🥉"].forEach((m, n) => {
      const i = plan[n];
      if (i) block.push(`${m} <b>${money(i.p)}</b> ${route(i)} · ${sd(i.d)}→${sd(i.r)}`);
    });
    else block.push("на эти даты пока ничего не нашлось");
  }
  const best: Item | null = d.best;
  if (best && (!plan.length || best.p < plan[0].p)) {
    block.push(...(block.length ? [""] : []), "🔥 <b>Дешевле всего за сезон</b>", `<b>${money(best.p)}</b> ${route(best)} · ${sd(best.d)}→${sd(best.r)} (${nights(best)} дн.)`);
  }
  if (!best) block.push("Цен на этот сезон пока нет: продажи ещё не открыты или в кэше мало данных. Проверяю каждые 4 часа.");
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
  const tail = ["", bought ? "✅ билет куплен!" : "⏳ билет ещё не куплен", `🕒 обновлено ${mskTime(d.updated_at)}`];
  for (const blocks of [[blockTop, extra], [blockTop], []]) {
    const text = [...head, ...block, ...blocks.flat(), ...tail].join("\n");
    if (text.length <= 1024) return text;
  }
  return [...head, ...block, ...tail].join("\n").slice(0, 1020);
}

function pricesText(d: Data | null): string {
  if (!d?.best) return `💰 На сезон «${d?.season_label ?? ""}» цен пока нет. Продажи открываются примерно за 6–11 месяцев, а в кэш Aviasales цены попадают, когда их кто-то ищет. Я проверяю каждые 4 часа.`;
  const lines = [`💰 <b>Актуальные цены</b> · ${d.season_label}`, `<i>туда-обратно, от ${d.min_nights} дней · ${mskTime(d.updated_at)}</i>`, ""];
  const row = (i: Item, n: number) => `${n + 1}. <a href="${ticketUrl(i)}">${money(i.p)}</a> ${route(i)} · ${sd(i.d)}→${sd(i.r)} (${nights(i)} дн.)`;
  if (d.plan_window) {
    lines.push(`🎯 <b>Наши даты</b> · ${windowText(d.plan_window)}`);
    const plan: Item[] = d.plan ?? [];
    lines.push(...(plan.length ? plan.slice(0, 6).map(row) : ["пока ничего не нашлось"]), "");
  }
  lines.push("🔥 <b>Дешевле всего за сезон</b>");
  const seen = new Set<string>();
  const list = ((d.board ?? []) as Item[]).filter((i) => !seen.has(i.x) && seen.add(i.x)).slice(0, 8);
  lines.push(...list.map(row), "", `📅 Календарь по дням: ${PAGE}search.html`);
  return lines.join("\n");
}

function topText(d: Data | null): string {
  if (!d?.best) return pricesText(d);
  const seen = new Set<string>(), rows: Item[] = [];
  for (const i of [...(d.plan ?? []).slice(0, 5), ...(d.board ?? [])].sort((a: Item, b: Item) => a.p - b.p)) {
    const k = `${i.o}${i.x}${i.d}${i.r}`;
    if (!seen.has(k)) { seen.add(k); rows.push(i); }
  }
  return [`🏆 <b>10 самых дешёвых вариантов</b> · ${d.season_label}`, "",
    ...rows.slice(0, 10).map((i, n) => `${n + 1}. <a href="${ticketUrl(i)}">${money(i.p)}</a> ${route(i)} · ${sd(i.d)}→${sd(i.r)}`),
    "", `Все даты и города: ${PAGE}search.html`].join("\n");
}

async function digestText(d: Data, points: Point[]): Promise<string> {
  const c = await content();
  const now = Date.now();
  const left = daysLeft(d);
  const today = new Date(now + 3 * 3600e3);
  const lines = [`📊 <b>Китай-радар · итоги дня</b> · ${today.getUTCDate()} ${MONTHS[today.getUTCMonth() + 1]}`,
    `📅 Сезон: ${d.season_label} · от ${d.min_nights} дней · до вылета ${left} ${plural(left, "день", "дня", "дней")}`, ""];
  const dayAgo = [...points].reverse().find((p) => Date.parse(p.t) <= now - 22 * 3600e3) ?? null;
  if (d.plan_window) {
    const p0: Item | undefined = d.plan?.[0];
    lines.push(`🎯 <b>Наши даты</b> (${windowText(d.plan_window)})`);
    lines.push(p0 ? `лучшее: <b>${money(p0.p)}</b> ${route(p0)} · ${sd(p0.d)}→${sd(p0.r)}${dayAgo?.plan ? arrow(p0.p - dayAgo.plan) + " за сутки" : ""}` : "пока ничего не нашлось", "");
  }
  if (d.best) {
    const b: Item = d.best;
    lines.push(`🔥 <b>Дешевле всего за сезон</b>`, `<b>${money(b.p)}</b> ${route(b)} · ${sd(b.d)}→${sd(b.r)} (${nights(b)} дн.)${dayAgo?.min ? arrow(b.p - dayAgo.min) + " за сутки" : ""}`, "");
    // динамика по дням: минимум каждого дня за последнюю неделю
    const byDay = new Map<string, number>();
    for (const p of points) {
      if (Date.parse(p.t) < now - 7 * 864e5) continue;
      const k = new Date(Date.parse(p.t) + 3 * 3600e3).toISOString().slice(0, 10);
      byDay.set(k, Math.min(byDay.get(k) ?? p.min, p.min));
    }
    const vals = [...byDay.values()];
    if (vals.length >= 2) lines.push(`📈 <b>Неделя</b>: ${sparkText(vals)}  от ${money(Math.min(...vals))} до ${money(Math.max(...vals))}`, "");
    const seen = new Set<string>(), rows: string[] = [];
    let drop: { x: string; v: number } | null = null;
    for (const i of (d.board ?? []) as Item[]) {
      if (seen.has(i.x)) continue;
      seen.add(i.x);
      const was = dayAgo?.c?.[i.x];
      const delta = was ? i.p - was : null;
      if (delta != null && delta < 0 && (!drop || delta < drop.v)) drop = { x: i.x, v: delta };
      if (rows.length < 5) rows.push(`${rows.length + 1}. ${cityName(i.x)} — ${kRub(i.p)}${arrow(delta)}`);
    }
    lines.push("🏙 <b>Топ городов</b>", ...rows);
    if (drop && drop.v <= -500) lines.push(`🏆 Сильнее всего подешевел ${cityName(drop.x)}: −${money(-drop.v)}`);
    lines.push("");
  } else {
    lines.push("Цен на этот сезон пока нет: продажи ещё не открыты или в кэше мало данных. Продолжаю следить.", "");
  }
  if (d.cny) {
    const was = dayAgo?.cny;
    const dc = was ? d.cny - was : 0;
    lines.push(`💴 1 ¥ = ${d.cny.toFixed(2).replace(".", ",")} ₽${was && Math.abs(dc) >= 0.01 ? ` (${dc > 0 ? "+" : "−"}${Math.abs(dc).toFixed(2).replace(".", ",")} за сутки)` : ""}`);
  }
  const words: Word[] = c.words ?? [];
  if (words.length) {
    const w = words[todayIdx() % words.length];
    lines.push(`🀄 Слово дня: <b>${esc(w.h)}</b> <i>${esc(w.p)}</i> — ${esc(w.ru)}`);
  }
  if (c.facts?.length) lines.push(`🎲 ${esc(c.facts[todayIdx() % c.facts.length])}`);
  return lines.join("\n").slice(0, 4000);
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
const edit = (chat: string | number, mid: number, text: string, markup?: unknown) =>
  tg("editMessageText", { chat_id: chat, message_id: mid, text, parse_mode: "HTML", disable_web_page_preview: true, ...(markup ? { reply_markup: markup } : {}) });

async function isBought() {
  const { data } = await db.from("trip_state").select("ticket_bought").eq("id", 1).maybeSingle();
  return !!data?.ticket_bought;
}

async function sendLive(chat: string, text: string): Promise<{ mid?: number; desc?: string }> {
  const photo = (await kv<string>("photo")) ?? PHOTO_URL;
  let res = await tg("sendPhoto", { chat_id: chat, photo, caption: text, parse_mode: "HTML", reply_markup: LIVE_KB });
  if (!res.ok && photo !== PHOTO_URL) res = await tg("sendPhoto", { chat_id: chat, photo: PHOTO_URL, caption: text, parse_mode: "HTML", reply_markup: LIVE_KB });
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
      const res = await tg("editMessageCaption", { chat_id: c.id, message_id: c.mid, caption: text, parse_mode: "HTML", reply_markup: LIVE_KB });
      if (res.ok || String(res.description).includes("not modified")) return;
    }
    const { mid, desc = "" } = await sendLive(c.id, text);
    if (!mid && c.id !== owner && /blocked|chat not found|kicked|deactivated/.test(desc)) {
      await db.from("radar_chat").delete().eq("id", c.id);
    }
  }));
}

async function allChats(): Promise<string[]> {
  const { data } = await db.from("radar_chat").select("id");
  return (data ?? []).map((c: { id: string }) => c.id);
}

async function updateTelegram(d: Data, alerts: { kind: string; old: number; new: number; item: Item }[]) {
  if (!(await kv<string>("tg"))) return;
  await updateLive(d);
  if (!alerts.length) return;
  const chats = await allChats();
  for (const a of alerts) {
    const i = a.item;
    const text = `📉 <b>Цена ${a.kind === "plan" ? "на наши даты" : "в Китай"} упала!</b>\n\n<b>${money(a.new)}</b> вместо ${money(a.old)}\n✈️ ${route(i)} · ${sd(i.d)} → ${sd(i.r)}`;
    const markup = { inline_keyboard: [[{ text: "🎫 Открыть билет", url: ticketUrl(i) }], [{ text: "💰 Все цены", callback_data: "prices" }]] };
    await Promise.all(chats.map((c) => say(c, text, markup)));
  }
}

async function sendDigest() {
  const res = await refresh("digest", true);
  const d = res.data;
  if (!d) return { ok: false, error: res.error };
  const hist = await blob<{ points: Point[] }>("history");
  const text = await digestText(d, (hist?.points ?? []).filter((p) => p.k === d.season_key));
  const chats = await allChats();
  await Promise.all(chats.map((c) => say(c, text, DIGEST_KB)));
  return { ok: true, chats: chats.length };
}

// ---------- учим китайский ----------
const LEVEL_WAIT = [5 * 60e3, 30 * 60e3, 864e5, 3 * 864e5, 7 * 864e5, 21 * 864e5];
const dots = (level: number) => "●".repeat(level) + "○".repeat(5 - level);

async function quiz(chat: string, mid?: number) {
  const words: Word[] = (await content()).words ?? [];
  if (!words.length) return say(chat, "Слова пока не загрузились, попробуйте через минуту.");
  const { data: rows } = await db.from("learn_progress").select("word, level, due").eq("chat", chat);
  const prog = new Map((rows ?? []).map((r: any) => [r.word, r]));
  const now = Date.now();
  const scored = words.map((w) => {
    const p: any = prog.get(w.id);
    const score = !p ? 50 + w.id / 100 : Date.parse(p.due) <= now ? (p.level >= 5 ? 80 : p.level) : 100 + p.level;
    return { w, score: score + Math.random() * 2 };
  }).sort((a, b) => a.score - b.score);
  const w = scored[0].w;
  const level = (prog.get(w.id) as any)?.level ?? 0;
  const mode = level < 2 || Math.random() < 0.5 ? "h" : "r"; // h: иероглиф → значение, r: значение → иероглиф
  const sameCat = words.filter((x) => x.id !== w.id && x.cat === w.cat).sort(() => Math.random() - 0.5);
  const others = words.filter((x) => x.id !== w.id && x.cat !== w.cat).sort(() => Math.random() - 0.5);
  const options = [w, ...[...sameCat, ...others].slice(0, 3)].sort(() => Math.random() - 0.5);
  const label = (x: Word) => (mode === "h" ? x.ru : `${x.h} ${x.p}`).slice(0, 60);
  const isNew = !prog.has(w.id);
  const head = `🀄 <b>Учим китайский</b> · ${w.cat}${isNew ? " · новое слово ✨" : " · " + dots(level)}`;
  const text = mode === "h"
    ? `${head}\n\n<b>${esc(w.h)}</b>\n<i>${esc(w.p)}</i>\n\nЧто это значит?`
    : `${head}\n\nКак сказать «<b>${esc(w.ru)}</b>»?`;
  const kb = {
    inline_keyboard: [
      ...[0, 2].map((i) => options.slice(i, i + 2).map((o) => ({ text: label(o), callback_data: `a:${w.id}:${o.id}` }))),
      [{ text: "🙈 Не знаю", callback_data: `a:${w.id}:0` }],
    ],
  };
  return mid ? edit(chat, mid, text, kb) : say(chat, text, kb);
}

async function answerQuiz(chat: string, mid: number, wid: number, chosen: number, cqId: string) {
  const words: Word[] = (await content()).words ?? [];
  const w = words.find((x) => x.id === wid);
  if (!w) return tg("answerCallbackQuery", { callback_query_id: cqId });
  const ok = wid === chosen;
  const { data: row } = await db.from("learn_progress").select("level, seen, correct").eq("chat", chat).eq("word", wid).maybeSingle();
  const level = ok ? Math.min((row?.level ?? 0) + 1, 5) : Math.max((row?.level ?? 0) - 1, 0);
  await db.from("learn_progress").upsert({
    chat, word: wid, level, due: new Date(Date.now() + LEVEL_WAIT[level]).toISOString(),
    seen: (row?.seen ?? 0) + 1, correct: (row?.correct ?? 0) + (ok ? 1 : 0),
  });
  const praise = ["Отлично!", "Верно!", "Так держать!", "加油！", "Супер!", "Точно!"];
  const yay = pick(praise);
  await tg("answerCallbackQuery", { callback_query_id: cqId, text: ok ? "✅ " + yay : chosen ? "❌ Не совсем" : "Запоминаем 👀" });
  const wrong = words.find((x) => x.id === chosen);
  const verdict = ok ? `✅ <b>${yay}</b>` : chosen ? `❌ <b>Не совсем.</b> Вы выбрали: ${esc(wrong?.ru ?? "")} (${esc(wrong?.h ?? "")})` : "👀 <b>Запоминаем:</b>";
  const text = `${verdict}\n\n<b>${esc(w.h)}</b>  <i>${esc(w.p)}</i>\n= ${esc(w.ru)}\n\nУровень слова: ${dots(level)}${level === 5 ? " выучено 🎓" : ""}`;
  await edit(chat, mid, text, { inline_keyboard: [[{ text: "➡️ Следующее слово", callback_data: "next" }], [{ text: "📊 Мой прогресс", callback_data: "progress" }]] });
}

async function progressText(chat: string): Promise<string> {
  const words: Word[] = (await content()).words ?? [];
  const { data: rows } = await db.from("learn_progress").select("word, level, seen, correct").eq("chat", chat);
  const prog = new Map((rows ?? []).map((r: any) => [r.word, r]));
  const lvl = (w: Word) => (prog.get(w.id) as any)?.level ?? 0;
  const learned = words.filter((w) => lvl(w) >= 3).length;
  const started = words.filter((w) => prog.has(w.id)).length;
  const seen = (rows ?? []).reduce((s: number, r: any) => s + r.seen, 0);
  const correct = (rows ?? []).reduce((s: number, r: any) => s + r.correct, 0);
  const cats = [...new Set(words.map((w) => w.cat))].map((cat) => {
    const ws = words.filter((w) => w.cat === cat);
    const done = ws.filter((w) => lvl(w) >= 3).length;
    const n = Math.round((done / ws.length) * 5);
    return `${"🟩".repeat(n)}${"⬜".repeat(5 - n)} ${cat}: ${done}/${ws.length}`;
  });
  return [`📊 <b>Ваш китайский</b>`, "", `🎓 Выучено: <b>${learned}</b> из ${words.length}`, `📖 В изучении: ${started - learned}`,
    `🎯 Точность: ${seen ? Math.round((correct / seen) * 100) : 0}% (${correct} из ${seen})`, "", ...cats,
    "", "Слово выучено с уровня ●●●○○. Я повторяю слова через растущие интервалы, так они запоминаются надолго."].join("\n");
}

async function yuanText(): Promise<string> {
  const d = await blob<Data>("data");
  const c = await content();
  const r: number | null = d?.cny ?? null;
  if (!r) return "💴 Курс юаня появится после ближайшего обновления цен.";
  const rows = (c.spend ?? []).map(([e, name, y]: [string, string, number]) => `${e} ${name} — ${y} ¥ ≈ ${money(y * r)}`);
  return [`💴 <b>Юань сегодня</b>: 1 ¥ = ${r.toFixed(2).replace(".", ",")} ₽ (курс ЦБ)`, `100 ¥ ≈ ${money(100 * r)} · 10 000 ₽ ≈ ${Math.round(10000 / r)} ¥`, "",
    "<b>Сколько что стоит в Китае</b> (примерно):", ...rows, "", "Конвертер на сайте: " + PAGE + "china.html#yuan"].join("\n");
}

async function factText() {
  const c = await content();
  return "🎲 <b>Факт о Китае</b>\n\n" + esc(pick<string>(c.facts?.length ? c.facts : ["Факты скоро появятся."]));
}
async function foodText() {
  const c = await content();
  const f = pick<any>(c.foods ?? []);
  if (!f) return "🍜 Список блюд скоро появится.";
  return `🍜 <b>Что попробовать</b>\n\n${f.e} <b>${esc(f.ru)}</b>\n${esc(f.h)} <i>${esc(f.p)}</i>\n\n${esc(f.about)}\n\nПокажите официанту: <b>${esc(f.h)}</b>`;
}
async function tipsText() {
  const c = await content();
  return ["🧳 <b>Шпаргалка путешественника</b>", ...(c.tips ?? []).map((t: any) => `${t.e} <b>${esc(t.t)}.</b> ${esc(t.text)}`)].join("\n\n").slice(0, 4000);
}
async function phraseText() {
  const c = await content();
  const p = pick<any>(c.phrases ?? []);
  return p ? `🗣 <b>${esc(p.h)}</b>\n<i>${esc(p.p)}</i>\n= ${esc(p.ru)}` : "Фразы скоро появятся.";
}
async function seasonText() {
  const s = await settings();
  const plan = s.plan ? `🎯 Наши даты: ${windowText(s.plan)}` : "🎯 Наши даты: не выбраны";
  return [`📅 <b>Сезон поиска</b>: ${seasonLabel(s)}`, plan, `⏱ Поездки от ${s.min_nights} дней`, "", `Поменять можно на сайте, блок «Когда летим»: ${PAGE}#season`].join("\n");
}

// ---------- Telegram: команды и кнопки ----------
const more = (data: string, text: string) => ({ inline_keyboard: [[{ text, callback_data: data }]] });
async function onUpdate(u: any) {
  if (u.callback_query) {
    const cq = u.callback_query;
    const chat = String(cq.message?.chat?.id ?? "");
    const mid = cq.message?.message_id;
    const data = String(cq.data ?? "");
    if (data.startsWith("a:")) {
      const [, wid, chosen] = data.split(":");
      return answerQuiz(chat, mid, +wid, +chosen, cq.id);
    }
    if (data === "refresh") {
      const d = await blob<Data>("data");
      const fresh = d?.updated_at && Date.now() - Date.parse(d.updated_at) < FRESH_MS;
      await tg("answerCallbackQuery", { callback_query_id: cq.id, text: fresh ? "Цены только что обновлены ✨" : "Ищу свежие цены по всему Китаю… ~10 секунд" });
      if (!fresh) await refresh("telegram-button");
      return;
    }
    if (data === "prices") {
      await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Проверяю актуальные цены… 🔎" });
      const res = await refresh("telegram-prices");
      return say(chat, pricesText(res.data ?? (await blob<Data>("data"))));
    }
    await tg("answerCallbackQuery", { callback_query_id: cq.id });
    const sameKind = (prefix: string) => mid && String(cq.message?.text ?? "").startsWith(prefix);
    if (data === "learn") return quiz(chat);
    if (data === "next") return quiz(chat, mid);
    if (data === "progress") return say(chat, await progressText(chat), more("learn", "▶️ Продолжить учить"));
    if (data === "yuan") return say(chat, await yuanText());
    if (data === "fact") return sameKind("🎲") ? edit(chat, mid, await factText(), more("fact", "🎲 Ещё факт")) : say(chat, await factText(), more("fact", "🎲 Ещё факт"));
    if (data === "food") return sameKind("🍜") ? edit(chat, mid, await foodText(), more("food", "🍜 Ещё блюдо")) : say(chat, await foodText(), more("food", "🍜 Ещё блюдо"));
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
      if ((count ?? 0) >= MAX_CHATS) return say(chat, "Извините, у радара уже максимум подписчиков.");
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
  if (!row) return say(chat, "Напишите /start, чтобы подключиться к Китай-радару 🇨🇳");

  if (cmd === "/stop") {
    await db.from("radar_chat").delete().eq("id", chat);
    return say(chat, "Окей, больше не присылаю обновления. Вернуться: /start");
  }
  if (cmd === "/update" || cmd === "/refresh" || low.startsWith("обнови")) {
    await say(chat, "Ищу свежие цены по всему Китаю 🔎 Секунд 10…");
    const res = await refresh("telegram-command");
    if (res.status === "error") return say(chat, "Не получилось обновить: " + res.error);
    return say(chat, "Готово ✨ Закреплённое сообщение обновлено.\n\n" + pricesText(res.data ?? null));
  }
  if (cmd === "/prices" || low.startsWith("цены")) {
    const res = await refresh("telegram-command");
    return say(chat, pricesText(res.data ?? (await blob<Data>("data"))));
  }
  if (cmd === "/bought" || cmd === "/kupil" || low.includes("купил")) {
    const next = !(await isBought());
    await db.from("trip_state").update({ ticket_bought: next }).eq("id", 1);
    await say(chat, next ? "🎉 Отметил: билет куплен! Китай, жди." : "Снял отметку: билет пока не куплен.");
    const d = await blob<Data>("data");
    if (d) await updateLive(d);
    return;
  }
  if (cmd === "/top") return say(chat, topText(await blob<Data>("data")));
  if (cmd === "/learn") return quiz(chat);
  if (cmd === "/progress") return say(chat, await progressText(chat), more("learn", "▶️ Продолжить учить"));
  if (cmd === "/yuan" || low.includes("юан")) return say(chat, await yuanText());
  if (cmd === "/fact") return say(chat, await factText(), more("fact", "🎲 Ещё факт"));
  if (cmd === "/food") return say(chat, await foodText(), more("food", "🍜 Ещё блюдо"));
  if (cmd === "/tips") return say(chat, await tipsText());
  if (cmd === "/phrase") return say(chat, await phraseText());
  if (cmd === "/season") return say(chat, await seasonText());
  if (cmd === "/digest") {
    const d = await blob<Data>("data");
    if (!d) return say(chat, "Данных пока нет.");
    const hist = await blob<{ points: Point[] }>("history");
    return say(chat, await digestText(d, (hist?.points ?? []).filter((p) => p.k === d.season_key)), DIGEST_KB);
  }
  return say(chat, HELP);
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
      await tg("setMyCommands", { commands: COMMANDS });
      report.tg = res.ok ? "сохранён, вебхук и команды настроены" : "вебхук: " + res.description;
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
    return reply({ ok: true, updated_at: d?.updated_at ?? null, count: d?.count ?? 0, season: d?.season_label ?? null });
  }

  const body = await req.json().catch(() => ({}));
  if (body.action === "sync") return onSync(req, body);
  if (body.action === "digest") {
    EdgeRuntime.waitUntil(sendDigest().then((r) => console.log("digest", JSON.stringify(r))));
    return reply({ ok: true, status: "started" });
  }
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
