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

    /* кнопка «Обновить»: ставит флаг в Supabase, GitHub подхватывает его в течение ~5 минут */
    refresher(btn, fresh, onDone) {
      let timer = null;
      const finish = (text) => { clearInterval(timer); btn.disabled = false; fresh.busy(false); if (text) fresh.busy(true, text), setTimeout(() => fresh.busy(false), 8000); };
      const run = () => {
        if (btn.disabled) return;
        btn.disabled = true;
        const known = fresh.get();
        fresh.busy(true, "Запрос отправлен 🔎 Ищу цены по всему Китаю, это займёт до 10 минут. Страница обновится сама.");
        fetch(SB_URL + "/rest/v1/trip_state?id=eq.1", { method: "PATCH", headers: { ...H, Prefer: "return=minimal" }, body: JSON.stringify({ refresh_requested: true }) })
          .then((r) => {
            if (!r.ok) throw new Error();
            const t0 = Date.now();
            timer = setInterval(() => {
              T.json("data.json").then((d) => {
                if (d && d.updated_at && d.updated_at !== known) { finish(); onDone(d); }
                else if (Date.now() - t0 > 15 * 60e3) finish("Обновление задерживается. Попробуйте ещё раз чуть позже.");
              });
            }, 20000);
          })
          .catch(() => finish("Не удалось отправить запрос. Проверьте, что в Supabase выполнен SQL из инструкции."));
      };
      btn.addEventListener("click", run);
      return run;
    },
  };
  window.T = T;
})();
