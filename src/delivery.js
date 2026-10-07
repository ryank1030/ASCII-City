"use strict";
// Pizza delivery jobs: pick up at a pizzeria, then deliver to a street address
// before the timer runs out. Early arrival earns a tip; late still pays the
// base fare. Runs on the main thread only (workers just draw the beacon).
function makeDelivery(CITY, storage) {
  const W = CITY.W;
  const KEY = "asciiDowntown.delivery";
  const PICKUP_COL = [255, 140, 30], DROP_COL = [0, 230, 255];
  const REACH = 3, MIN_TRIP = 180, MAX_TRIP = 650;
  const wrap = d => d - W * Math.round(d / W);
  const manhattan = (ax, ay, bx, by) => Math.abs(wrap(bx - ax)) + Math.abs(wrap(by - ay));

  let stats = { cash: 0, deliveries: 0, bestTip: 0 };
  try {
    const saved = storage && JSON.parse(storage.getItem(KEY));
    if (saved) stats = Object.assign(stats, saved);
  } catch (e) { /* storage unavailable: start fresh */ }
  function save() {
    try { if (storage) storage.setItem(KEY, JSON.stringify(stats)); } catch (e) { /* ignore */ }
  }

  let state = "toPickup", shop = null, dest = null, limit = 0, elapsed = 0, base = 0;

  function nearestShop(x, y) {
    let best = null, bd = Infinity;
    for (const p of CITY.pizzerias) {
      const d = manhattan(x, y, p.addr.x, p.addr.y);
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }
  function pickDest(x, y) {
    const ok = CITY.addresses.filter(a => {
      const d = manhattan(x, y, a.x, a.y);
      return d >= MIN_TRIP && d <= MAX_TRIP;
    });
    const pool = ok.length ? ok : CITY.addresses;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  const target = () => (state === "carrying" ? dest : shop.addr);
  const fmtTime = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

  // Advance the job; returns a list of events ({type, text, sub}) for toasts.
  function update(cam, dt) {
    const ev = [];
    if (!shop) {
      shop = nearestShop(cam.x, cam.y);
      ev.push({ type: "order", text: "NEW ORDER", sub: `Pick up at ${shop.name}, ${shop.addr.label}` });
    }
    if (state === "carrying") elapsed += dt;
    const tg = target();
    const dist = Math.hypot(wrap(tg.x - cam.x), wrap(tg.y - cam.y));
    if (dist > REACH || cam.z > 4) return ev;

    if (state === "toPickup") {
      dest = pickDest(cam.x, cam.y);
      const trip = manhattan(cam.x, cam.y, dest.x, dest.y);
      limit = Math.round(20 + trip / 5.5);
      base = Math.round(8 + trip / 25);
      elapsed = 0;
      state = "carrying";
      ev.push({ type: "pickup", text: "PIZZA PICKED UP", sub: `Deliver to ${dest.label} in ${fmtTime(limit)}` });
    } else {
      const left = limit - elapsed;
      const tip = left > 0 ? Math.round(2 + base * 1.5 * left / limit) : 0;
      stats.cash += base + tip;
      stats.deliveries++;
      stats.bestTip = Math.max(stats.bestTip, tip);
      save();
      ev.push(left > 0
        ? { type: "delivered", text: `DELIVERED  +$${base + tip}`, sub: `fare $${base} + tip $${tip}` }
        : { type: "late", text: `LATE  +$${base}`, sub: "no tip this time - the pizza went cold" });
      state = "toPickup";
      shop = nearestShop(cam.x, cam.y);
      ev.push({ type: "order", text: "NEW ORDER", sub: `Pick up at ${shop.name}, ${shop.addr.label}` });
    }
    return ev;
  }

  // Objective for the renderer's beacon / ground ring.
  function goal() {
    if (!shop) return null;
    const tg = target(), c = state === "carrying" ? DROP_COL : PICKUP_COL;
    return { x: tg.x, y: tg.y, r: c[0], g: c[1], b: c[2] };
  }

  // ASCII compass: 41 cells spanning +-90 degrees around the view direction.
  function compass(cam) {
    const half = 20, cells = new Array(half * 2 + 1).fill("-");
    const ang = a => Math.atan2(Math.sin(a), Math.cos(a));
    const pos = theta => half - Math.round(ang(theta - cam.yaw) / (Math.PI / 2) * half);
    for (const [c, th] of [["E", 0], ["N", Math.PI / 2], ["W", Math.PI], ["S", -Math.PI / 2]]) {
      const p = pos(th);
      if (p >= 0 && p < cells.length) cells[p] = c;
    }
    const tg = target();
    const th = Math.atan2(wrap(tg.y - cam.y), wrap(tg.x - cam.x));
    const p = pos(th), rel = ang(th - cam.yaw);
    const col = state === "carrying" ? "drop" : "pick";
    let left = "  ", right = "  ";
    if (Math.abs(rel) > Math.PI / 2) { if (rel > 0) left = `<span class="${col}">&lt;&lt;</span>`; else right = `<span class="${col}">&gt;&gt;</span>`; }
    else if (p >= 0 && p < cells.length) cells[p] = `<span class="${col}">@</span>`;
    return `${left}[${cells.join("")}]${right}`;
  }

  function hudHTML(cam) {
    if (!shop) return "";
    const tg = target();
    const dist = Math.round(Math.hypot(wrap(tg.x - cam.x), wrap(tg.y - cam.y)));
    let line1, line2 = "";
    if (state === "carrying") {
      const left = limit - elapsed;
      line1 = `<span class="drop">DELIVER</span> to ${dest.label}`;
      line2 = left >= 0 ? `time ${fmtTime(left)}` : `<span class="late">LATE ${fmtTime(-left)}</span>`;
    } else {
      line1 = `<span class="pick">PICK UP</span> at ${shop.name}, ${shop.addr.label}`;
      line2 = "no rush";
    }
    return `${line1}\n${compass(cam)}\n${dist} m   ${line2}\n` +
      `$${stats.cash}   ${stats.deliveries} delivered   best tip $${stats.bestTip}`;
  }

  return { update, goal, hudHTML, carrying: () => state === "carrying" };
}
