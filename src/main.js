"use strict";
// Display, input and the game loop. The ray tracer fills a cols x rows grid of
// (r, g, b, char); WebGL draws each cell's glyph from a font atlas.
(function () {
  const params = new URLSearchParams(location.search);
  const canvas = document.getElementById("screen");
  const hud = document.getElementById("hud");
  const job = document.getElementById("job");
  const toastEl = document.getElementById("toast");
  const start = document.getElementById("start");
  const gl = canvas.getContext("webgl2", { antialias: false, preserveDrawingBuffer: params.has("shot") });
  if (!gl) {
    start.querySelector(".sub").textContent = "WebGL2 is required to run this.";
    return;
  }
  const FONT_STACK = '"DejaVu Sans Mono", "JetBrains Mono", Menlo, Consolas, "Liberation Mono", monospace';
  // The main thread keeps its own copy of the world for collisions, the HUD
  // and as a fallback renderer; workers build identical copies (seeded RNG).
  const FONT = makeFont(), CITY = makeCity(), RENDER = makeRenderer(CITY, FONT);
  let store = null;
  try { store = window.localStorage; } catch (e) { /* blocked: progress just isn't saved */ }
  const delivery = makeDelivery(CITY, params.has("shot") ? null : store);
  const W = CITY.W, P = CITY.P;

  // ---------- GL setup ----------
  const VS = `#version 300 es
  in vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }`;
  const FS = `#version 300 es
  precision highp float;
  uniform sampler2D uData, uFont;
  uniform vec2 uCell, uGrid, uSize;
  uniform float uGlow;
  out vec4 frag;
  void main(){
    vec2 p = vec2(gl_FragCoord.x, uSize.y - gl_FragCoord.y);
    ivec2 cell = ivec2(floor(p / uCell));
    vec4 d = texelFetch(uData, cell, 0);
    int ch = int(d.a * 255.0 + 0.5);
    vec2 lp = p - vec2(cell) * uCell;
    ivec2 ap = ivec2(vec2(float(ch % 16), float(ch / 16)) * uCell + lp);
    float a = texelFetch(uFont, ap, 0).r;
    vec3 col = d.rgb * a;
    if (uGlow > 0.0) {
      vec2 uv = p / uCell / uGrid;
      vec2 px = 1.0 / uGrid;
      vec3 g = vec3(0.0);
      for (int i = 0; i < 8; i++) {
        float ang = float(i) * 0.785398 + 0.39;
        vec2 o = vec2(cos(ang), sin(ang) * 0.55);
        vec3 s1 = texture(uData, uv + o * px * 1.3).rgb;
        vec3 s2 = texture(uData, uv + o * px * 3.2).rgb;
        g += s1 * s1 * 0.6 + s2 * s2 * 0.3;
      }
      col += g * uGlow / 8.0;
    }
    vec2 q = gl_FragCoord.xy / uSize - 0.5;
    col *= 1.0 - dot(q, q) * 0.55;
    frag = vec4(col, 1.0);
  }`;
  function sh(type, src) {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  gl.useProgram(prog);
  const vb = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vb);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "p");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const U = n => gl.getUniformLocation(prog, n);
  const uData = U("uData"), uFont = U("uFont"), uCell = U("uCell"), uGrid = U("uGrid"), uSize = U("uSize"), uGlow = U("uGlow");
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  const texData = gl.createTexture(), texFont = gl.createTexture();

  // ---------- sizing ----------
  let fontPx = +params.get("fs") || Math.max(9, Math.min(20, Math.round(innerWidth / 150)));
  let cols = 0, rows = 0, cw = 0, chh = 0, buf = null;
  function layout() {
    const dpr = window.devicePixelRatio || 1;
    const fsd = Math.round(fontPx * dpr);
    const c2 = document.createElement("canvas").getContext("2d");
    c2.font = `${fsd}px ${FONT_STACK}`;
    cw = Math.ceil(c2.measureText("M").width);
    chh = Math.ceil(fsd * 1.18);
    // font atlas: 16 x 8 cells, white glyphs on black
    const at = document.createElement("canvas");
    at.width = cw * 16; at.height = chh * 8;
    const ac = at.getContext("2d");
    ac.fillStyle = "#000"; ac.fillRect(0, 0, at.width, at.height);
    ac.font = `${fsd}px ${FONT_STACK}`;
    ac.textAlign = "center"; ac.textBaseline = "middle"; ac.fillStyle = "#fff";
    for (let c = 33; c < 127; c++) ac.fillText(String.fromCharCode(c), (c % 16 + 0.5) * cw, (Math.floor(c / 16) + 0.5) * chh + fsd * 0.04);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, texFont);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, at);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    cols = Math.max(20, Math.floor(innerWidth * dpr / cw));
    rows = Math.max(10, Math.floor(innerHeight * dpr / chh));
    canvas.width = cols * cw; canvas.height = rows * chh;
    canvas.style.width = (cols * cw / dpr) + "px";
    canvas.style.height = (rows * chh / dpr) + "px";
    buf = new Uint8Array(cols * rows * 4);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texData);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, cols, rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform1i(uData, 0); gl.uniform1i(uFont, 1);
    gl.uniform2f(uCell, cw, chh); gl.uniform2f(uGrid, cols, rows); gl.uniform2f(uSize, canvas.width, canvas.height);
    initRain();
    gen++;
    pending = 0;
  }

  // ---------- rain (screen-space streaks) ----------
  let rainOn = params.get("rain") !== "0";
  let drops = [];
  function initRain() {
    drops = [];
    const n = Math.floor(cols * rows / 70);
    for (let i = 0; i < n; i++) drops.push({ x: Math.random() * cols, y: Math.random() * rows, v: 30 + Math.random() * 35, len: 1 + Math.floor(Math.random() * 3) });
  }
  function drawRain(dt, lookDX) {
    for (const d of drops) {
      d.y += d.v * dt;
      d.x -= lookDX * 0.6;
      if (d.y > rows + 3) { d.y = -Math.random() * rows * 0.3; d.x = Math.random() * cols; }
      if (d.x < 0) d.x += cols; else if (d.x >= cols) d.x -= cols;
      const cx = Math.floor(d.x);
      for (let k = 0; k < d.len; k++) {
        const cy = Math.floor(d.y) - k;
        if (cy < 0 || cy >= rows) continue;
        const o = (cy * cols + cx) * 4;
        const f = 1 - k / (d.len + 1);
        buf[o] = Math.max(buf[o] * 0.6, 95 * f); buf[o + 1] = Math.max(buf[o + 1] * 0.6, 115 * f); buf[o + 2] = Math.max(buf[o + 2] * 0.6, 175 * f);
        buf[o + 3] = k === 0 ? 124 : 39; // '|' head, "'" tail
      }
    }
  }

  // ---------- camera / input ----------
  const cam = {
    x: +params.get("x") || 8 * P + 7.2,
    y: +params.get("y") || 8 * P + 12,
    z: +params.get("z") || 1.7,
    yaw: params.has("yaw") ? +params.get("yaw") : Math.PI / 2,
    pitch: params.has("pitch") ? +params.get("pitch") : 0.12,
    fov: 80 * Math.PI / 180,
  };
  let fly = cam.z > 3, glow = params.get("glow") !== "0", hudOn = true;
  let bob = 0, groundZ = 1.7;
  const keys = new Set();
  let mouseDX = 0, mouseDY = 0;
  addEventListener("keydown", e => {
    keys.add(e.code);
    if (e.code === "KeyF") {
      if (delivery.carrying() && !fly) toast({ text: "CAN'T FLY", sub: "not with a hot pizza - walk it there!" });
      else fly = !fly;
    }
    else if (e.code === "KeyR") rainOn = !rainOn;
    else if (e.code === "KeyG") glow = !glow;
    else if (e.code === "KeyH") { hudOn = !hudOn; hud.classList.toggle("hidden", !hudOn); job.classList.toggle("hidden", !hudOn); }
    else if (e.code === "BracketLeft") { fontPx = Math.max(6, fontPx - 1); layout(); }
    else if (e.code === "BracketRight") { fontPx = Math.min(32, fontPx + 1); layout(); }
    if (e.code.startsWith("Arrow") || e.code === "Space") e.preventDefault();
  });
  addEventListener("keyup", e => keys.delete(e.code));
  addEventListener("blur", () => keys.clear());
  addEventListener("resize", () => layout());
  start.addEventListener("click", () => {
    start.classList.add("hidden");
    if (canvas.requestPointerLock) canvas.requestPointerLock();
  });
  canvas.addEventListener("click", () => { if (document.pointerLockElement !== canvas && canvas.requestPointerLock) canvas.requestPointerLock(); });
  addEventListener("mousemove", e => {
    if (document.pointerLockElement === canvas) { mouseDX += e.movementX; mouseDY += e.movementY; }
  });

  function update(dt) {
    const sens = 0.0022;
    let dyaw = -mouseDX * sens;
    cam.pitch -= mouseDY * sens;
    mouseDX = mouseDY = 0;
    const turn = 1.9 * dt;
    if (keys.has("ArrowLeft")) dyaw += turn;
    if (keys.has("ArrowRight")) dyaw -= turn;
    if (keys.has("ArrowUp")) cam.pitch += turn * 0.7;
    if (keys.has("ArrowDown")) cam.pitch -= turn * 0.7;
    cam.yaw += dyaw;
    cam.pitch = Math.max(-1.45, Math.min(1.45, cam.pitch));

    let f = 0, s = 0;
    if (keys.has("KeyW")) f += 1;
    if (keys.has("KeyS")) f -= 1;
    if (keys.has("KeyD")) s += 1;
    if (keys.has("KeyA")) s -= 1;
    const run = keys.has("ShiftLeft") || keys.has("ShiftRight");
    const speed = fly ? (run ? 90 : 35) : (run ? 16 : 6.5);
    const len = Math.hypot(f, s) || 1;
    const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw);
    let mx = (cy * f + sy * s) / len * speed * dt, my = (sy * f - cy * s) / len * speed * dt;
    if (fly) {
      // in fly mode W/S follow the view direction, including pitch
      mx *= Math.cos(cam.pitch); my *= Math.cos(cam.pitch);
      cam.z += Math.sin(cam.pitch) * f / len * speed * dt;
      if (keys.has("Space")) cam.z += speed * 0.7 * dt;
      if (keys.has("KeyC")) cam.z -= speed * 0.7 * dt;
      cam.z = Math.max(1.7, Math.min(400, cam.z));
    }
    cam.x += mx; cam.y += my;
    const moving = f !== 0 || s !== 0;
    if (!fly) {
      // settle back to street level after flying
      if (cam.z > groundZ + 0.05) cam.z = Math.max(groundZ, cam.z - Math.max(8, (cam.z - groundZ) * 2.5) * dt);
      bob = moving ? bob + dt * (run ? 13 : 9) : bob * 0.9;
      RENDER.collide(cam, 0.35, cam.z - 1.7, cam.z + 0.2);
    }
    cam.x = ((cam.x % W) + W) % W; cam.y = ((cam.y % W) + W) % W;
    return dyaw;
  }

  // ---------- worker pool ----------
  // Each worker renders every n-th row; built from the factory functions'
  // source so it also works when the page is opened straight from disk.
  const pool = [];
  let gen = 0, pending = 0, dispatchT = 0;
  function makePool() {
    const want = params.has("shot") ? 0 : +(params.get("workers") ?? Math.min(8, Math.max(1, (navigator.hardwareConcurrency || 4) - 1)));
    if (!want || typeof Worker === "undefined") return;
    const src = [makeFont, makeCity, makeRenderer].map(f => f.toString()).join("\n") + `
const FONT = makeFont(), CITY = makeCity(), RENDER = makeRenderer(CITY, FONT);
onmessage = e => {
  const m = e.data;
  const need = Math.ceil((m.rows - m.k) / m.n) * m.cols * 4;
  const buf = m.buf && m.buf.length === need ? m.buf : new Uint8Array(need);
  RENDER.render(m.cam, m.cols, m.rows, m.pxAspect, buf, m.t, m.k, m.n);
  postMessage({ gen: m.gen, k: m.k, buf }, [buf.buffer]);
};`;
    try {
      const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
      for (let i = 0; i < want; i++) {
        const w = new Worker(url);
        w.onmessage = onWorker;
        w.onerror = () => { pool.length = 0; pending = 0; }; // fall back to the main thread
        pool.push({ w, buf: null });
      }
    } catch (e) { pool.length = 0; }
  }
  function dispatch(eye) {
    gen++;
    pending = pool.length;
    dispatchT = performance.now();
    const pxAspect = chh / cw, n = pool.length;
    for (let k = 0; k < n; k++) {
      const p = pool[k];
      p.w.postMessage({ gen, cam: eye, cols, rows, pxAspect, t: simT, k, n, buf: p.buf }, p.buf ? [p.buf.buffer] : []);
      p.buf = null;
    }
  }
  function onWorker(e) {
    const m = e.data, p = pool[m.k];
    if (!p) return;
    p.buf = m.buf;
    if (m.gen !== gen || m.buf.length < cols * 4) return; // stale (e.g. after a resize)
    const n = pool.length, rb = cols * 4;
    for (let j = m.k, r = 0; j < rows; j += n, r++) buf.set(m.buf.subarray(r * rb, (r + 1) * rb), j * rb);
    if (--pending === 0) {
      renderMs = renderMs * 0.9 + (performance.now() - dispatchT) * 0.1;
      present();
    }
  }

  // ---------- loop ----------
  let last = performance.now(), fpsAcc = 0, fpsN = 0, fps = 0, hudT = 0, simT = +params.get("t") || 0;
  let renderMs = 0, rainDt = 0, rainYaw = 0;
  function locationName() {
    const ai = Math.round(cam.x / P), sj = Math.round(cam.y / P);
    const nearAve = Math.abs(cam.x - ai * P) < CITY.WALK, nearSt = Math.abs(cam.y - sj * P) < CITY.WALK;
    if (nearAve && nearSt) return `${CITY.aveName(ai)} & ${CITY.stName(sj)}`;
    if (nearAve) return `${CITY.aveName(ai)}  (${CITY.stName(Math.floor(cam.y / P))} - ${CITY.stName(Math.floor(cam.y / P) + 1)})`;
    if (nearSt) return `${CITY.stName(sj)}  (${CITY.aveName(Math.floor(cam.x / P))} - ${CITY.aveName(Math.floor(cam.x / P) + 1)})`;
    return `${CITY.aveName(Math.floor(cam.x / P))} / ${CITY.stName(Math.floor(cam.y / P))} block`;
  }
  function present() {
    if (rainOn) drawRain(rainDt, rainYaw * cols / cam.fov);
    rainDt = 0; rainYaw = 0;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texData);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, cols, rows, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    gl.uniform1f(uGlow, glow ? 1.1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    fpsN++;
  }
  // ---------- delivery toasts ----------
  const toasts = [];
  let toastT = 0;
  function toast(ev) { toasts.push(ev); }
  function updateToast(dt) {
    toastT -= dt;
    if (toastT > 0) return;
    if (!toasts.length) { toastEl.classList.remove("show"); return; }
    const ev = toasts.shift();
    toastEl.className = "show " + (ev.type || "");
    toastEl.innerHTML = `<div class="big">${ev.text}</div><div class="small">${ev.sub || ""}</div>`;
    toastT = 2.6;
  }
  let jobT = 0;

  function frame(now) {
    const dt = Math.max(0, Math.min(0.1, (now - last) / 1000));
    last = now;
    simT += dt;
    rainDt += dt;
    rainYaw += update(dt);
    for (const ev of delivery.update(cam, dt)) {
      toast(ev);
      if (ev.type === "pickup" && fly) fly = false; // walk the pizza there
    }
    updateToast(dt);
    jobT -= dt;
    if (hudOn && jobT <= 0) { jobT = 0.08; job.innerHTML = delivery.hudHTML(cam); }
    const eye = { x: cam.x, y: cam.y, z: cam.z + (fly ? 0 : Math.sin(bob) * 0.045), yaw: cam.yaw, pitch: cam.pitch, fov: cam.fov, goal: delivery.goal() };
    if (pool.length) {
      if (pending === 0) dispatch(eye);
    } else {
      const t0 = performance.now();
      RENDER.render(eye, cols, rows, chh / cw, buf, simT);
      renderMs = renderMs * 0.9 + (performance.now() - t0) * 0.1;
      present();
    }

    fpsAcc += dt;
    if (fpsAcc > 0.5) { fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0; }
    hudT -= dt;
    if (hudOn && hudT <= 0) {
      hudT = 0.25;
      hud.innerHTML = `<span class="loc">${locationName()}</span>\n` +
        `${fly ? "FLY" : "WALK"}  alt ${cam.z.toFixed(0)}m  ${cols}x${rows}  ${fps.toFixed(0)} fps  ` +
        `(${renderMs.toFixed(1)} ms/frame, ${pool.length || 1} thread${pool.length > 1 ? "s" : ""})`;
    }
    if (params.has("shot")) {
      // Test hook: time a few extra frames, then expose the canvas as a data URL.
      const tb = performance.now(), n = 6;
      for (let i = 0; i < n; i++) RENDER.render(eye, cols, rows, chh / cw, buf, simT);
      document.title = `READY ${((performance.now() - tb) / n).toFixed(1)}ms ${cols}x${rows}`;
      const pre = document.createElement("pre");
      pre.id = "shotdata";
      pre.textContent = canvas.toDataURL("image/png");
      document.body.appendChild(pre);
      return;
    }
    requestAnimationFrame(frame);
  }
  layout();
  makePool();
  if (params.has("shot")) start.classList.add("hidden");
  requestAnimationFrame(frame);
})();
