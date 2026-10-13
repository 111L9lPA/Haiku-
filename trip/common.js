/* Китай-радар: общие функции для главной страницы и календаря */
(function () {
  const SB_URL = "https://exmxqybejhbtnbtqcwms.supabase.co";
  // Публичный (publishable) ключ Supabase: его безопасно хранить в коде, доступ ограничен правилами базы.
  const SB_KEY = "sb_publishable_H_c3d5terU1y4slV6t-ChQ_bnfECYM2";
  const H = { apikey: SB_KEY, "Content-Type": "application/json" };
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

  const T = {
    SB_URL, H, reduce,
    $: (id) => document.getElementById(id),
    el(tag, cls, text) {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text != null) e.textContent = text;
      return e;
    },
    rub: (n) => Math.round(n).toLocaleString("ru-RU") + " ₽",
    k: (n) => Math.round(n / 1000) + "к",
    dt: (iso) => new Date(iso + "T00:00:00"),
    dm: (iso) => T.dt(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "long" }),
    short: (iso) => T.dt(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "short" }).replace(".", ""),
    nights: (i) => Math.round((T.dt(i.r) - T.dt(i.d)) / 864e5),
    plural(n, a, b, c) { const m = Math.abs(n) % 100, k = m % 10; return m > 10 && m < 20 ? c : k === 1 ? a : k > 1 && k < 5 ? b : c; },
    stops: (n) => (n == null ? "" : n === 0 ? "без пересадок" : n + " " + (n === 1 ? "пересадка" : "пересадки")),
    isDirect: (i) => i.t === 0 && !i.rt,
    ago(ms) {
      const m = Math.round(ms / 60000);
      if (m < 1) return "только что";
      if (m < 60) return m + " мин назад";
      const h = Math.floor(m / 60);
      return h < 48 ? h + " ч назад" : Math.floor(h / 24) + " дн назад";
    },
    url(i) {
      if (i.l) return "https://www.aviasales.ru" + i.l;
      const dd = (iso) => iso.slice(8, 10) + iso.slice(5, 7);
      return "https://www.aviasales.ru/search/" + i.o + dd(i.d) + i.x + dd(i.r) + "1";
    },
    store: {
      get(key, def) { try { const v = localStorage.getItem("kr:" + key); return v == null ? def : JSON.parse(v); } catch (e) { return def; } },
      set(key, v) { try { localStorage.setItem("kr:" + key, JSON.stringify(v)); } catch (e) { /* без памяти тоже работает */ } },
    },
    json: (u) => fetch(u + (u.includes("?") ? "&" : "?") + "v=" + Date.now()).then((r) => (r.ok ? r.json() : null)).catch(() => null),

    countUp(el, to, fmt) {
      if (reduce || !(to > 0)) { el.textContent = fmt(to); return; }
      const t0 = performance.now(), dur = 1100;
      const step = (t) => {
        const p = Math.min((t - t0) / dur, 1), e = 1 - Math.pow(1 - p, 3);
        el.textContent = fmt(Math.round(to * e));
        if (p < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    },

    spark(svg, values) {
      const vals = values.filter((v) => v != null);
      if (vals.length < 2) { svg.hidden = true; return false; }
      const lo = Math.min(...vals), hi = Math.max(...vals), span = Math.max(hi - lo, 1);
      const x = (i) => (i / (vals.length - 1)) * 100;
      const y = (v) => 52 - ((v - lo) / span) * 44;
      const d = vals.map((v, i) => (i ? "L" : "M") + x(i).toFixed(2) + " " + y(v).toFixed(2)).join(" ");
      svg.setAttribute("viewBox", "0 0 100 60");
      svg.setAttribute("preserveAspectRatio", "none");
      svg.innerHTML = '<path class="area" d="' + d + ' L100 60 L0 60 Z"/><path class="line" d="' + d + '"/>';
      svg.hidden = false;
      return { lo, hi, last: vals[vals.length - 1] };
    },

    /* актуальность данных: «Данные от 12 окт., 22:26 · 5 мин назад» */
    freshness(el) {
      let iso = null, busy = false;
      const paint = () => {
        if (busy) return;
        if (!iso) { el.textContent = "Данные ещё не обновлялись"; return; }
        const d = new Date(iso), age = Date.now() - d;
        el.textContent = "Данные от " + d.toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) + " · " + T.ago(age);
        el.classList.toggle("stale", age > 6 * 3600e3);
      };
      setInterval(paint, 60000);
      return { set(v) { iso = v; paint(); }, busy(v, text) { busy = v; if (text) { el.classList.remove("stale"); el.textContent = text; } else paint(); }, get: () => iso };
    },

    /* сезон поиска и «наши даты»: общие для всех, хранятся в Supabase */
    settings() {
      return fetch(SB_URL + "/rest/v1/trip_settings?id=eq.1&select=settings", { headers: H })
        .then((r) => (r.ok ? r.json() : [])).then((rows) => (rows[0] ? rows[0].settings : null)).catch(() => null);
    },
    saveSettings(s) {
      return fetch(SB_URL + "/rest/v1/trip_settings?id=eq.1", {
        method: "PATCH", headers: { ...H, Prefer: "return=minimal" },
        body: JSON.stringify({ settings: s, updated_at: new Date().toISOString() }),
      }).then((r) => { if (!r.ok) throw new Error("save"); });
    },
    MONTHS: ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"],
    monthLabel: (ym) => T.MONTHS[+ym.slice(5, 7) - 1] + " " + ym.slice(0, 4),
    span(from, to) {
      if (from === to) return T.dm(from);
      return from.slice(0, 7) === to.slice(0, 7) ? T.dt(from).getDate() + "–" + T.dm(to) : T.dm(from) + " – " + T.dm(to);
    },
    content: () => T.json("content.json"),
    speak(text) {
      if (!("speechSynthesis" in window)) return false;
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "zh-CN"; u.rate = 0.8;
      const v = speechSynthesis.getVoices().find((x) => /zh/i.test(x.lang));
      if (v) u.voice = v;
      speechSynthesis.cancel(); speechSynthesis.speak(u);
      return true;
    },

    /* готовые данные из Supabase (data, prices, history); если недоступно, берём снимок из репозитория */
    blob(name) {
      return fetch(SB_URL + "/rest/v1/radar_blob?select=body&name=eq." + name, { headers: H })
        .then((r) => (r.ok ? r.json() : []))
        .then((rows) => (rows[0] ? rows[0].body : T.json(name + ".json")))
        .catch(() => T.json(name + ".json"));
    },

    /* кнопка «Обновить»: серверная функция ищет цены прямо сейчас, это 10–20 секунд */
    refresher(btn, fresh, onDone) {
      const flash = (text) => { fresh.busy(true, text); setTimeout(() => fresh.busy(false), 7000); };
      const run = () => {
        if (btn.disabled) return;
        btn.disabled = true;
        const t0 = Date.now();
        const tick = () => fresh.busy(true, "🔎 Ищу цены по всему Китаю… " + Math.round((Date.now() - t0) / 1000) + " сек");
        tick();
        const timer = setInterval(tick, 1000);
        const done = (text, data) => { clearInterval(timer); btn.disabled = false; fresh.busy(false); if (data) onDone(data); flash(text); };
        fetch(SB_URL + "/functions/v1/radar", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "refresh" }) })
          .then((r) => r.json())
          .then((res) => {
            if (res.status === "ok") done("Готово ✨ Цены обновлены", res.data);
            else if (res.status === "fresh") done("Цены свежие: обновлены меньше минуты назад ✨", res.data);
            else if (res.status === "busy") done("Поиск уже идёт, через полминуты нажмите ещё раз", res.data);
            else done("Не получилось обновить: " + (res.error || "ошибка сервера"), res.data);
          })
          .catch(() => done("Нет связи с сервером. Попробуйте ещё раз."));
      };
      btn.addEventListener("click", run);
      return run;
    },
  };
  window.T = T;
})();
