"use strict";
// CPU ray tracer: one ray per character cell. Each shade call produces a
// character code plus an RGB colour (outC, outR, outG, outB).
// Written as a plain factory so web workers can be built from its source.
function makeRenderer(CITY, FONT) {
  const { P, ROAD, WALK, NB, W, CS, N, M, NEON, TINTS, B, BM, BP, BC, BS,
    cellStart, cellItems, cellMaxH, texts, plaza, SF_PLATE, SF_FLICKER } = CITY;
  const MAXH = CITY.maxH + 1;
  const MAXD = 480;
  const FB = FONT.bits;

  // ---------- small helpers ----------
  function hash2(a, b) {
    let h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }
  const hash3 = (a, b, c) => hash2((a | 0) + Math.imul(c | 0, 1013904223), b);
  function noise2(x, y) {
    const ix = Math.floor(x), iy = Math.floor(y);
    let fx = x - ix, fy = y - iy;
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
    const a = hash2(ix, iy), b = hash2(ix + 1, iy), c = hash2(ix, iy + 1), d = hash2(ix + 1, iy + 1);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  }
  const C = s => s.charCodeAt(0);
  const RAMP = " .,:;-=+*#%@".split("").map(C);
  const WALLRAMP = ".,:;-=+*#%".split("").map(C);
  const ch = (r, l) => r[Math.max(0, Math.min(r.length - 1, Math.floor(l * r.length)))];

  // lighting constants
  const AMB_R = 0.27, AMB_G = 0.23, AMB_B = 0.38;
  const LMP_R = 1.00, LMP_G = 0.80, LMP_B = 0.58;
  const FOG_R = 34, FOG_G = 14, FOG_B = 52;

  let time = 0;
  let fpkH = 0.01, fpkV = 0.02; // size of one cell per metre of distance
  let rdx = 0, rdy = 0, rdz = 0;  // direction of the ray being shaded
  // current delivery objective (set per frame from cam.goal)
  let goalOn = false, goalX = 0, goalY = 0, goalR = 0, goalG = 0, goalB = 0;
  const BEACON_H = 170;
  let outC = 32, outR = 0, outG = 0, outB = 0, outE = 0;
  function out(c, r, g, b, e) { outC = c; outR = r; outG = g; outB = b; outE = e; }

  // Street-lamp light at a ground/wall position (lamps sit at a = 16,32,48
  // on every street, heads ~5.1 m from the centreline).
  function lampL(x, y) {
    let gx = x % P; if (gx < 0) gx += P;
    let gy = y % P; if (gy < 0) gy += P;
    const arx = Math.abs(gx > 32 ? gx - 64 : gx), ary = Math.abs(gy > 32 ? gy - 64 : gy);
    let L = 0;
    if (ary < 24) {
      let k = Math.round(gx / 16); if (k < 1) k = 1; else if (k > 3) k = 3;
      const a = gx - k * 16, b = ary - 5.1;
      L += 1 / (1 + (a * a + b * b) * 0.03);
    }
    if (arx < 24) {
      let k = Math.round(gy / 16); if (k < 1) k = 1; else if (k > 3) k = 3;
      const a = gy - k * 16, b = arx - 5.1;
      L += 1 / (1 + (a * a + b * b) * 0.03);
    }
    return L;
  }
  // Neon colour spilling from each block's shopfronts onto the streets.
  let spR = 0, spG = 0, spB = 0;
  function spill(x, y, k) {
    const c = NEON[Math.floor(hash2(Math.floor(x / 32), Math.floor(y / 32)) * NEON.length)];
    spR = c[0] / 255 * k; spG = c[1] / 255 * k; spB = c[2] / 255 * k;
  }

  // ---------- dynamic objects (vehicles) ----------
  // Vehicles live in canonical [0,W) coordinates and are binned into the same
  // grid as the static boxes every frame, so rays only test cars in the cells
  // they actually cross.
  const MAXV = CITY.vehicles.length;
  const VU = new Float32Array(MAXV * 6);     // union bounds per vehicle
  const VB = new Float32Array(MAXV * 2 * 6); // 2 part boxes per vehicle (body, cabin)
  const MAXE = MAXV * 12;
  const dynHead = new Int32Array(N * N).fill(-1);
  const entV = new Int32Array(MAXE), entNext = new Int32Array(MAXE);
  const entSX = new Float32Array(MAXE), entSY = new Float32Array(MAXE);
  const touched = new Int32Array(MAXE);
  let nTouched = 0;
  function updateVehicles(t) {
    for (let i = 0; i < nTouched; i++) dynHead[touched[i]] = -1;
    nTouched = 0;
    let ne = 0;
    const vs = CITY.vehicles;
    for (let i = 0; i < vs.length; i++) {
      const v = vs[i];
      let s = (v.phase + v.speed * v.dir * t) % W; if (s < 0) s += W;
      let x, y;
      if (v.axis === 0) { x = s; y = v.street + v.off; } else { x = v.street + v.off; y = s; }
      if (y < 0) y += W; if (x < 0) x += W;
      const fly = v.z > 0;
      const hl = fly ? 2.7 : 2.2, hw = fly ? 1.25 : 0.9;
      const lx = v.axis === 0 ? hl : hw, ly = v.axis === 0 ? hw : hl;
      const z0 = fly ? v.z : 0.3, zb = z0 + (fly ? 1.0 : 0.8), zc = zb + (fly ? 0.6 : 0.55);
      const o = i * 12;
      VB[o] = x - lx; VB[o + 1] = y - ly; VB[o + 2] = z0; VB[o + 3] = x + lx; VB[o + 4] = y + ly; VB[o + 5] = zb;
      const sh = -0.25 * v.dir, cl = 0.5;
      const cx = v.axis === 0 ? x + sh : x, cy = v.axis === 0 ? y : y + sh;
      const clx = v.axis === 0 ? lx * cl : hw * 0.85, cly = v.axis === 0 ? hw * 0.85 : ly * cl;
      VB[o + 6] = cx - clx; VB[o + 7] = cy - cly; VB[o + 8] = zb; VB[o + 9] = cx + clx; VB[o + 10] = cy + cly; VB[o + 11] = zc;
      const u = i * 6;
      VU[u] = x - lx; VU[u + 1] = y - ly; VU[u + 2] = z0; VU[u + 3] = x + lx; VU[u + 4] = y + ly; VU[u + 5] = zc;
      const ix0 = Math.floor(VU[u] / CS), ix1 = Math.floor(VU[u + 3] / CS);
      const iy0 = Math.floor(VU[u + 1] / CS), iy1 = Math.floor(VU[u + 4] / CS);
      for (let iy = iy0; iy <= iy1; iy++) for (let ix = ix0; ix <= ix1; ix++) {
        if (ne >= MAXE) break;
        const wx = ((ix % N) + N) % N, wy = ((iy % N) + N) % N, ci = wy * N + wx;
        if (dynHead[ci] < 0) touched[nTouched++] = ci;
        entV[ne] = i; entSX[ne] = (ix - wx) * CS; entSY[ne] = (iy - wy) * CS;
        entNext[ne] = dynHead[ci]; dynHead[ci] = ne++;
      }
    }
  }

  // ---------- tracing ----------
  // hit kinds: 0 = nothing (sky), 1 = ground, 2 = static box, 3 = vehicle part
  let hT = 0, hKind = 0, hIdx = 0, hAx = 0, hOX = 0, hOY = 0;
  let sAx = 0;
  function slab(A, o, ox, oy, oz, idx, idy, idz) {
    let t1 = (A[o] - ox) * idx, t2 = (A[o + 3] - ox) * idx, tn, tf, ax = 0;
    if (t1 < t2) { tn = t1; tf = t2; } else { tn = t2; tf = t1; }
    t1 = (A[o + 1] - oy) * idy; t2 = (A[o + 4] - oy) * idy;
    if (t1 > t2) { const q = t1; t1 = t2; t2 = q; }
    if (t1 > tn) { tn = t1; ax = 1; }
    if (t2 < tf) tf = t2;
    if (tn > tf) return Infinity;
    t1 = (A[o + 2] - oz) * idz; t2 = (A[o + 5] - oz) * idz;
    if (t1 > t2) { const q = t1; t1 = t2; t2 = q; }
    if (t1 > tn) { tn = t1; ax = 2; }
    if (t2 < tf) tf = t2;
    if (tn > tf || tn < 1e-3) return Infinity;
    sAx = ax;
    return tn;
  }

  function trace(ox, oy, oz, dx, dy, dz, maxT) {
    let best = maxT;
    hKind = 0;
    if (dz < 0) { const tg = -oz / dz; if (tg < best) { best = tg; hKind = 1; } }
    const idx = 1 / dx, idy = 1 / dy, idz = 1 / dz;

    let tStart = 0, tStop = best;
    if (oz > MAXH) {
      if (dz >= 0) { hT = best; return hKind; }
      tStart = (oz - MAXH) / -dz;
    }
    if (dz > 0) { const tt = (MAXH - oz) / dz; if (tt < tStop) tStop = tt; }
    if (tStart < tStop) {
      const px = ox + dx * tStart, py = oy + dy * tStart;
      let cx = Math.floor(px / CS), cy = Math.floor(py / CS);
      const sx = dx > 0 ? 1 : -1, sy = dy > 0 ? 1 : -1;
      const tdx = Math.abs(CS * idx), tdy = Math.abs(CS * idy);
      let tmx = ((cx + (dx > 0 ? 1 : 0)) * CS - ox) * idx;
      let tmy = ((cy + (dy > 0 ? 1 : 0)) * CS - oy) * idy;
      let tEnter = tStart;
      for (let it = 0; it < 700; it++) {
        if (tEnter >= best || tEnter >= tStop) break;
        const tExit = tmx < tmy ? tmx : tmy;
        let wx = cx % N; if (wx < 0) wx += N;
        let wy = cy % N; if (wy < 0) wy += N;
        const ci = wy * N + wx;
        const offx = (cx - wx) * CS, offy = (cy - wy) * CS;
        const rox = ox - offx, roy = oy - offy;
        const te = tExit < best ? tExit : best;
        const zmin = dz < 0 ? oz + dz * te : oz + dz * tEnter;
        if (zmin < cellMaxH[ci]) {
          for (let k = cellStart[ci], e = cellStart[ci + 1]; k < e; k++) {
            const b = cellItems[k];
            const t = slab(B, b * 6, rox, roy, oz, idx, idy, idz);
            if (t < best) { best = t; hKind = 2; hIdx = b; hAx = sAx; hOX = offx; hOY = offy; }
          }
        }
        for (let e = dynHead[ci]; e >= 0; e = entNext[e]) {
          const v = entV[e], vx = rox + entSX[e], vy = roy + entSY[e];
          if (slab(VU, v * 6, vx, vy, oz, idx, idy, idz) >= best) continue;
          for (let p = 0; p < 2; p++) {
            const t = slab(VB, v * 12 + p * 6, vx, vy, oz, idx, idy, idz);
            if (t < best) { best = t; hKind = 3; hIdx = v * 2 + p; hAx = sAx; hOX = offx - entSX[e]; hOY = offy - entSY[e]; }
          }
        }
        if (tmx < tmy) { cx += sx; tEnter = tmx; tmx += tdx; }
        else { cy += sy; tEnter = tmy; tmy += tdy; }
      }
    }
    hT = best;
    return hKind;
  }

  // ---------- materials ----------
  function shadeSign(b, px, py, pz, ax, sg, fp) {
    const o = b * 6;
    const x0 = B[o], y0 = B[o + 1], z0 = B[o + 2], x1 = B[o + 3], y1 = B[o + 4], z1 = B[o + 5];
    const prm = BP[b], text = texts[prm & 0xffff], flags = prm >> 16;
    const col = BC[b];
    let cr = (col >> 16) & 255, cg = (col >> 8) & 255, cb = col & 255;
    const plate = (flags & SF_PLATE) !== 0;
    let on = 1;
    if ((flags & SF_FLICKER) && hash2(BS[b], Math.floor(time * 9)) < 0.18) on = 0.15;
    const thinAx = (x1 - x0) < (y1 - y0) ? 0 : 1;
    // cell footprint projected onto the sign face (grows at grazing angles)
    const dn = Math.max(0.08, Math.abs(thinAx === 0 ? rdx : rdy));
    const fph = fp * fpkH / fpkV / dn;
    fp = fp / Math.max(0.08, Math.sqrt(1 - rdz * rdz));
    if (ax !== thinAx) { // frame / edge of the sign
      out(ax === 2 ? C("=") : C("|"), cr * 0.35, cg * 0.35, cb * 0.35, 0);
      return;
    }
    // text-space coordinates: u left->right as seen by the viewer, v top->bottom
    let u, Wd;
    if (ax === 0) { Wd = y1 - y0; u = sg > 0 ? py - y0 : y1 - py; }
    else { Wd = x1 - x0; u = sg > 0 ? x1 - px : px - x0; }
    const Hd = z1 - z0, v = z1 - pz;
    const L = text.length;
    const vert = Hd > Wd * 1.4 && L > 1;
    let s, ou, ov;
    if (vert) { s = Math.min(Wd / 7, Hd / (L * 8 + 1)); ou = (Wd - 5 * s) / 2; ov = (Hd - (L * 8 - 1) * s) / 2; }
    else { s = Math.min(Wd / (L * 6 + 1), Hd / 9); ou = (Wd - (L * 6 - 1) * s) / 2; ov = (Hd - 7 * s) / 2; }
    const gx = Math.floor((u - ou) / s), gy = Math.floor((v - ov) / s);
    let li, cx, cy;
    if (vert) { li = Math.floor(gy / 8); cy = gy - li * 8; cx = gx; }
    else { li = Math.floor(gx / 6); cx = gx - li * 6; cy = gy; }
    const inLetter = li >= 0 && li < L && cx >= 0 && cx < 5 && cy >= 0 && cy < 7;
    const code = inLetter ? text.charCodeAt(li) : 32;
    // Too far to resolve the 5x7 bitmap: print each letter once, in the cell
    // that covers the letter's centre, so distant signs read as plain text.
    const coarse = fph > s * 0.5;
    let atCentre = false;
    if (coarse && inLetter) {
      const cu = ou + (vert ? 2.5 : li * 6 + 2.5) * s, cv = ov + (vert ? li * 8 + 3.5 : 3.5) * s;
      atCentre = Math.abs(u - cu) <= fph * 0.5 && Math.abs(v - cv) <= fp * 0.5;
    }
    // neon tube border
    const bw = Math.max(s * 0.7, fp * 0.8);
    const border = u < bw || u > Wd - bw || v < bw || v > Hd - bw;
    if (plate) {
      if (inLetter && code !== 32 && (coarse ? atCentre : FB[code * 35 + cy * 5 + cx])) {
        out(code, 235, 240, 235, 1);
      } else out(border ? C("#") : C("="), cr, cg, cb, 0.5);
      return;
    }
    if (inLetter && code !== 32) {
      if (coarse ? atCentre : FB[code * 35 + cy * 5 + cx]) {
        const k = on * (0.85 + 0.15 * Math.sin(time * 3 + BS[b]));
        out(code, Math.min(255, cr * k + 40), Math.min(255, cg * k + 40), Math.min(255, cb * k + 40), 1);
        return;
      }
    }
    if (border) { out(vert ? C("|") : C("="), cr * 0.8 * on, cg * 0.8 * on, cb * 0.8 * on, 1); return; }
    out(C("."), cr * 0.18, cg * 0.18, cb * 0.18, 0.3);
  }

  function shadeBldg(b, px, py, pz, ax, sg, fp) {
    const o = b * 6;
    const x0 = B[o], y0 = B[o + 1], z0 = B[o + 2], x1 = B[o + 3], y1 = B[o + 4], z1 = B[o + 5];
    const prm = BP[b], style = prm & 15, lit = ((prm >> 4) & 255) / 255, tint = TINTS[(prm >> 12) & 15], edgeNeon = (prm >> 16) & 1;
    const seed = BS[b], wc = BC[b];
    const tr = tint[0] * 1.35, tg = tint[1] * 1.35, tb = tint[2] * 1.35;
    if (ax === 2) { // roof
      const e = Math.min(px - x0, x1 - px, py - y0, y1 - py);
      if (e < Math.max(0.5, fp * 0.7)) { out(C("#"), tr * 0.9, tg * 0.9, tb, 0); return; }
      const q = (Math.floor(px * 0.5) + Math.floor(py * 0.5)) & 1;
      out(q ? C(".") : C(":"), tr * 0.6, tg * 0.6, tb * 0.7, 0);
      return;
    }
    const u = ax === 0 ? py : px;
    const dEdge = ax === 0 ? Math.min(py - y0, y1 - py) : Math.min(px - x0, x1 - px);
    const faceK = ax === 0 ? 1.0 : 0.72;
    const lz = pz < 7 ? 1 : 1 / (1 + (pz - 7) * (pz - 7) * 0.02);
    const Lm = lampL(px, py) * lz;
    spill(px, py, pz < 12 ? 0.28 : 0.06);
    const lr = AMB_R * faceK + LMP_R * Lm * 0.8 + spR, lg = AMB_G * faceK + LMP_G * Lm * 0.8 + spG, lb = AMB_B * faceK + LMP_B * Lm * 0.8 + spB;
    const lum = (lr + lg + lb) / 3;

    if (dEdge < Math.max(0.25, fp * 0.6)) {
      if (edgeNeon) { out(C("|"), (wc >> 16) & 255, (wc >> 8) & 255, wc & 255, 1); return; }
      out(C("|"), tr * lr * 1.5, tg * lg * 1.5, tb * lb * 1.5, 0); return;
    }
    if (z1 - pz < 0.5) {
      if (edgeNeon) { out(C("="), (wc >> 16) & 255, (wc >> 8) & 255, wc & 255, 1); return; }
      out(C("="), tr * lr * 1.4, tg * lg * 1.4, tb * lb * 1.4, 0); return;
    }
    const fl = Math.floor(pz / 3.6), fz = pz - fl * 3.6;

    // ground-floor shopfronts
    if (z0 === 0 && pz < 4.0) {
      const shop = Math.floor(u / 8), su = u - shop * 8;
      if (su < 0.6 || pz > 3.55) { out(C("#"), tr * lr, tg * lg, tb * lb, 0); return; }
      if (pz < 0.35) { out(C("_"), tr * lr, tg * lg, tb * lb, 0); return; }
      const h = hash2(seed ^ shop, 71);
      if (su > 5.6 && su < 7.2 && pz < 2.6) { out(su < 5.75 || su > 7.05 ? C("|") : C(" "), tr * lr, tg * lg, tb * lb, 0); return; } // doorway
      if ((su % 1.8) < 0.12) { out(C("|"), tr * lr * 1.2, tg * lg * 1.2, tb * lb * 1.2, 0); return; }        // mullion
      if (h < 0.7) {
        const c = NEON[Math.floor(hash2(seed ^ shop, 13) * NEON.length)];
        const row = Math.floor(pz / 0.45) % 3;
        const k = 0.3 + 0.15 * h;
        out(row === 0 ? C("=") : row === 1 ? C(":") : C("."), c[0] * k + 25, c[1] * k + 25, c[2] * k + 25, 1);
      } else out(C(":"), 28, 32, 48, 0);
      return;
    }

    let win = false, bay = 0, frame = false;
    switch (style) {
      case 0: { bay = Math.floor(u / 2.4); const fu = u - bay * 2.4; win = fu > 0.45 && fu < 1.95 && fz > 0.9 && fz < 2.8; break; }
      case 1: { bay = Math.floor(u / 4.5); win = fz > 0.4; const m = u % 1.5; frame = m < 0.14 && fp < 0.8; break; }
      case 2: { bay = Math.floor(u / 6); win = fz > 1.1 && fz < 2.7; break; }
      default: { bay = Math.floor(u / 1.8); const fu = u - bay * 1.8; win = fu > 0.55 && fu < 1.35 && fz > 1.2 && fz < 2.5; break; }
    }
    if (win && !frame) {
      const hv = hash3(seed, fl, bay);
      if (hv < lit) {
        const h2 = hash3(seed + 1, fl, bay);
        let r, g, bl;
        if (h2 < 0.7) { r = (wc >> 16) & 255; g = (wc >> 8) & 255; bl = wc & 255; }
        else if (h2 < 0.85) { r = 255; g = 200; bl = 130; }
        else { r = 150; g = 220; bl = 255; }
        const k = 0.4 + 0.45 * hash3(seed + 2, fl, bay);
        // up close show blinds / curtains, from afar a solid block
        let c = C("#");
        if (fp < 0.3) c = (Math.floor(fz / 0.28) & 1) ? C("=") : (hash3(seed + 3, fl, bay) < 0.5 ? C("-") : C(":"));
        out(c, r * k, g * k, bl * k, 1);
      } else {
        out(C(":"), 45 + 75 * lr, 52 + 75 * lg, 80 + 85 * lb, 0);
      }
      return;
    }
    if (frame) { out(C("|"), tr * lr * 1.3, tg * lg * 1.3, tb * lb * 1.3, 0); return; }
    // plain wall
    let c = ch(WALLRAMP, lum * 0.9);
    if (style === 3 && ((fl + bay) & 1)) c = C("%");
    out(c, tr * lr * 1.1, tg * lg * 1.1, tb * lb * 1.1, 0);
  }

  function shadeHolo(b, px, py, pz, ax) {
    const o = b * 6;
    const u = ax === 0 ? py - B[o + 1] : px - B[o];
    const col = Math.floor(u / 0.45) + (ax === 0 ? 100 : 0);
    const row = Math.floor(pz / 0.7);
    const sp = 3 + hash2(col, 5) * 7;
    const head = (time * sp + hash2(col, 9) * 80) % 60;
    let d = head - (60 - (row % 60)); if (d < 0) d += 60;
    const glyphs = "01<>/\\|=+*#$%&ZX";
    const g = glyphs.charCodeAt(Math.floor(hash3(col, row, Math.floor(time * 4 + col)) * glyphs.length));
    const c = BC[b], k = d < 1 ? 1.4 : Math.max(0.12, 1 - d / 14);
    out(ax === 2 ? C("#") : g, Math.min(255, ((c >> 16) & 255) * k), Math.min(255, ((c >> 8) & 255) * k), Math.min(255, (c & 255) * k), 1);
  }

  function shadeTLight(b, px, py, pz, ax) {
    if (ax === 2) { out(C("="), 40, 40, 44, 0); return; }
    const o = b * 6;
    const u = ax === 0 ? py - (B[o + 1] + B[o + 4]) / 2 : px - (B[o] + B[o + 3]) / 2;
    const v = pz - B[o + 2], H = B[o + 5] - B[o + 2];
    const slot = Math.floor(v / (H / 3)); // 0 bottom (green), 1 yellow, 2 red
    const sv = v - (slot + 0.5) * H / 3;
    if (u * u + sv * sv > 0.19 * 0.19) { out(C("#"), 28, 30, 30, 0); return; }
    const cyc = (time + 3) % 20;
    let state; // 0 green 1 yellow 2 red
    if (ax === 0) state = cyc < 8 ? 0 : cyc < 10 ? 1 : 2;
    else state = cyc < 10 ? 2 : cyc < 18 ? 0 : 1;
    const cols = [[60, 255, 120], [255, 200, 40], [255, 50, 40]];
    const c = cols[slot];
    if (slot === state) out(C("O"), c[0], c[1], c[2], 1);
    else out(C("o"), c[0] * 0.18, c[1] * 0.18, c[2] * 0.18, 0);
  }

  function shadeStatic(b, px, py, pz, ax, sg, fp) {
    const mat = BM[b];
    switch (mat) {
      case M.BLDG: return shadeBldg(b, px, py, pz, ax, sg, fp);
      case M.SIGN: return shadeSign(b, px, py, pz, ax, sg, fp);
      case M.LAMP: return out(ax === 2 && sg < 0 ? C("@") : C("O"), 255, 235, 190, 1);
      case M.HOLO: return shadeHolo(b, px, py, pz, ax);
      case M.TLIGHT: return shadeTLight(b, px, py, pz, ax);
      case M.GLASS: {
        const q = (Math.floor((px + py) * 3 + pz * 3) & 3) === 0;
        return out(q ? C("/") : C("."), 70, 150, 190, 0.3);
      }
      case M.AD: {
        const c = BC[b];
        if (ax === 2) return out(C("="), 60, 60, 70, 0);
        const band = Math.floor(pz * 3 - time * 2) & 3;
        const k = band === 0 ? 1 : 0.55;
        return out(band === 0 ? C("#") : C("%"), ((c >> 16) & 255) * k, ((c >> 8) & 255) * k, (c & 255) * k, 1);
      }
      case M.VEND: {
        const c = BC[b];
        if (ax === 2) return out(C("="), 70, 70, 80, 0);
        const o = b * 6;
        const facing = (ax === 0 ? B[o + 3] - B[o] : B[o + 4] - B[o + 1]) < 0.9; // thin axis = front/back
        if (!facing) return out(C("#"), ((c >> 16) & 255) * 0.4, ((c >> 8) & 255) * 0.4, (c & 255) * 0.4, 0);
        const u = ax === 0 ? py : px;
        if (pz > 1.45) return out(C("="), (c >> 16) & 255, (c >> 8) & 255, c & 255, 1);
        const q = Math.floor(u / 0.18) & 1;
        const r = Math.floor(pz / 0.3) & 1;
        return out(r ? C("_") : (q ? C("]") : C("[")), 200 + (c >> 16 & 255) * 0.2, 200, 210, 1);
      }
      case M.PIZZERIA: { // red/white striped awning
        const u = ax === 0 ? py : px;
        return (Math.floor(u / 0.45) & 1) ? out(C("#"), 235, 60, 35, 0.7) : out(C("="), 245, 235, 215, 0.7);
      }
      case M.ANTENNA: {
        const o = b * 6;
        if (B[o + 5] - pz < 1.2) {
          const blink = (time + (BS[b] & 7) * 0.3) % 1.5 < 0.6;
          return out(C("*"), blink ? 255 : 90, blink ? 40 : 10, blink ? 40 : 10, 1);
        }
        return out(ax === 2 ? C("-") : C("|"), 110, 110, 125, 0);
      }
      default: {
        // generic props: poles, bins, benches, tanks, AC units, planters, shelter roof
        const Lm = lampL(px, py) * (pz < 8 ? 1 : 0.3);
        const l = 0.45 + Lm * 0.9 * (ax === 0 ? 1 : 0.75);
        let c, r, g, bl;
        switch (mat) {
          case M.POLE: c = ax === 2 ? C("-") : C("|"); r = 110; g = 115; bl = 135; break;
          case M.BENCH: c = C("="); r = 150; g = 105; bl = 75; break;
          case M.BIN: c = ax === 2 ? C("o") : C("#"); r = 70; g = 120; bl = 90; break;
          case M.TANK: c = ax === 2 ? C("o") : ((Math.floor(pz * 2) & 1) ? C("=") : C("H")); r = 120; g = 95; bl = 80; break;
          case M.AC: c = ax === 2 ? C("#") : C("="); r = 95; g = 100; bl = 110; break;
          case M.PLANTER: c = ax === 2 ? C("*") : C("#"); r = ax === 2 ? 60 : 90; g = ax === 2 ? 170 : 90; bl = ax === 2 ? 90 : 100; break;
          case M.ROOF: c = ax === 2 ? C("=") : C("-"); r = 110; g = 110; bl = 130; if (ax === 2 && sg < 0) { c = C("="); r = 220; g = 230; bl = 255; } break;
          default: c = C("#"); r = 120; g = 120; bl = 120;
        }
        return out(c, r * l, g * l, bl * l, 0);
      }
    }
  }

  function shadeVehicle(part, px, py, pz, ax, sg) {
    const vi = part >> 1, cab = part & 1;
    const v = CITY.vehicles[vi];
    const c = v.color, n = v.neon;
    const cr = (c >> 16) & 255, cg = (c >> 8) & 255, cb = c & 255;
    const nr = (n >> 16) & 255, ng = (n >> 8) & 255, nbl = n & 255;
    const fly = v.z > 0;
    const o = vi * 12 + cab * 6;
    const z0 = VB[o + 2];
    if (cab) {
      if (ax === 2) return out(C("="), cr * 0.8, cg * 0.8, cb * 0.8, 0);
      return out(C(":"), 70, 120, 160, 0.3);
    }
    if (ax === 2) {
      if (sg < 0 && fly) return out(C("#"), nr, ng, nbl, 1);
      return out(C("#"), cr * 0.9, cg * 0.9, cb * 0.9, 0);
    }
    if (ax === v.axis) { // front or back
      const front = sg === v.dir;
      const lat = v.axis === 0 ? py - (VB[o + 1] + VB[o + 4]) / 2 : px - (VB[o] + VB[o + 3]) / 2;
      const hz = pz - z0;
      if (Math.abs(lat) > 0.45 && hz > 0.25 && hz < 0.65) {
        return front ? out(C("@"), 255, 250, 225, 1) : out(C("o"), 255, 40, 50, 1);
      }
      return out(C("#"), cr * 0.7, cg * 0.7, cb * 0.7, 0);
    }
    const hz = pz - z0;
    if (fly && hz > 0.4 && hz < 0.6) return out(C("-"), nr, ng, nbl, 1);
    if (!fly && hz < 0.15) return out(C("_"), nr, ng, nbl, 1); // underglow
    const Lm = fly ? 0 : lampL(px, py);
    const l = 0.5 + Lm * 0.8;
    return out(C("="), cr * l, cg * l, cb * l, 0);
  }

  function shadeSky(dx, dy, dz) {
    const el = dz;
    if (el < 0) { out(C("."), FOG_R * 1.4, FOG_G * 1.4, FOG_B * 1.4, 0); return; }
    const haze = Math.exp(-el * 7);
    let r = 6 + (FOG_R * 2.2 - 6) * haze, g = 4 + (FOG_G * 2.0 - 4) * haze, b = 16 + (FOG_B * 2.0 - 16) * haze;
    const az = Math.atan2(dy, dx);
    const h = hash2(Math.floor(az * 240), Math.floor(el * 240));
    let c = 32;
    if (h < haze * 0.5) c = h < haze * 0.12 ? C(":") : C(".");
    if (el > 0.1 && h > 0.993) {
      c = h > 0.998 ? C("*") : C(".");
      const tw = 0.6 + 0.4 * Math.sin(time * 3 + h * 1000);
      r = 200 * tw; g = 200 * tw; b = 255 * tw;
    }
    // moon
    const md = dx * -0.55 + dy * 0.62 + dz * 0.56;
    if (md > 0.9965) {
      const k = hash2(Math.floor(az * 300), Math.floor(el * 300));
      c = k < 0.2 ? C("O") : C("@");
      r = 235; g = 225; b = 250;
    } else if (md > 0.985) {
      if (c === 32) c = C(".");
      r += 40; g += 30; b += 60;
    }
    out(c, r, g, b, 1);
  }

  function shadeGround(px, py, t, fp, dx, dy, dz, fpk, depth) {
    if (goalOn) { // pulsing target ring on the ground around the objective
      let ex = px - goalX; ex -= W * Math.round(ex / W);
      let ey = py - goalY; ey -= W * Math.round(ey / W);
      const d = Math.sqrt(ex * ex + ey * ey);
      if (d < 3.3) {
        const w = Math.max(0.16, fp * 0.6), pulse = (time * 0.8 % 1) * 3;
        if (Math.abs(d - 3) < w) { out(C("O"), goalR, goalG, goalB, 1); return; }
        if (Math.abs(d - pulse) < w * 0.8) { out(C("o"), goalR * 0.8, goalG * 0.8, goalB * 0.8, 1); return; }
      }
    }
    let gx = px % P; if (gx < 0) gx += P;
    let gy = py % P; if (gy < 0) gy += P;
    const rx = gx > 32 ? gx - 64 : gx, ry = gy > 32 ? gy - 64 : gy;
    const arx = Math.abs(rx), ary = Math.abs(ry);
    const Lm = lampL(px, py);
    spill(px, py, 0.14);
    const lr = AMB_R * 0.8 + LMP_R * Lm + spR, lg = AMB_G * 0.8 + LMP_G * Lm + spG, lb = AMB_B * 0.8 + LMP_B * Lm + spB;
    const roadX = ary < ROAD, roadY = arx < ROAD;
    if (roadX || roadY) {
      let c = 0, r = 0, g = 0, b = 0, e = 0;
      const mark = (dInter, dl, along, lat) => {
        if (dInter > 6.4 && dInter < 9.4) { // crosswalk
          if (dl < 5.6 && (Math.floor((lat + 6) / 0.9) & 1) === 0) { c = C("#"); r = 175; g = 175; b = 185; }
        } else if (dl < 0.2) { c = C("="); r = 230; g = 185; b = 40; }
        else if (Math.abs(dl - 3) < 0.1 && (along % 6) < 3) { c = C("-"); r = 170; g = 170; b = 180; }
      };
      if (roadX && !roadY) mark(arx, ary, gx, ry);
      else if (roadY && !roadX) mark(ary, arx, gy, rx);
      if (c) { r *= Math.min(1, 0.35 + lr); g *= Math.min(1, 0.35 + lg); b *= Math.min(1, 0.35 + lb); }
      else {
        const hsh = hash2(Math.floor(px * 1.7), Math.floor(py * 1.7));
        c = hsh < 0.55 ? C(".") : hsh < 0.8 ? C(",") : C("`");
        r = 72 * lr; g = 70 * lg; b = 82 * lb;
      }
      // puddles reflect the city
      if (depth === 0 && noise2(px * 0.11, py * 0.11) > 0.66) {
        const br = r, bg = g, bb = b;
        shade(px, py, 0.001, dx, dy, -dz, fpk, 1);
        const rl = outR + outG + outB;
        const nc = rl > 90 ? outC : C("~");
        out(nc, br * 0.25 + outR * 0.75 + 8, bg * 0.25 + outG * 0.75 + 10, bb * 0.25 + outB * 0.75 + 18, outE * 0.5);
        return;
      }
      out(c, r, g, b, e);
      return;
    }
    if (arx < WALK || ary < WALK) { // sidewalk
      const curb = (ary >= ROAD && ary < ROAD + 0.3) || (arx >= ROAD && arx < ROAD + 0.3);
      if (curb) { out(C("="), 120 * lr, 120 * lg, 135 * lb, 0); return; }
      let c = C(".");
      if (fp < 0.35) {
        const tx = (px % 1.6 + 1.6) % 1.6 < 0.09, ty = (py % 1.6 + 1.6) % 1.6 < 0.09;
        c = tx && ty ? C("+") : tx ? C("|") : ty ? C("-") : (hash2(Math.floor(px * 3), Math.floor(py * 3)) < 0.3 ? C(".") : 32);
      }
      if (c === 32) { out(32, 0, 0, 0, 0); return; }
      out(c, 120 * lr, 116 * lg, 135 * lb, 0);
      return;
    }
    // inside a lot: alleys and plazas
    const bi = ((Math.floor(px / P) % NB) + NB) % NB, bj = ((Math.floor(py / P) % NB) + NB) % NB;
    if (plaza[bi * NB + bj]) {
      const d = Math.hypot(gx - 32, gy - 32);
      const ring = Math.floor(d / 1.5) & 1;
      out(ring ? C(":") : C("."), 110 * lr, 100 * lg, 130 * lb, 0);
      return;
    }
    out(hash2(Math.floor(px * 2), Math.floor(py * 2)) < 0.5 ? C(".") : C(","), 50 * lr, 45 * lg, 60 * lb, 0);
  }

  // Translucent light column over the delivery objective. It is always at
  // least one cell wide so it can be spotted from anywhere, and anything
  // closer than the column (buildings) hides it.
  function beacon(ox, oy, oz, dx, dy, dz, tHit) {
    let ex = goalX - ox; ex -= W * Math.round(ex / W);
    let ey = goalY - oy; ey -= W * Math.round(ey / W);
    const a = dx * dx + dy * dy;
    if (a < 1e-6) return;
    const tc = (ex * dx + ey * dy) / a;
    if (tc <= 0.5 || tc >= tHit) return;
    const qx = ex - dx * tc, qy = ey - dy * tc;
    const r = Math.max(0.8, tc * fpkH * 1.6);  // core: >= ~3 cells wide at any distance
    const d2 = qx * qx + qy * qy;
    if (d2 >= 9 * r * r) return;
    const z = oz + dz * tc;
    if (z < 0 || z > BEACON_H) return;
    if (d2 >= r * r) { // soft halo around the core
      const h = 0.22 * (1 - (Math.sqrt(d2) / r - 1) / 2) * (1 - 0.6 * z / BEACON_H);
      outR = Math.min(255, outR + goalR * h); outG = Math.min(255, outG + goalG * h); outB = Math.min(255, outB + goalB * h);
      return;
    }
    const edge = Math.sqrt(d2) / r;
    const k = ((1 - edge) * 0.6 + 0.3) * (1 - 0.6 * z / BEACON_H);
    outR = Math.min(255, outR * (1 - k * 0.5) + goalR * k);
    outG = Math.min(255, outG * (1 - k * 0.5) + goalG * k);
    outB = Math.min(255, outB * (1 - k * 0.5) + goalB * k);
    if (edge < 0.6 || outC === 32) {
      const ph = ((Math.floor(z * 1.2 - time * 8) % 4) + 4) % 4;
      outC = ph === 0 ? C("!") : ph === 2 ? C(":") : C("|");
    }
    outE = 1;
  }

  function shade(ox, oy, oz, dx, dy, dz, fpk, depth) {
    const kind = trace(ox, oy, oz, dx, dy, dz, MAXD);
    rdx = dx; rdy = dy; rdz = dz;
    if (kind === 0) {
      shadeSky(dx, dy, dz);
      if (goalOn) beacon(ox, oy, oz, dx, dy, dz, MAXD);
      return;
    }
    const t = hT;
    const px = ox + dx * t, py = oy + dy * t, pz = oz + dz * t;
    const fp = t * fpk;
    if (kind === 1) shadeGround(px, py, t, fp, dx, dy, dz, fpk, depth);
    else {
      const ax = hAx;
      const d = ax === 0 ? dx : ax === 1 ? dy : dz;
      const sg = d > 0 ? -1 : 1;
      if (kind === 2) shadeStatic(hIdx, px - hOX, py - hOY, pz, ax, sg, fp);
      else shadeVehicle(hIdx, px - hOX, py - hOY, pz, ax, sg);
    }
    // atmospheric haze; emissive things punch through further
    const f = 1 - Math.exp(-t * (outE > 0.5 ? 1 / 700 : 1 / 340));
    outR = outR * (1 - f) + FOG_R * f;
    outG = outG * (1 - f) + FOG_G * f;
    outB = outB * (1 - f) + FOG_B * f;
    if (goalOn) beacon(ox, oy, oz, dx, dy, dz, t);
  }

  // Render the character grid rows k, k+n, k+2n, ... (interleaved so several
  // workers share the load evenly). cam: {x,y,z,yaw,pitch,fov};
  // buf: Uint8Array of (rendered rows)*cols*4 bytes as (r,g,b,char).
  function render(cam, cols, rows, pxAspect, buf, t, k = 0, n = 1) {
    time = t;
    updateVehicles(t);
    const g = cam.goal;
    goalOn = !!g;
    if (g) { goalX = g.x; goalY = g.y; goalR = g.r; goalG = g.g; goalB = g.b; }
    const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw), cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
    const fx = cp * cy, fy = cp * sy, fz = sp;       // forward
    const rx = sy, ry = -cy, rz = 0;                   // right
    const ux = ry * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - ry * fx; // up = right x forward
    const th = Math.tan(cam.fov / 2);
    const tv = th * (rows * pxAspect) / cols;          // vertical half-extent
    const fpk = 2 * tv / rows;                         // world size of a cell per metre (vertical)
    fpkV = fpk; fpkH = 2 * th / cols;
    for (let j = k, r = 0; j < rows; j += n, r++) {
      const sv = (1 - (j + 0.5) / rows * 2) * tv;
      for (let i = 0; i < cols; i++) {
        const su = ((i + 0.5) / cols * 2 - 1) * th;
        let dx = fx + rx * su + ux * sv, dy = fy + ry * su + uy * sv, dz = fz + rz * su + uz * sv;
        const il = 1 / Math.sqrt(dx * dx + dy * dy + dz * dz);
        dx *= il; dy *= il; dz *= il;
        if (dx > -1e-6 && dx < 1e-6) dx = 1e-6;
        if (dy > -1e-6 && dy < 1e-6) dy = 1e-6;
        if (dz > -1e-6 && dz < 1e-6) dz = 1e-6;
        shade(cam.x, cam.y, cam.z, dx, dy, dz, fpk, 0);
        const o = (r * cols + i) * 4;
        if (outC === 32) { buf[o] = buf[o + 1] = buf[o + 2] = 0; buf[o + 3] = 32; continue; }
        buf[o] = outR > 255 ? 255 : outR;
        buf[o + 1] = outG > 255 ? 255 : outG;
        buf[o + 2] = outB > 255 ? 255 : outB;
        buf[o + 3] = outC;
      }
    }
  }

  // Keep the walker out of solid boxes (circle vs box in the xy-plane).
  function collide(pos, radius, feet, head) {
    for (let pass = 0; pass < 2; pass++) {
      const c0x = Math.floor((pos.x - radius) / CS), c1x = Math.floor((pos.x + radius) / CS);
      const c0y = Math.floor((pos.y - radius) / CS), c1y = Math.floor((pos.y + radius) / CS);
      for (let cy = c0y; cy <= c1y; cy++) for (let cx = c0x; cx <= c1x; cx++) {
        let wx = cx % N; if (wx < 0) wx += N;
        let wy = cy % N; if (wy < 0) wy += N;
        const offx = (cx - wx) * CS, offy = (cy - wy) * CS, ci = wy * N + wx;
        for (let k = cellStart[ci], e = cellStart[ci + 1]; k < e; k++) {
          const o = cellItems[k] * 6;
          if (B[o + 5] < feet + 0.4 || B[o + 2] > head) continue;
          const lx = pos.x - offx, ly = pos.y - offy;
          const qx = Math.max(B[o], Math.min(lx, B[o + 3])), qy = Math.max(B[o + 1], Math.min(ly, B[o + 4]));
          let ddx = lx - qx, ddy = ly - qy;
          const d2 = ddx * ddx + ddy * ddy;
          if (d2 >= radius * radius) continue;
          if (d2 < 1e-8) { // centre inside the box: push out along the shallowest side
            const pl = [lx - B[o], B[o + 3] - lx, ly - B[o + 1], B[o + 4] - ly];
            const m = Math.min(...pl);
            if (m === pl[0]) pos.x -= m + radius; else if (m === pl[1]) pos.x += m + radius;
            else if (m === pl[2]) pos.y -= m + radius; else pos.y += m + radius;
            continue;
          }
          const d = Math.sqrt(d2), push = radius - d;
          pos.x += ddx / d * push; pos.y += ddy / d * push;
        }
      }
    }
  }

  return { render, collide };
}
