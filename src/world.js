"use strict";
// Procedural downtown. Every solid thing in the world is an axis-aligned box.
// Boxes are bucketed into a uniform grid of CS-metre cells that the renderer
// walks with a DDA. The whole map wraps around (torus), so the city never ends.
function makeCity() {
  const P = 64;        // block pitch: street centreline to street centreline
  const ROAD = 6;      // half-width of the asphalt
  const WALK = 10;     // sidewalk outer edge (distance from centreline)
  const NB = 16;       // blocks per side
  const W = P * NB;    // world size (m)
  const CS = 4;        // grid cell size (m)
  const N = W / CS;    // cells per side

  const M = {
    BLDG: 1, SIGN: 2, POLE: 3, LAMP: 4, GLASS: 5, AD: 6, BENCH: 7, BIN: 8,
    TLIGHT: 9, VEND: 10, ANTENNA: 11, TANK: 12, HOLO: 13, ROOF: 14,
    CAR: 15, CABIN: 16, FLYER: 17, AC: 18, PLANTER: 19,
  };

  const NEON = [
    [255, 60, 190], [0, 235, 255], [185, 90, 255], [255, 215, 60],
    [60, 255, 140], [255, 70, 70], [255, 145, 40], [70, 130, 255],
  ];
  const TINTS = [
    [78, 84, 112], [96, 80, 108], [70, 96, 108], [104, 98, 96],
    [80, 80, 92], [60, 70, 96], [110, 90, 120],
  ];
  const WINCOL = [
    [255, 196, 120], [240, 235, 200], [255, 210, 150], [130, 225, 255],
    [255, 130, 215], [190, 140, 255], [150, 255, 180],
  ];

  const SHOPS = ["RAMEN", "NOODLES", "SUSHI", "BAR", "HOTEL", "CLINIC", "ARCADE",
    "KARAOKE", "PHARMACY", "TATTOO", "OPEN 24H", "SYNTH", "CAFE", "CLUB",
    "PACHINKO", "LIQUOR", "MOTEL", "SAKE", "RADIO", "DUMPLINGS", "DINER",
    "IMPLANTS", "NEURO", "MARKET", "CYBERWARE", "PAWN", "LOUNGE", "DATA",
    "REPAIR", "VIDEO", "GYM", "HOSTEL", "BIOLAB", "DOJO", "NOODLE BAR", "TEA",
    "PIZZA", "TACOS", "KEBAB", "ROBOTS", "MODS", "GAMES", "CAPSULES", "BOBA",
    "NAILS", "OPTICS", "CASINO", "RECORDS", "ELECTRO", "UDON", "BBQ", "JAZZ"];
  const BRANDS = ["KESSLER", "ZENTEK", "HELIX", "MIRAI", "SYNAPSE", "VOLTA",
    "NOVA-9", "AXIOM", "HYPERION", "ORBITAL", "SOLACE", "QUANTA", "NEXUS",
    "OMNIDYNE", "VANTA", "TAKUMI", "HALCYON", "TESSERA", "KAIROS", "ARGENT"];
  const ADS = ["DRINK VOLT", "UPGRADE NOW", "SLEEP LESS", "2099", "FEEL NEW",
    "LIVE 4EVER", "JACK IN", "BE MORE", "NO LIMITS", "OBEY", "BUY BUY BUY"];
  const AVES = ["NEON", "CHROME", "KANJI", "LOTUS", "RIVET", "SPARK", "ONYX",
    "ECHO", "CIRCUIT", "VAPOR", "OMEGA", "JADE", "COBALT", "DRIFT", "PULSE", "HALO"];

  function ordinal(n) {
    const s = (n % 100 >= 11 && n % 100 <= 13) ? "TH" : ({ 1: "ST", 2: "ND", 3: "RD" }[n % 10] || "TH");
    return n + s;
  }
  // Streets along y (constant x = i*P) are avenues; streets along x are numbered.
  const aveName = i => AVES[((i % NB) + NB) % NB] + " AV";
  const stName = j => ordinal((((j % NB) + NB) % NB) + 1) + " ST";

  // ---- seeded RNG ----
  let rs = 1337;
  function rnd() {
    rs = (rs + 0x6D2B79F5) | 0;
    let t = Math.imul(rs ^ (rs >>> 15), 1 | rs);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  const pick = a => a[Math.floor(rnd() * a.length)];
  const rgb = c => (c[0] << 16) | (c[1] << 8) | c[2];

  // ---- box storage ----
  let cap = 8192, nb = 0;
  let B = new Float32Array(cap * 6);
  let BM = new Uint8Array(cap), BP = new Int32Array(cap), BC = new Int32Array(cap), BS = new Int32Array(cap);
  function grow() {
    cap *= 2;
    const b = new Float32Array(cap * 6); b.set(B); B = b;
    const m = new Uint8Array(cap); m.set(BM); BM = m;
    const p = new Int32Array(cap); p.set(BP); BP = p;
    const c = new Int32Array(cap); c.set(BC); BC = c;
    const s = new Int32Array(cap); s.set(BS); BS = s;
  }
  function add(x0, y0, z0, x1, y1, z1, mat, param, color, seed) {
    if (nb >= cap) grow();
    const o = nb * 6;
    B[o] = Math.min(x0, x1); B[o + 1] = Math.min(y0, y1); B[o + 2] = Math.min(z0, z1);
    B[o + 3] = Math.max(x0, x1); B[o + 4] = Math.max(y0, y1); B[o + 5] = Math.max(z0, z1);
    BM[nb] = mat; BP[nb] = param | 0; BC[nb] = color | 0;
    BS[nb] = seed === undefined ? (rnd() * 2147483647) | 0 : seed | 0;
    return nb++;
  }

  // ---- sign texts ----
  const texts = [], textIdx = new Map();
  function T(s) {
    if (!textIdx.has(s)) { textIdx.set(s, texts.length); texts.push(s); }
    return textIdx.get(s);
  }
  // sign param: text index | flags << 16.  flag 1 = plate style (coloured
  // background, white letters), flag 2 = flickers.
  const SF_PLATE = 1, SF_FLICKER = 2;
  function sign(x0, y0, z0, x1, y1, z1, text, color, flags) {
    return add(x0, y0, z0, x1, y1, z1, M.SIGN, T(text) | (flags << 16), rgb(color));
  }

  // Sidewalk-local box. side: 0 = street at y=by (lot on +y), 1 = street at
  // y=by+P, 2 = street at x=bx, 3 = street at x=bx+P. `a` runs along the
  // street (0..P), `d` is the distance from the street centreline.
  function sideRect(bx, by, side, a0, a1, d0, d1) {
    switch (side) {
      case 0: return [bx + a0, by + d0, bx + a1, by + d1];
      case 1: return [bx + a0, by + P - d1, bx + a1, by + P - d0];
      case 2: return [bx + d0, by + a0, bx + d1, by + a1];
      default: return [bx + P - d1, by + a0, bx + P - d0, by + a1];
    }
  }
  function sb(bx, by, side, a0, a1, d0, d1, z0, z1, mat, param, color) {
    const r = sideRect(bx, by, side, a0, a1, d0, d1);
    return add(r[0], r[1], z0, r[2], r[3], z1, mat, param || 0, color || 0);
  }
  function sideSign(bx, by, side, a0, a1, d0, d1, z0, z1, text, color, flags) {
    const r = sideRect(bx, by, side, a0, a1, d0, d1);
    return sign(r[0], r[1], z0, r[2], r[3], z1, text, color, flags || 0);
  }

  const plaza = new Uint8Array(NB * NB);

  // ---- buildings ----
  function bldgParam(style, lit, tint, edge) {
    return style | (Math.floor(lit * 255) << 4) | (tint << 12) | ((edge ? 1 : 0) << 16);
  }

  function facadeSigns(bx, by, x0, y0, x1, y1, h) {
    const L0 = WALK, L1 = P - WALK;
    for (let side = 0; side < 4; side++) {
      let a0, a1;
      if (side === 0 && y0 === by + L0) { a0 = x0 - bx; a1 = x1 - bx; }
      else if (side === 1 && y1 === by + L1) { a0 = x0 - bx; a1 = x1 - bx; }
      else if (side === 2 && x0 === bx + L0) { a0 = y0 - by; a1 = y1 - by; }
      else if (side === 3 && x1 === bx + L1) { a0 = y0 - by; a1 = y1 - by; }
      else continue;
      const len = a1 - a0;
      if (len < 5) continue;
      // storefront signs above the shop windows
      const n = Math.max(1, Math.floor(len / 13));
      const seg = len / n;
      for (let k = 0; k < n; k++) {
        if (rnd() < 0.2) continue;
        const w = Math.min(seg - 1.5, 4.5 + rnd() * 7);
        const ac = a0 + seg * (k + 0.5);
        const hh = 1.1 + rnd() * 0.7;
        sideSign(bx, by, side, ac - w / 2, ac + w / 2, 9.7, 10, 4.1, 4.1 + hh,
          pick(SHOPS), pick(NEON), rnd() < 0.15 ? SF_FLICKER : 0);
      }
      // vertical blade signs sticking out over the sidewalk
      if (h > 12) {
        const nBlade = 1 + (rnd() < 0.6 ? 1 : 0) + (rnd() < 0.3 ? 1 : 0);
        for (let k = 0; k < nBlade; k++) {
          const a = a0 + 2 + rnd() * (len - 4);
          const top = Math.min(h - 1, 32);
          const hh = Math.min(3.5 + rnd() * 7, top - 6);
          if (hh < 2.5) continue;
          const z0 = 6 + rnd() * (top - 6 - hh);
          sideSign(bx, by, side, a - 0.12, a + 0.12, 8.2, 9.9, z0, z0 + hh,
            pick(SHOPS), pick(NEON), rnd() < 0.12 ? SF_FLICKER : 0);
        }
      }
      // big wall billboard high on tall buildings
      if (h > 34 && len > 18 && rnd() < 0.45) {
        const w = 12 + rnd() * (Math.min(26, len - 4) - 12);
        const hb = w * (0.28 + rnd() * 0.18);
        const z0 = 14 + rnd() * Math.max(0, h - hb - 20);
        const ac = a0 + len / 2;
        sideSign(bx, by, side, ac - w / 2, ac + w / 2, 9.55, 10, z0, z0 + hb,
          rnd() < 0.6 ? pick(BRANDS) : pick(ADS), pick(NEON), 0);
      }
    }
  }

  function rooftop(bx, by, x0, y0, x1, y1, z) {
    const w = x1 - x0, d = y1 - y0;
    // AC units / vents
    const nAC = Math.floor(rnd() * 4);
    for (let k = 0; k < nAC; k++) {
      const ax = x0 + 1 + rnd() * Math.max(0.1, w - 4), ay = y0 + 1 + rnd() * Math.max(0.1, d - 4);
      add(ax, ay, z, ax + 1.5 + rnd() * 1.5, ay + 1.5 + rnd() * 1.5, z + 1 + rnd() * 1.5, M.AC);
    }
    if (z < 45 && rnd() < 0.35) { // water tank
      const ax = x0 + 1 + rnd() * Math.max(0.1, w - 5), ay = y0 + 1 + rnd() * Math.max(0.1, d - 5);
      add(ax + 0.2, ay + 0.2, z, ax + 0.4, ay + 0.4, z + 2.5, M.POLE);
      add(ax + 2.6, ay + 2.6, z, ax + 2.8, ay + 2.8, z + 2.5, M.POLE);
      add(ax, ay, z + 2.5, ax + 3, ay + 3, z + 6, M.TANK);
    }
    if (z > 50 && rnd() < 0.55) { // antenna mast
      const cx = (x0 + x1) / 2 + (rnd() - 0.5) * w * 0.4, cy = (y0 + y1) / 2 + (rnd() - 0.5) * d * 0.4;
      const hh = 12 + rnd() * 35;
      add(cx - 0.25, cy - 0.25, z, cx + 0.25, cy + 0.25, z + hh, M.ANTENNA);
    }
    // rooftop billboard facing a street
    if (z < 80 && w > 12 && rnd() < 0.3) {
      const facePosY = rnd() < 0.5;
      const sw = Math.min(w - 2, 10 + rnd() * 10), sh = sw * (0.3 + rnd() * 0.15);
      const cx = (x0 + x1) / 2;
      const yy = facePosY ? y1 - 1.6 : y0 + 1.3;
      add(cx - sw / 2 + 0.5, yy + 0.05, z, cx - sw / 2 + 0.7, yy + 0.25, z + 2, M.POLE);
      add(cx + sw / 2 - 0.7, yy + 0.05, z, cx + sw / 2 - 0.5, yy + 0.25, z + 2, M.POLE);
      sign(cx - sw / 2, yy, z + 2, cx + sw / 2, yy + 0.3, z + 2 + sh,
        rnd() < 0.5 ? pick(BRANDS) : pick(ADS), pick(NEON), rnd() < 0.1 ? SF_FLICKER : 0);
    }
  }

  function building(bx, by, x0, y0, x1, y1, h) {
    const style = Math.floor(rnd() * 4);
    const tint = Math.floor(rnd() * TINTS.length);
    const lit = 0.08 + rnd() * 0.3;
    const wc = rgb(pick(WINCOL));
    const edge = rnd() < 0.18;
    const edgeCol = rgb(pick(NEON));
    const seed = (rnd() * 2147483647) | 0;
    let top = [x0, y0, x1, y1, h];
    if (h > 42 && rnd() < 0.75) {
      const pod = 7.2 + Math.floor(rnd() * 4) * 3.6;
      add(x0, y0, 0, x1, y1, pod, M.BLDG, bldgParam(Math.floor(rnd() * 4), lit, tint, false), wc, seed ^ 0x55);
      const inset = Math.min(3 + rnd() * 5, (Math.min(x1 - x0, y1 - y0) - 8) / 2);
      const tx0 = x0 + inset, ty0 = y0 + inset, tx1 = x1 - inset, ty1 = y1 - inset;
      add(tx0, ty0, pod, tx1, ty1, h, M.BLDG, bldgParam(style, lit, tint, edge), edge ? edgeCol : wc, seed);
      top = [tx0, ty0, tx1, ty1, h];
      if (h > 95 && rnd() < 0.65 && Math.min(tx1 - tx0, ty1 - ty0) > 12) {
        const i2 = 2.5 + rnd() * 3.5;
        const hc = h + 8 + rnd() * 30;
        add(tx0 + i2, ty0 + i2, h, tx1 - i2, ty1 - i2, hc, M.BLDG, bldgParam(style, lit * 0.8, tint, edge), edge ? edgeCol : wc, seed ^ 0x77);
        top = [tx0 + i2, ty0 + i2, tx1 - i2, ty1 - i2, hc];
      }
      facadeSigns(bx, by, x0, y0, x1, y1, pod);
    } else {
      add(x0, y0, 0, x1, y1, h, M.BLDG, bldgParam(style, lit, tint, edge), edge ? edgeCol : wc, seed);
      facadeSigns(bx, by, x0, y0, x1, y1, h);
    }
    rooftop(bx, by, top[0], top[1], top[2], top[3], top[4]);
  }

  function heightFor(down, area) {
    let h = 8 + rnd() * 18 + down * down * (50 + rnd() * 170) * (0.6 + 0.4 * Math.min(1, area / 1900));
    if (rnd() < 0.04) h += 90 + rnd() * 80;
    return Math.min(h, 270);
  }

  function plazaBlock(bi, bj, bx, by) {
    plaza[bi * NB + bj] = 1;
    const cx = bx + P / 2, cy = by + P / 2;
    const hh = 22 + rnd() * 30;
    add(cx - 2.5, cy - 2.5, 0, cx + 2.5, cy + 2.5, 1.2, M.PLANTER);
    add(cx - 1.8, cy - 1.8, 1.2, cx + 1.8, cy + 1.8, hh, M.HOLO, Math.floor(rnd() * 2), rgb(pick(NEON)));
    for (let k = 0; k < 4; k++) {
      const ang = k * Math.PI / 2 + Math.PI / 4;
      const px = cx + Math.cos(ang) * 13, py = cy + Math.sin(ang) * 13;
      add(px - 2, py - 2, 0, px + 2, py + 2, 0.8, M.PLANTER);
      add(px - 0.12, py - 0.12, 0, px + 0.12, py + 0.12, 5, M.POLE);
      add(px - 0.4, py - 0.4, 5, px + 0.4, py + 0.4, 5.4, M.LAMP);
    }
    for (let k = 0; k < 4; k++) {
      const ang = k * Math.PI / 2;
      const px = cx + Math.cos(ang) * 8, py = cy + Math.sin(ang) * 8;
      if (k % 2 === 0) add(px - 0.3, py - 1.5, 0.45, px + 0.3, py + 1.5, 0.55, M.BENCH);
      else add(px - 1.5, py - 0.3, 0.45, px + 1.5, py + 0.3, 0.55, M.BENCH);
    }
  }

  function furniture(bi, bj, bx, by) {
    const busSide = rnd() < 0.5 ? Math.floor(rnd() * 4) : -1;
    for (let side = 0; side < 4; side++) {
      // street lamps: pole on the curb, arm reaching over the road
      for (let a = 16; a <= 48; a += 16) {
        sb(bx, by, side, a - 0.12, a + 0.12, 6.5, 6.74, 0, 7.3, M.POLE);
        sb(bx, by, side, a - 0.07, a + 0.07, 5.0, 6.74, 7.1, 7.22, M.POLE);
        sb(bx, by, side, a - 0.35, a + 0.35, 4.7, 5.5, 6.85, 7.1, M.LAMP);
      }
      if (side === busSide) {
        const col = pick(NEON);
        sb(bx, by, side, 20, 26.2, 7.0, 9.45, 2.6, 2.75, M.ROOF);
        sb(bx, by, side, 20.2, 26.0, 9.2, 9.3, 0.25, 2.6, M.GLASS);
        sb(bx, by, side, 20.15, 20.3, 8.0, 9.3, 0.25, 2.6, M.GLASS);
        sb(bx, by, side, 25.9, 26.05, 7.4, 9.3, 0.25, 2.6, M.AD, 0, rgb(col));
        sb(bx, by, side, 21, 25, 8.55, 9.1, 0.45, 0.55, M.BENCH);
        sb(bx, by, side, 27.5, 27.65, 6.6, 6.75, 0, 2.3, M.POLE);
        sideSign(bx, by, side, 27.55, 27.6, 6.1, 7.3, 2.3, 3.1, "BUS " + (1 + Math.floor(rnd() * 99)), [40, 110, 255], SF_PLATE);
      }
      if (rnd() < 0.35) {
        const a = 36 + rnd() * 7;
        sb(bx, by, side, a, a + 1.1, 9.2, 9.98, 0, 1.9, M.VEND, 0, rgb(pick(NEON)));
      }
      if (rnd() < 0.6) {
        const a = rnd() < 0.5 ? 11.5 : 40.5;
        sb(bx, by, side, a, a + 0.6, 6.5, 7.1, 0, 0.95, M.BIN);
      }
    }
    // corner traffic lights + street name plates
    const corners = [[6.6, 6.6, -1, -1, 0, 0], [P - 6.6, 6.6, 1, -1, 1, 0], [6.6, P - 6.6, -1, 1, 0, 1], [P - 6.6, P - 6.6, 1, 1, 1, 1]];
    for (const c of corners) {
      const x = bx + c[0], y = by + c[1];
      add(x - 0.12, y - 0.12, 0, x + 0.12, y + 0.12, 5.3, M.POLE);
      const hx = x + c[2] * 0.4, hy = y + c[3] * 0.4;
      add(hx - 0.25, hy - 0.25, 3.3, hx + 0.25, hy + 0.25, 4.5, M.TLIGHT);
      // plate naming the street along x (constant y) and the avenue along y
      const sj = bj + c[5], si = bi + c[4];
      sign(x - 0.95, y - 0.03, 4.65, x + 0.95, y + 0.03, 5.0, stName(sj), [20, 120, 60], SF_PLATE);
      sign(x - 0.03, y - 0.95, 5.05, x + 0.03, y + 0.95, 5.4, aveName(si), [20, 120, 60], SF_PLATE);
    }
  }

  function genBlock(bi, bj) {
    const bx = bi * P, by = bj * P;
    const cx = (bi + 0.5) / NB - 0.5, cy = (bj + 0.5) / NB - 0.5;
    const down = Math.max(0, 1 - Math.sqrt(cx * cx + cy * cy) * 2.1);
    const L0 = WALK, L1 = P - WALK;
    const u = rnd();
    const lots = [];
    if (u < 0.07 && down < 0.75) plazaBlock(bi, bj, bx, by);
    else if (u < 0.22 + 0.45 * down) lots.push([L0, L0, L1, L1]);
    else if (u < 0.62) {
      const m = L0 + 15 + rnd() * 14, g = rnd() < 0.5 ? 3 : 0;
      if (rnd() < 0.5) { lots.push([L0, L0, m - g / 2, L1]); lots.push([m + g / 2, L0, L1, L1]); }
      else { lots.push([L0, L0, L1, m - g / 2]); lots.push([L0, m + g / 2, L1, L1]); }
    } else {
      const mx = L0 + 16 + rnd() * 12, my = L0 + 16 + rnd() * 12, g = rnd() < 0.5 ? 3 : 0;
      lots.push([L0, L0, mx - g / 2, my - g / 2]); lots.push([mx + g / 2, L0, L1, my - g / 2]);
      lots.push([L0, my + g / 2, mx - g / 2, L1]); lots.push([mx + g / 2, my + g / 2, L1, L1]);
    }
    for (const l of lots) {
      const area = (l[2] - l[0]) * (l[3] - l[1]);
      building(bx, by, bx + l[0], by + l[1], bx + l[2], by + l[3], heightFor(down, area));
    }
    furniture(bi, bj, bx, by);
  }

  for (let bj = 0; bj < NB; bj++) for (let bi = 0; bi < NB; bi++) genBlock(bi, bj);

  // ---- spatial grid (CSR layout) ----
  const cellStart = new Int32Array(N * N + 1);
  const cellMaxH = new Float32Array(N * N);
  const cellRange = b => {
    const o = b * 6;
    return [Math.max(0, Math.floor(B[o] / CS)), Math.max(0, Math.floor(B[o + 1] / CS)),
      Math.min(N - 1, Math.floor((B[o + 3] - 1e-4) / CS)), Math.min(N - 1, Math.floor((B[o + 4] - 1e-4) / CS))];
  };
  for (let b = 0; b < nb; b++) {
    const r = cellRange(b);
    for (let y = r[1]; y <= r[3]; y++) for (let x = r[0]; x <= r[2]; x++) {
      const ci = y * N + x;
      cellStart[ci + 1]++;
      if (B[b * 6 + 5] > cellMaxH[ci]) cellMaxH[ci] = B[b * 6 + 5];
    }
  }
  for (let i = 0; i < N * N; i++) cellStart[i + 1] += cellStart[i];
  const cellItems = new Int32Array(cellStart[N * N]);
  const fill = cellStart.slice(0, N * N);
  // Tall boxes first so rays tend to find the big occluders early.
  const order = Array.from({ length: nb }, (_, i) => i).sort((a, b) => B[b * 6 + 5] - B[a * 6 + 5]);
  for (const b of order) {
    const r = cellRange(b);
    for (let y = r[1]; y <= r[3]; y++) for (let x = r[0]; x <= r[2]; x++) cellItems[fill[y * N + x]++] = b;
  }
  let maxH = 0;
  for (let i = 0; i < N * N; i++) if (cellMaxH[i] > maxH) maxH = cellMaxH[i];

  // ---- traffic ----
  // Each vehicle: axis (0 along x, 1 along y), street index, lane offset,
  // direction, speed, phase, altitude (0 = ground car), colour.
  const vehicles = [];
  for (let k = 0; k < 110; k++) {
    const axis = rnd() < 0.5 ? 0 : 1, dir = rnd() < 0.5 ? 1 : -1;
    const lane = rnd() < 0.5 ? 1.5 : 4.4;
    // right-hand traffic
    const off = axis === 0 ? -dir * lane : dir * lane;
    vehicles.push({ axis, street: Math.floor(rnd() * NB) * P, off, dir, speed: 9 + rnd() * 12,
      phase: rnd() * W, z: 0, color: rgb(rnd() < 0.3 ? pick(NEON) : pick(TINTS).map(v => v * 1.3)), neon: rgb(pick(NEON)) });
  }
  for (let k = 0; k < 70; k++) {
    const axis = rnd() < 0.5 ? 0 : 1, dir = rnd() < 0.5 ? 1 : -1;
    vehicles.push({ axis, street: Math.floor(rnd() * NB) * P, off: (rnd() - 0.5) * 7, dir, speed: 18 + rnd() * 30,
      phase: rnd() * W, z: 22 + rnd() * 110, color: rgb([60, 60, 75]), neon: rgb(pick(NEON)) });
  }

  return {
    P, ROAD, WALK, NB, W, CS, N, M, NEON, TINTS, maxH,
    B, BM, BP, BC, BS, nb, cellStart, cellItems, cellMaxH,
    texts, plaza, vehicles, aveName, stName, SF_PLATE, SF_FLICKER,
  };
}
