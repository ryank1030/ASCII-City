// Headless preview: renders one frame of the city straight to the terminal.
// usage: node tools/preview.js [x y yaw pitch z cols rows]   (NOCOLOR=1 for plain text)
const fs = require("fs"), path = require("path");
// Load the browser scripts as globals (plain eval: a vm context makes Math.* calls very slow).
for (const f of ["font.js", "world.js", "render.js"])
  (0, eval)(fs.readFileSync(path.join(__dirname, "../src", f), "utf8").replace(/^function (make\w+)/m, "globalThis.$1 = function"));
const FONT = makeFont(), CITY = makeCity();
const ctx = { CITY, RENDER: makeRenderer(CITY, FONT) };
const a = process.argv.slice(2).map(Number);
const P = ctx.CITY.P;
const num = (v, d) => (v === undefined || isNaN(v) ? d : v);
const cam = { x: num(a[0], 8 * P + 7.2), y: num(a[1], 8 * P + 12), yaw: num(a[2], Math.PI / 2), pitch: num(a[3], 0.12), z: num(a[4], 1.7), fov: 80 * Math.PI / 180 };
const cols = num(a[5], 160), rows = num(a[6], 48);
const buf = new Uint8Array(cols * rows * 4);
ctx.RENDER.render(cam, cols, rows, 2.0, buf, 12);
const t0 = Date.now();
for (let i = 0; i < 5; i++) ctx.RENDER.render(cam, cols, rows, 2.0, buf, 12);
const ms = (Date.now() - t0) / 5;
const color = !process.env.NOCOLOR;
let s = "";
for (let j = 0; j < rows; j++) {
  for (let i = 0; i < cols; i++) {
    const o = (j * cols + i) * 4;
    const c = String.fromCharCode(buf[o + 3]);
    s += color ? `\x1b[38;2;${buf[o]};${buf[o + 1]};${buf[o + 2]}m${c}` : c;
  }
  s += (color ? "\x1b[0m" : "") + "\n";
}
process.stdout.write(s);
console.log(`boxes=${ctx.CITY.nb} frame=${ms.toFixed(1)}ms for ${cols}x${rows}`);
