# ASCII Downtown

Walk around an endless cyberpunk downtown rendered entirely in ASCII characters.

Every frame is ray traced on the CPU: one 3D ray per character cell. Each ray hits
buildings, neon signs, street lamps, bus stops, traffic lights, cars or flying cars,
and comes back as a single coloured ASCII glyph. WebGL only draws those glyphs,
plus a soft neon glow.

## Run

Open `index.html` in a browser (Chrome, Firefox or another WebGL2 browser):

```sh
xdg-open index.html
```

or serve it, e.g. `python3 -m http.server` and open http://localhost:8000.

Click the title screen to enter. The mouse is captured for looking around.

## Controls

| Key | Action |
| --- | --- |
| `W A S D` | walk |
| mouse | look around |
| `Shift` | run |
| arrow keys | look without a mouse |
| `F` | toggle fly mode (`Space` up, `C` down) |
| `R` | rain on/off |
| `G` | neon glow on/off |
| `[` / `]` | smaller / larger text (more / fewer characters = detail vs speed) |
| `H` | hide HUD |
| `Esc` | release the mouse |

## Pizza delivery

There's always an order waiting:

1. **Pick up.** An orange light beacon marks the nearest pizzeria; look for the striped awning and big PIZZA signs. Walk into the pulsing ring at its door.
2. **Deliver.** A cyan beacon marks the customer's street address (e.g. `429 ONYX AV`), somewhere 180 to 650 m away. The street-name plates on every corner help you navigate.
3. **Get paid.** Every delivery pays a fare based on distance. Arrive before the timer runs out to earn a tip: the faster you are, the bigger the tip. Late deliveries still pay the fare.

The panel in the top right shows the order, a compass (`@` marks the target; `<<` / `>>` means turn around), the distance, the time left, and your cash and delivery count.

- You can't fly while carrying a pizza. Flying is fine for scouting between orders.
- Progress (cash, deliveries, best tip) is saved in your browser.

## What's in the city

- 16×16 blocks of procedurally generated streets that wrap around, so the city never ends
- Towers with podiums, setbacks and crowns up to ~250 m; lit and dark windows in four facade styles; shopfronts
- Neon storefront signs, vertical blade signs, wall billboards and rooftop billboards with large bitmap lettering (distant signs switch to plain letters)
- Roads with lane markings, crosswalks and puddles that reflect the neon
- Street lamps, bus stops (shelter, bench, ad panel, BUS sign), vending machines, bins,
  traffic lights that cycle, and green street-name plates at every corner
- Moving car traffic and flying cars in the skyline corridors
- Holographic "data rain" pillars in plazas, antennas with blinking beacons, water tanks
- Night sky with moon and stars, purple haze, and screen-space rain

## Code

| File | Purpose |
| --- | --- |
| `src/world.js` | procedural city: every object is an axis-aligned box bucketed into a wrapping 4 m grid |
| `src/render.js` | ray/grid DDA tracer and per-material ASCII shading |
| `src/font.js` | 5×7 bitmap font for sign lettering |
| `src/delivery.js` | pizza delivery jobs: orders, timer, pay/tips, compass HUD |
| `src/main.js` | WebGL glyph display, input, collision, worker pool, HUD |
| `tools/preview.js` | renders a frame straight into your terminal: `node tools/preview.js` |

Rendering is split across Web Workers (interleaved rows), one per spare CPU thread.
Add `?workers=N` to the URL to override the count, or `?workers=0` to render on the main thread.
