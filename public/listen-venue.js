// The venue: an optional, opt-in *view* of a listening room.
//
// The default listener page is the functional one — the sleeve, the transport
// state and the running order. This module is the other half of the idea: the
// same room seen as a place, with the people in it, a projector, a DJ booth and
// the record on the wall. It exists because "listen together" is a social idea
// and a list of rows does not communicate a room full of people.
//
// Four rules keep it honest rather than decorative:
//
//   1. It is a view, never a second player. It does not touch the audio element,
//      does not issue commands, and reads exactly the snapshot the player view
//      already has. Switching views cannot change what anyone hears.
//   2. The crowd is the room's real count, and only the host is named. Guests
//      have no identity by design (see docs/rooms.md), so anonymous listeners
//      are anonymous figures — the count is honest, the faces are not invented.
//      Above a cap the room says "+N more" rather than faking a stadium.
//   3. Speech bubbles are *status*, never chat. There is deliberately no chat in
//      sonora (docs/rooms.md), so a bubble only ever says something the room
//      already knows: who is hosting, how many are in it, whether this device is
//      in sync, what is next. Nothing is attributed to a person who did not say
//      it.
//   4. It is loaded lazily. A guest who never switches pays nothing for it; the
//      module is imported the first time the toggle is used.
//
// The signature: the room is lit by the record. The dominant hue of the current
// artwork drives the projector glow, the string lights and the floor pool, and
// the posters on the wall are the sleeves of the records in this room's queue —
// so two rooms playing different music do not look the same, and the room
// changes when the track does. A guest can override the light and the room
// style, and that choice is remembered: it is their room to come back to.

const STORE_KEY = 'sonora.listen.venue';

/** Room styles. `people` is the minimum scene density, not the room's count. */
export const THEMES = [
  { id: 'club', label: 'Club', people: 12 },
  { id: 'concert', label: 'Concert', people: 16 },
  { id: 'room', label: 'Living room', people: 7 },
];

const MAX_PEOPLE = 18;

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

/** Stable pseudo-randomness: a repaint must not reshuffle the crowd. */
const noise = (i, salt) => {
  const x = Math.sin((i + 1) * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
};

function readSaved() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeSaved(next) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(next)); } catch { /* private mode */ }
}

// ── the room is lit by the record ───────────────────────────────────────
// One small canvas, one 32x18 downscale, and the most *saturated* colour wins:
// averaging every pixel of a sleeve gives mud, while the loudest colour is what
// a lighting designer would actually pick out of it. Cached per artwork URL, so
// a track that comes back does not re-sample.
const hueCache = new Map();

function dominantHue(url) {
  if (!url) return Promise.resolve(null);
  if (hueCache.has(url)) return hueCache.get(url);
  const promise = new Promise((resolve) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 32;
        canvas.height = 18;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, 32, 18);
        const { data } = ctx.getImageData(0, 0, 32, 18);
        let best = null;
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i] / 255;
          const g = data[i + 1] / 255;
          const b = data[i + 2] / 255;
          const max = Math.max(r, g, b);
          const min = Math.min(r, g, b);
          const light = (max + min) / 2;
          const sat = max === min ? 0 : (max - min) / (1 - Math.abs(2 * light - 1));
          // Skip near-black and near-white: they are the sleeve's background,
          // not its colour.
          if (light < 0.12 || light > 0.92 || sat < 0.22) continue;
          let hue;
          if (max === r) hue = ((g - b) / (max - min)) % 6;
          else if (max === g) hue = (b - r) / (max - min) + 2;
          else hue = (r - g) / (max - min) + 4;
          hue *= 60;
          if (hue < 0) hue += 360;
          const weight = sat * (0.35 + light);
          if (!best || weight > best.weight) best = { hue, weight };
        }
        resolve(best ? Math.round(best.hue) : null);
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
  hueCache.set(url, promise);
  return promise;
}

// ── the illustrated room ───────────────────────────────────────────────
// One SVG, one viewBox, one perspective: a brick back wall hung with framed
// sleeves, a wood floor, a projector screen, a DJ booth, two sofas, a rug, a
// plant and string lights. Drawn rather than photographed so it can be lit by
// the current record and re-decorated by the queue without shipping assets.
const ROOM_SVG = `
<svg class="v-art-svg" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
  <defs>
    <pattern id="v-brick" width="128" height="64" patternUnits="userSpaceOnUse">
      <rect width="128" height="64" fill="#2a1c1a"/>
      <rect x="1" y="1" width="62" height="29" rx="3" fill="#3b2724"/>
      <rect x="65" y="1" width="62" height="29" rx="3" fill="#352320"/>
      <rect x="-31" y="33" width="62" height="29" rx="3" fill="#352320"/>
      <rect x="33" y="33" width="62" height="29" rx="3" fill="#3b2724"/>
      <rect x="97" y="33" width="62" height="29" rx="3" fill="#33221f"/>
    </pattern>
    <linearGradient id="v-floor" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#33231b"/>
      <stop offset="1" stop-color="#140e0b"/>
    </linearGradient>
    <linearGradient id="v-ceiling" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#0c0a09"/>
      <stop offset="1" stop-color="#1c1512"/>
    </linearGradient>
    <radialGradient id="v-bulb" cx="50%" cy="50%" r="50%">
      <stop offset="0" stop-color="#ffe6b8" stop-opacity=".95"/>
      <stop offset="40%" stop-color="#ffc978" stop-opacity=".5"/>
      <stop offset="100%" stop-color="#ffb347" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="v-sofa" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#8a5a41"/>
      <stop offset="1" stop-color="#4a2b21"/>
    </linearGradient>
    <linearGradient id="v-sofa-2" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#4c5a70"/>
      <stop offset="1" stop-color="#242b37"/>
    </linearGradient>
    <linearGradient id="v-wood" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#7a5137"/>
      <stop offset="1" stop-color="#3a2418"/>
    </linearGradient>
    <linearGradient id="v-screen-scrim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#040508" stop-opacity="0"/>
      <stop offset=".55" stop-color="#040508" stop-opacity=".35"/>
      <stop offset="1" stop-color="#040508" stop-opacity=".9"/>
    </linearGradient>
    <clipPath id="v-screen-clip"><rect x="914" y="104" width="572" height="312" rx="8"/></clipPath>
  </defs>

  <!-- ceiling, brick wall, wainscot -->
  <rect x="0" y="0" width="1600" height="112" fill="url(#v-ceiling)"/>
  <rect x="0" y="104" width="1600" height="470" fill="url(#v-brick)"/>
  <rect x="0" y="104" width="1600" height="14" fill="#0f0b09" opacity=".85"/>
  <rect x="0" y="560" width="1600" height="66" fill="#241713"/>
  <rect x="0" y="560" width="1600" height="4" fill="#462e23"/>
  <rect x="0" y="622" width="1600" height="4" fill="#0d0908"/>

  <!-- floor boards -->
  <polygon points="0,624 1600,624 1600,1000 0,1000" fill="url(#v-floor)"/>
  <g stroke="#000" stroke-opacity=".3" stroke-width="2">
    <line x1="0" y1="624" x2="0" y2="1000"/><line x1="130" y1="624" x2="30" y2="1000"/>
    <line x1="270" y1="624" x2="160" y2="1000"/><line x1="410" y1="624" x2="290" y2="1000"/>
    <line x1="550" y1="624" x2="420" y2="1000"/><line x1="690" y1="624" x2="550" y2="1000"/>
    <line x1="830" y1="624" x2="680" y2="1000"/><line x1="970" y1="624" x2="810" y2="1000"/>
    <line x1="1110" y1="624" x2="940" y2="1000"/><line x1="1250" y1="624" x2="1070" y2="1000"/>
    <line x1="1390" y1="624" x2="1200" y2="1000"/><line x1="1530" y1="624" x2="1330" y2="1000"/>
    <line x1="1600" y1="624" x2="1460" y2="1000"/>
  </g>
  <g stroke="#000" stroke-opacity=".18" stroke-width="1.5">
    <line x1="0" y1="672" x2="1600" y2="672"/><line x1="0" y1="736" x2="1600" y2="736"/>
    <line x1="0" y1="820" x2="1600" y2="820"/><line x1="0" y1="928" x2="1600" y2="928"/>
  </g>

  <!-- framed sleeves: filled from the queue at runtime -->
  <g class="v-poster-frames"></g>

  <!-- projector screen (the artwork, its caption and progress are SVG so they
       scale with the room instead of drifting out of frame) -->
  <g class="v-screen-group">
    <rect x="898" y="88" width="604" height="344" rx="12" fill="#0b0c10" stroke="#2b2f36" stroke-width="3"/>
    <rect x="914" y="104" width="572" height="312" rx="8" fill="#06070a"/>
    <g clip-path="url(#v-screen-clip)">
      <image class="v-screen-art" x="914" y="104" width="572" height="312" preserveAspectRatio="xMidYMid slice"/>
      <rect x="914" y="250" width="572" height="166" fill="url(#v-screen-scrim)"/>
      <text class="v-screen-title" x="934" y="330">Waiting for music</text>
      <text class="v-screen-sub" x="934" y="352"></text>
      <rect x="934" y="368" width="532" height="5" rx="2.5" fill="rgba(255,255,255,.28)"/>
      <rect class="v-screen-fill" x="934" y="368" width="0" height="5" rx="2.5"/>
      <text class="v-screen-elapsed" x="934" y="394">0:00</text>
      <text class="v-screen-total" x="1466" y="394" text-anchor="end">–:––</text>
    </g>
    <rect class="v-screen-glow" x="914" y="104" width="572" height="312" rx="8" fill="none" stroke-width="2"/>
  </g>
  <!-- projector body -->
  <g opacity=".92">
    <rect x="1130" y="36" width="140" height="36" rx="9" fill="#191b20" stroke="#2b2f36"/>
    <circle cx="1256" cy="54" r="10" fill="#0d0e12" stroke="#3a3f48"/>
    <rect x="1180" y="72" width="40" height="16" fill="#14161b"/>
  </g>

  <!-- neon on the right-hand wall -->
  <g class="v-neon">
        <path class="v-neon-halo" d="M1330 492 h30 M1376 472 v40 M1420 492 h30" stroke-width="16" stroke-linecap="round" fill="none"/>
    <path class="v-neon-line" d="M1330 492 h30 M1376 472 v40 M1420 492 h30" stroke-width="6" stroke-linecap="round" fill="none"/>
  </g>

  <!-- string lights -->
  <g class="v-string">
    <path d="M0,118 C 240,54 480,146 760,80 S 1290,140 1600,68" fill="none" stroke="#120d0a" stroke-width="3"/>
    <g class="v-bulbs"></g>
  </g>

  <!-- rug -->
  <ellipse cx="870" cy="884" rx="540" ry="146" fill="#3a2b3a" opacity=".5"/>
  <ellipse cx="870" cy="884" rx="484" ry="122" fill="#2b2030" opacity=".62"/>
  <ellipse cx="870" cy="884" rx="540" ry="146" fill="none" stroke="#4d3c50" stroke-width="3" opacity=".7"/>

  <!-- the host, behind the booth -->
  <g class="v-people-back" id="listen-venue-back"></g>

  <!-- DJ booth -->
  <g>
    <rect x="60" y="600" width="330" height="30" rx="8" fill="#2b1f1a"/>
    <rect x="72" y="628" width="306" height="164" rx="10" fill="url(#v-wood)"/>
    <rect x="72" y="628" width="306" height="10" fill="#a5734c" opacity=".5"/>
    <g>
      <circle cx="146" cy="600" r="50" fill="#14151a" stroke="#3d414a" stroke-width="3"/>
      <circle cx="146" cy="600" r="17" fill="#71757f"/>
      <circle cx="146" cy="600" r="5" fill="#2b2e36"/>
      <circle cx="304" cy="600" r="50" fill="#14151a" stroke="#3d414a" stroke-width="3"/>
      <circle cx="304" cy="600" r="17" fill="#71757f"/>
      <circle cx="304" cy="600" r="5" fill="#2b2e36"/>
      <rect x="214" y="568" width="44" height="62" rx="6" fill="#1b1d22" stroke="#3d414a" stroke-width="2"/>
      <circle class="v-led" cx="226" cy="584" r="4.5"/>
      <circle cx="248" cy="584" r="4.5" fill="#6d717d"/>
      <rect x="222" y="600" width="28" height="18" rx="3" fill="#0d0e12"/>
    </g>
    <rect x="86" y="654" width="74" height="20" rx="4" fill="#120d0b" opacity=".55"/>
  </g>

  <!-- Furniture comes in two passes. The backs and bases are drawn before the
       crowd so a figure stands *behind* them; the seat cushions are drawn after
       the crowd so a seated figure's legs disappear into the cushion. That is
       the whole difference between "someone is sitting on the sofa" and "someone
       is standing in front of it", and it costs one extra group. -->
  <g class="v-furniture-back">
    <!-- armchair -->
    <rect x="252" y="668" width="184" height="64" rx="18" fill="#6f4c63"/>
    <rect x="252" y="712" width="184" height="96" rx="20" fill="#5c3f52"/>
    <rect x="238" y="700" width="26" height="86" rx="12" fill="#654459"/>
    <rect x="424" y="700" width="26" height="86" rx="12" fill="#654459"/>

    <!-- sofa, left of centre -->
    <rect x="470" y="650" width="390" height="76" rx="20" fill="#96624a"/>
    <rect x="470" y="700" width="390" height="104" rx="22" fill="url(#v-sofa)"/>
    <rect x="452" y="690" width="28" height="112" rx="13" fill="#8a5740"/>
    <rect x="850" y="690" width="28" height="112" rx="13" fill="#8a5740"/>

    <!-- sofa, right -->
    <rect x="1010" y="672" width="400" height="72" rx="20" fill="#55637c"/>
    <rect x="1010" y="720" width="400" height="98" rx="22" fill="url(#v-sofa-2)"/>
    <rect x="992" y="712" width="28" height="106" rx="13" fill="#4c5a70"/>
    <rect x="1400" y="712" width="28" height="106" rx="13" fill="#4c5a70"/>
    <!-- throw pillows: the difference between upholstery and a blue slab -->
    <rect x="1036" y="700" width="58" height="52" rx="12" fill="#6d7c96" transform="rotate(-8 1065 726)"/>
    <rect x="1330" y="700" width="58" height="52" rx="12" fill="#6d7c96" transform="rotate(7 1359 726)"/>
    <rect x="548" y="676" width="56" height="50" rx="12" fill="#ad7a5e" transform="rotate(7 576 701)"/>
  </g>

  <!-- plant -->
  <g>
    <path d="M1486 748 q-70 -94 -20 -178 q31 53 26 123 q10 -84 68 -123 q27 97 -48 178 z" fill="#2f4a35"/>
    <path d="M1438 734 q-60 -58 -36 -134 q45 36 47 100 q5 -65 47 -96 q22 74 -31 130 z" fill="#3a5a40"/>
    <path d="M1452 744 h104 l-12 68 h-80 z" fill="#5a3a2a"/>
    <rect x="1444" y="736" width="120" height="17" rx="6" fill="#6b4630"/>
  </g>

  <!-- the crowd, drawn last so it stands in front of the furniture -->
  <g class="v-people" id="listen-venue-people"></g>

  <!-- the second furniture pass: seats and legs, in front of the crowd -->
  <g class="v-furniture-front">
    <rect x="268" y="724" width="152" height="52" rx="14" fill="#7a556f"/>
    <rect x="262" y="800" width="22" height="22" rx="6" fill="#2b1c26"/>
    <rect x="406" y="800" width="22" height="22" rx="6" fill="#2b1c26"/>

    <rect x="490" y="712" width="164" height="62" rx="13" fill="#a06a50"/>
    <rect x="664" y="712" width="176" height="62" rx="13" fill="#976349"/>
    <rect x="478" y="792" width="26" height="28" rx="7" fill="#2b1a13"/>
    <rect x="826" y="792" width="26" height="28" rx="7" fill="#2b1a13"/>

    <rect x="1030" y="732" width="168" height="56" rx="13" fill="#5e6d88"/>
    <rect x="1212" y="732" width="180" height="56" rx="13" fill="#57657f"/>
    <rect x="1018" y="806" width="26" height="26" rx="7" fill="#161b23"/>
    <rect x="1376" y="806" width="26" height="26" rx="7" fill="#161b23"/>
  </g>
</svg>`;

/**
 * Where a figure stands, in the scene's own SVG coordinates.
 *
 * Positions live in the drawing's coordinate system, not in CSS percentages,
 * because the scene is cropped to fill the panel: a figure placed in percent
 * of the *box* drifts off its sofa the moment the window changes shape. In user
 * units, a figure is always on the furniture it is supposed to be on.
 *
 * `y` is the feet (or, seated, the hip) and doubles as the depth: the lower in
 * the frame, the closer to the viewer, the larger the figure.
 */
const SPOTS = [
  // The host works the booth (drawn behind it, so only the top half shows).
  { x: 228, y: 692, pose: 'dj', layer: 'back', scale: 1.62 },
  // Seats fill across the room rather than along one sofa: a handful of people
  // crowded onto one couch next to an empty one does not read as a room.
  { x: 344, y: 774, pose: 'sit', scale: 1.4 },   // armchair
  { x: 556, y: 768, pose: 'sit', scale: 1.38 },  // left sofa, seat 1
  { x: 1104, y: 786, pose: 'sit', scale: 1.38 }, // right sofa, seat 1
  { x: 764, y: 768, pose: 'sit', scale: 1.38 },  // left sofa, seat 3
  { x: 1304, y: 786, pose: 'sit', scale: 1.38 }, // right sofa, seat 3
  { x: 658, y: 764, pose: 'sit', scale: 1.34 },  // left sofa, seat 2
  { x: 1204, y: 782, pose: 'sit', scale: 1.34 }, // right sofa, seat 2
  { x: 1396, y: 782, pose: 'sit', scale: 1.32 }, // right sofa, seat 4
  // Standing behind the sofas.
  { x: 500, y: 706, pose: 'stand', layer: 'back', scale: 1.3 },
  { x: 828, y: 702, pose: 'stand', layer: 'back', scale: 1.28 },
  // On the rug, nearest the viewer last.
  { x: 936, y: 838, pose: 'dance', scale: 1.75 },
  { x: 796, y: 866, pose: 'stand', scale: 1.86 },
  { x: 1064, y: 858, pose: 'dance', scale: 1.8 },
  { x: 644, y: 892, pose: 'stand', scale: 1.96 },
  { x: 1186, y: 886, pose: 'dance', scale: 1.9 },
  { x: 456, y: 912, pose: 'stand', scale: 2.0 },
  { x: 1334, y: 916, pose: 'stand', scale: 1.96 },
  { x: 290, y: 904, pose: 'dance', scale: 1.9 },
];

/**
 * One illustrated figure, drawn in the scene's own units.
 *
 * Everything is a rounded rect or a path in a box with the feet at (0, 0):
 * legs, torso, arms, neck, head, hair. Arms sit *outside* the torso outline
 * (x = ±20..27) because an arm drawn inside the silhouette disappears at this
 * size and the figure reads as a mannequin. `pose` changes the legs (seated),
 * the arms (raised while dancing, reaching for the decks) and the idle
 * animation, so a room of one drawing does not look like clones.
 */
function figureSvg({ x, y, pose, scale, lean, delay, shirt, skin, hair, host, name }) {
  // A seated figure has no legs to its feet, so at the same scale it would look
  // like a child. Its scale compensates for the ~46 units of leg it does not use.
  const seated = pose === 'sit';
  const legs = seated
    ? `<path d="M-17 -6 q-4 -14 6 -24 h34 q8 10 4 24 q-6 8 -16 8 h-12 q-10 0 -16 -8z" fill="#1b1f27"/>
       <rect x="-17" y="-46" width="34" height="32" rx="11" fill="#242935"/>
       <rect x="-22" y="-6" width="18" height="9" rx="4.5" fill="#0e1117"/>
       <rect x="4" y="-6" width="18" height="9" rx="4.5" fill="#0e1117"/>`
    : `<rect x="-14" y="-46" width="12" height="46" rx="6" fill="#1b1f27"/>
       <rect x="2" y="-46" width="12" height="46" rx="6" fill="#1b1f27"/>
       <rect x="-16" y="-7" width="17" height="7" rx="3.5" fill="#0e1117"/>
       <rect x="-1" y="-7" width="17" height="7" rx="3.5" fill="#0e1117"/>`;
  // The arms are a shade of the shirt, not the shirt: an arm in exactly the
  // torso's colour merges into it and the figure reads as a bowling pin.
  const sleeve = `color-mix(in srgb, ${shirt} 74%, #0b0d12)`;
  const hands = (x1, y1, x2, y2) =>
    `<circle cx="${x1}" cy="${y1}" r="5.5" fill="${skin}"/><circle cx="${x2}" cy="${y2}" r="5.5" fill="${skin}"/>`;
  const arms = pose === 'dance'
    ? `<rect x="-28" y="-102" width="10" height="38" rx="5" fill="${sleeve}" transform="rotate(-24 -23 -102)"/>
       <rect x="18" y="-102" width="10" height="38" rx="5" fill="${sleeve}" transform="rotate(24 23 -102)"/>
       ${hands(-36, -132, 36, -132)}`
    : pose === 'dj'
      ? `<rect x="-28" y="-94" width="10" height="34" rx="5" fill="${sleeve}" transform="rotate(-30 -23 -94)"/>
         <rect x="18" y="-94" width="10" height="34" rx="5" fill="${sleeve}" transform="rotate(30 23 -94)"/>
         ${hands(-38, -118, 38, -118)}`
      : `<rect x="-28" y="-90" width="10" height="44" rx="5" fill="${sleeve}"/>
         <rect x="18" y="-90" width="10" height="44" rx="5" fill="${sleeve}"/>
         ${hands(-23, -44, 23, -44)}`;
  return `<g class="v-figure${host ? ' is-host' : ''}" data-pose="${pose}"
      transform="translate(${x} ${y}) scale(${scale.toFixed(3)})">
    <ellipse cx="0" cy="0" rx="30" ry="8" fill="#000" opacity=".4"/>
    <g class="v-pose" style="--d:${delay}s;--lean:${lean.toFixed(2)}deg">
      ${legs}
      <path d="M-19 -40 q0 -54 19 -54 q19 0 19 54 q0 7 -7 7 h-24 q-7 0 -7 -7z" fill="${shirt}"/>
      <path d="M-19 -40 q0 -54 19 -54 q7 0 11 9 q-11 7 -11 45 q0 7 -7 7 h-5 q-7 0 -7 -7z" fill="#000" opacity=".16"/>
      ${arms}
      <rect x="-5" y="-104" width="10" height="14" rx="5" fill="${skin}"/>
      <circle cx="0" cy="-117" r="13.5" fill="${skin}"/>
      <path d="M-13.8 -118 q0 -13 13.8 -13 q13.8 0 13.8 13 q-3.5 -7 -13.8 -7 q-10.3 0 -13.8 7z" fill="${hair}"/>
      ${host ? '<path d="M-10 -129 l3 -11 l5 7 l4 -10 l5 10 l4 -7 l3 11z" fill="#f2d27a"/>' : ''}
    </g>
    ${host && name ? `<text class="v-tag" x="0" y="-140" text-anchor="middle">${esc(name)}</text>` : ''}
  </g>`;
}



/**
 * Mount the venue into `root`. Returns the small API the listener page drives:
 * `show`, `hide`, `paint`, `paintVolume`, `destroy`. Everything else — the
 * crowd, the light, the bubbles, the posters — belongs to this module.
 */
export function mountVenue(root, { onExit, onMute, onVolume, onShare, onStart } = {}) {
  const saved = readSaved();
  let theme = THEMES.some((t) => t.id === saved.theme) ? saved.theme : 'club';
  // `null` means "follow the artwork": the honest default, and the reason the
  // room looks like the music. A number is the guest's own override.
  let hue = Number.isFinite(saved.hue) ? ((saved.hue % 360) + 360) % 360 : null;
  let autoHue = 14;
  let visible = false;
  let snapshot = null;
  let crowdSig = '';
  let posterSig = '';
  let bubbleTimer = null;
  let bubbleIndex = 0;

  root.innerHTML = `
    <div class="venue" data-theme="${theme}" data-light="${hue == null ? 'auto' : 'manual'}">
      <div class="v-scene">
        ${ROOM_SVG}
        <div class="v-gate" id="listen-venue-gate" hidden>
          <button class="v-gate-btn" id="listen-venue-start" type="button">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg><span>Listen live</span>
          </button>
          <p class="v-gate-note">This browser needs a tap before the room can play.</p>
        </div>
      </div>

      <div class="v-now" id="listen-venue-now">
        <span class="v-now-eyebrow">Now playing</span>
        <strong class="v-now-title">Waiting for music</strong>
        <span class="v-now-sub">The host is picking something</span>
        <div class="v-now-meta"><span class="v-now-people">1 in the room</span><span class="v-now-sync" data-sync="idle">Ready</span></div>
      </div>

      <div class="v-tools">
        <div class="v-themes" role="group" aria-label="Room style">
          ${THEMES.map((t) => `<button class="v-chip" type="button" data-theme-id="${t.id}" aria-pressed="${t.id === theme}">${t.label}</button>`).join('')}
        </div>
        <div class="v-light">
          <label class="v-light-label" for="listen-venue-hue">Light</label>
          <input id="listen-venue-hue" class="v-hue" type="range" min="0" max="360" step="1" value="${hue ?? autoHue}">
          <button class="v-auto" type="button" aria-pressed="${hue == null}">Auto</button>
        </div>
        <button class="v-exit" type="button">Player view</button>
      </div>

      <div class="v-deck">
        <button class="v-deck-btn" id="listen-venue-queue-toggle" type="button" aria-expanded="false">Queue</button>
        <div class="v-deck-queue" id="listen-venue-queue" hidden></div>
        <div class="v-transport" id="listen-venue-transport">
          <div class="v-progress"><i></i></div>
          <div class="v-transport-row">
            <span class="v-time"><span class="v-elapsed">0:00</span> / <span class="v-total">–:––</span></span>
            <div class="v-vol">
              <button class="v-icon-btn" id="listen-venue-mute" type="button" aria-label="Mute" aria-pressed="false">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path class="v-vol-wave" d="M16.5 8.5a5 5 0 0 1 0 7"/></svg>
              </button>
              <input id="listen-venue-volume" class="v-hue" type="range" min="0" max="100" step="1" value="5" aria-label="Volume" style="--fill:5%">
            </div>
            <button class="v-link" type="button" data-copy-share>Share room</button>
          </div>
        </div>
      </div>
    </div>`;

  const $ = (sel) => root.querySelector(sel);
  const venue = $('.venue');
  const peopleEl = $('#listen-venue-people');
  const backEl = $('#listen-venue-back');
  const artEl = $('.v-screen-art');
  const framesEl = $('.v-poster-frames');
  const bulbsEl = $('.v-bulbs');
  const hueInput = $('#listen-venue-hue');
  const queueEl = $('#listen-venue-queue');
  // A phone cannot show a 16:10 room in a 9:16 slot without either letterboxing
  // it to a strip or cropping it to a corner. It gets the whole room instead, at
  // the top of a stacked layout, with the cards in flow underneath — the room is
  // the point, so it is never the thing that gets cut.
  const save = () => writeSaved({ theme, hue });

  const fmt = (seconds) => {
    const s = Math.max(0, Math.floor(Number(seconds) || 0));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  function applyLight() {
    venue.dataset.light = hue == null ? 'auto' : 'manual';
    venue.style.setProperty('--hue', String(hue ?? autoHue));
    if (hueInput && document.activeElement !== hueInput) hueInput.value = String(Math.round(hue ?? autoHue));
    $('.v-auto').setAttribute('aria-pressed', String(hue == null));
  }

  function setTheme(id) {
    if (!THEMES.some((t) => t.id === id)) return;
    theme = id;
    venue.dataset.theme = id;
    root.querySelectorAll('[data-theme-id]').forEach((btn) => {
      btn.setAttribute('aria-pressed', String(btn.dataset.themeId === id));
    });
    crowdSig = ''; // density is part of the theme
    renderCrowd();
    save();
  }

  // ── the wall is hung with this room's records ────────────────────────
  // Six frames, filled from the queue (what played, what is playing, what is
  // next). Real sleeves, so the room is decorated by the music rather than by
  // stock posters — and a track change re-hangs the wall.
  const FRAMES = [
    { x: 356, y: 128, w: 146, h: 146, tilt: -3 },
    { x: 520, y: 116, w: 128, h: 172, tilt: 2 },
    { x: 664, y: 130, w: 140, h: 146, tilt: -2 },
    { x: 366, y: 300, w: 132, h: 172, tilt: 2 },
    { x: 516, y: 312, w: 152, h: 146, tilt: -2 },
    { x: 688, y: 306, w: 122, h: 162, tilt: 2 },
  ];

  function renderPosters() {
    if (!snapshot) return;
    const queue = Array.isArray(snapshot.queue) ? snapshot.queue : [];
    const index = Number.isInteger(snapshot.index) ? snapshot.index : 0;
    // The wall is hung with the room's own records, current one first, then what
    // follows, then what already played. Never padded and never repeated: a room
    // with two tracks has two sleeves, and a room with twenty has seven — a
    // wall of the same sleeve three times would read as a rendering bug.
    const ordered = [...queue.slice(index), ...queue.slice(0, index).reverse()];
    const picks = ordered.slice(0, FRAMES.length);
    const sig = picks.map((t) => t.videoId).join('|');
    if (sig === posterSig) return;
    posterSig = sig;
    framesEl.innerHTML = FRAMES.map((f, i) => {
      const track = picks[i];
      const clip = `v-poster-${i}`;
      const image = track
        ? `<image href="${esc(`/t/${encodeURIComponent(track.videoId)}/art.jpg`)}" x="${f.x + 6}" y="${f.y + 6}" width="${f.w - 12}" height="${f.h - 12}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${clip})"/>`
        : `<rect x="${f.x + 6}" y="${f.y + 6}" width="${f.w - 12}" height="${f.h - 12}" fill="#1a1512"/>`;
      return `<clipPath id="${clip}"><rect x="${f.x + 6}" y="${f.y + 6}" width="${f.w - 12}" height="${f.h - 12}" rx="2"/></clipPath>
        <g transform="rotate(${f.tilt} ${f.x + f.w / 2} ${f.y + f.h / 2})">
          <rect x="${f.x}" y="${f.y}" width="${f.w}" height="${f.h}" rx="4" fill="#0f0d0c" stroke="#8a6a4a" stroke-width="5"/>
          <rect x="${f.x + 3}" y="${f.y + 3}" width="${f.w - 6}" height="${f.h - 6}" rx="2" fill="#07080a"/>
          ${image}
        </g>`;
    }).join('');
  }

  // ── string lights ────────────────────────────────────────────────────
  function renderBulbs() {
    if (bulbsEl.childElementCount) return;
    const path = $('.v-string path');
    if (!path?.getTotalLength) return;
    const total = path.getTotalLength();
    const count = 16;
    let out = '';
    for (let i = 1; i < count; i += 1) {
      const p = path.getPointAtLength((total * i) / count);
      out += `<circle cx="${p.x.toFixed(1)}" cy="${(p.y + 8).toFixed(1)}" r="16" fill="url(#v-bulb)" opacity=".85"/>
        <circle cx="${p.x.toFixed(1)}" cy="${(p.y + 8).toFixed(1)}" r="4.5" fill="#ffe9c4"/>`;
    }
    bulbsEl.innerHTML = out;
  }

  // ── the crowd ────────────────────────────────────────────────────────
  // Figures are placed at hand-picked spots (so they sit on sofas and stand at
  // the booth) rather than scattered: a random crowd reads as confetti.
  function renderCrowd() {
    const count = Number.isFinite(snapshot?.listeners) ? snapshot.listeners : 1;
    // Exactly the room's real count, capped: the number on the wall and the
    // number of figures are the same fact. A sparse room looks sparse.
    const shown = Math.max(1, Math.min(MAX_PEOPLE, count));
    const hostName = snapshot?.host?.name ?? null;
    const sig = `${theme}:${shown}:${hostName ?? ''}`;
    if (sig === crowdSig) return;
    crowdSig = sig;

    const shirts = ['#c85a3f', '#3f6b8a', '#7a5aa8', '#c99a3f', '#4a8a6a', '#a84a6a', '#5a7a9a', '#9a6a3f'];
    const skins = ['#e3bb94', '#c08a5e', '#8d5b3c', '#f0cdab', '#a9714c'];
    const hairs = ['#241a16', '#3c2a1e', '#12100f', '#6b4a2a', '#8a6a3a'];
    const front = [];
    const back = [];
    const spots = SPOTS;
    spots.slice(0, shown).forEach((spot, i) => {
      const svg = figureSvg({
        ...spot,
        // A small per-figure size and lean difference is what stops a crowd of
        // one drawing from reading as clones.
        scale: spot.scale * (spot.pose === 'sit' ? 1.16 : 1) * (0.95 + noise(i, 2) * 0.1),
        lean: (noise(i, 5) - 0.5) * 3,
        delay: (noise(i, 4) * 4).toFixed(2),
        shirt: shirts[i % shirts.length],
        skin: skins[(i * 3) % skins.length],
        hair: hairs[(i * 2) % hairs.length],
        host: i === 0,
        name: i === 0 ? hostName : null,
      });
      (spot.layer === 'back' ? back : front).push(svg);
    });
    backEl.innerHTML = back.join('');
    peopleEl.innerHTML = front.join('');
    const extra = Math.max(0, count - shown);
    if (extra > 0) {
      peopleEl.innerHTML += `<g class="v-more"><rect x="1290" y="452" width="196" height="36" rx="18" fill="rgba(8,9,12,.84)" stroke="rgba(255,255,255,.14)"/>
        <text x="1388" y="476" text-anchor="middle">+${extra} more listening</text></g>`;
    }
  }

  // ── bubbles: status, never chat ──────────────────────────────────────
  // Each line is a fact the room already knows. Nothing is attributed to a
  // person who did not say it, which is why there is no "I love this song".
  function bubbleLines() {
    if (!snapshot) return [];
    const track = snapshot.track ?? null;
    const queue = Array.isArray(snapshot.queue) ? snapshot.queue : [];
    const index = Number.isInteger(snapshot.index) ? snapshot.index : 0;
    const next = queue[index + 1];
    const host = snapshot.host?.name ?? 'The host';
    const lines = [];
    if (snapshot.ended) lines.push({ who: 'host', text: 'That’s the end of the room.' });
    else {
      lines.push({ who: 'host', text: `${host} is hosting` });
      if (snapshot.playing) lines.push({ who: 'guest', text: 'In sync with the room' });
      if (next) lines.push({ who: 'guest', text: `Up next: ${next.title ?? next.videoId}` });
      if (track) lines.push({ who: 'guest', text: `${track.channel ?? 'Unknown artist'} on the projector` });
      const n = Number.isFinite(snapshot.listeners) ? snapshot.listeners : 1;
      lines.push({ who: 'guest', text: `${n} in the room` });
    }
    return lines;
  }

  function paintBubble() {
    // Remove from the whole room, not just the front layer: the host's bubble
    // hangs on the host figure, and the host is drawn *behind* the booth, so a
    // peopleEl-only sweep would leave one bubble behind every 6.5s and stack
    // them on the same spot for as long as the room is open.
    root.querySelectorAll('.v-bubble').forEach((el) => el.remove());
    if (!visible || !snapshot) return;
    const lines = bubbleLines();
    if (!lines.length) return;
    const line = lines[bubbleIndex % lines.length];
    // The host's own bubble hangs on the host figure; the rest rotate across the
    // other figures so the room feels like it is talking, not like a ticker.
    const hostFig = root.querySelector('.v-figure.is-host');
    const others = [...root.querySelectorAll('.v-people .v-figure:not(.is-host)')];
    const target = line.who === 'host' ? hostFig : (others[bubbleIndex % Math.max(1, others.length)] ?? hostFig);
    if (!target) return;
    // The figure's transform is `translate(x y) scale(s) rotate(...)`, so a
    // child at (0,-118) sits just above its head and inherits the scale. A
    // foreignObject is the one way to put a real, wrapping text box there.
    const width = Math.min(320, 26 + line.text.length * 8.2);
    const host = target.classList.contains('is-host');
    const bubble = document.createElementNS('http://www.w3.org/2000/svg', 'foreignObject');
    bubble.setAttribute('class', `v-bubble${host ? ' is-host' : ''}`);
    // The host stands behind the booth under the neon, so its bubble hangs to
    // the right instead of straight up, where the sign is.
    // The host's bubble hangs beside the booth, in the empty band of wall above
    // the wainscot: straight up would cover the neon, and further up would cover
    // the framed sleeves.
    // On a wide screen the host's bubble hangs left, into the empty wall above
    // the booth; on a phone that direction is off the edge of the frame, so it
    // hangs right instead, over the stage-side floor.
    const narrow = window.matchMedia('(max-width: 900px)').matches;
    bubble.setAttribute('x', String(host ? (narrow ? 40 : -width + 34) : -width / 2));
    bubble.setAttribute('y', String(host ? -196 : -152));
    bubble.setAttribute('width', String(width));
    bubble.setAttribute('height', '34');
    const div = document.createElementNS('http://www.w3.org/1999/xhtml', 'div');
    div.textContent = line.text;
    bubble.appendChild(div);
    target.appendChild(bubble);
  }

  function startBubbles() {
    clearInterval(bubbleTimer);
    if (!visible) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      paintBubble();
      return;
    }
    bubbleTimer = setInterval(() => {
      if (!visible || document.visibilityState !== 'visible') return;
      bubbleIndex += 1;
      paintBubble();
    }, 6500);
  }

  function stopBubbles() {
    clearInterval(bubbleTimer);
    bubbleTimer = null;
  }

  // ── the queue, as a card over the room ───────────────────────────────
  function renderQueue() {
    if (!snapshot) return;
    const queue = Array.isArray(snapshot.queue) ? snapshot.queue : [];
    const index = Number.isInteger(snapshot.index) ? snapshot.index : 0;
    const upcoming = queue.slice(index + 1, index + 9);
    if (!upcoming.length) {
      queueEl.innerHTML = `<p class="v-deck-empty">${queue.length ? 'That’s the last track.' : 'Nothing queued yet.'}</p>`;
      return;
    }
    queueEl.innerHTML = `<ol class="v-deck-list">${upcoming.map((t, i) => `<li>
        <span class="v-deck-num">${index + 2 + i}</span>
        <span class="v-deck-art" style="background-image:url('${esc(`/t/${encodeURIComponent(t.videoId)}/art.jpg`)}')"></span>
        <span class="v-deck-copy"><strong>${esc(t.title ?? t.videoId)}</strong><span>${esc(t.channel ?? '')}</span></span>
        <span class="v-deck-dur">${t.durationS > 0 ? fmt(t.durationS) : ''}</span>
      </li>`).join('')}</ol>`;
  }

  // ── public surface ───────────────────────────────────────────────────

  function paint(next) {
    snapshot = next;
    if (!next) return;
    const track = next.track ?? null;
    const title = track ? (track.title ?? track.videoId) : 'Waiting for music';
    const listeners = Number.isFinite(next.listeners) ? next.listeners : 1;

    $('.v-screen-title').textContent = title;
    $('.v-screen-sub').textContent = track ? (track.channel ?? '') : '';
    $('.v-now-title').textContent = title;
    $('.v-now-sub').textContent = next.ended
      ? 'This room has ended'
      : track
        ? (track.channel ?? '')
        : 'Waiting for the host to pick something';
    $('.v-now-people').textContent = `${listeners} in the room`;
    const syncEl = $('.v-now-sync');
    syncEl.textContent = next.ended ? '—' : (next.playing ? 'Live' : 'Paused');
    syncEl.dataset.sync = next.ended ? 'idle' : (next.playing ? 'good' : 'warn');

    if (track) {
      const url = `/t/${encodeURIComponent(track.videoId)}/art.jpg`;
      if (artEl.getAttribute('href') !== url) artEl.setAttribute('href', url);
      // The light follows the record unless the guest took the wheel.
      dominantHue(url).then((sampled) => {
        if (sampled == null) return;
        autoHue = sampled;
        if (hue == null) applyLight();
      });
    }

    venue.dataset.playing = next.playing && !next.ended ? '1' : '0';
    venue.dataset.ended = next.ended ? '1' : '0';
    renderCrowd();
    renderPosters();
    renderQueue();
    if (visible) paintBubble();
  }

  /**
   * What the progress line currently shows, so a repaint that would change
   * nothing costs nothing.
   *
   * The player calls this four times a second, and each call used to rewrite
   * `.v-screen-fill`'s `width` plus five text nodes inside a 1600×1000 SVG with
   * about eighteen animated figures, gradients and clip paths: an attribute write
   * on an SVG child forces layout and style work across the whole scene, and on a
   * mid-range phone that is the frame cost that turns the venue into a slide
   * show while the progress bar advances. None of these nodes can display a
   * difference smaller than the values compared here — whole seconds for text,
   * SVG units for the screen bar, a tenth of a percent for the thin HTML bar —
   * so the writes that would change nothing are exactly the writes worth
   * skipping.
   */
  let painted = { second: -1, fill: -1, bar: '', total: '', ended: null };

  /** The progress line, driven by the player's own clock (not a second timer). */
  function paintProgress({ currentTime = 0, duration = 0, ended = false } = {}) {
    const dur = Number.isFinite(duration) && duration > 0 ? duration : 0;
    const pct = dur ? Math.min(1, currentTime / dur) : 0;
    // Only paint what is on screen: a hidden venue costs nothing per tick, and
    // `show()` throws the cache away so the first visible frame is always real.
    if (!visible) return;
    const second = Math.floor(Math.max(0, Number(currentTime) || 0));
    const fillWidth = Math.round(pct * 660);
    const barWidth = `${Math.round(pct * 1000) / 10}%`;
    const total = dur ? fmt(dur) : '–:––';
    if (second !== painted.second) {
      painted.second = second;
      $('.v-screen-elapsed').textContent = fmt(currentTime);
      $('.v-elapsed').textContent = fmt(currentTime);
    }
    if (fillWidth !== painted.fill) {
      painted.fill = fillWidth;
      // The screen's own progress is in SVG units (660 wide), so it scales with
      // the room instead of being a separately positioned element that drifts.
      $('.v-screen-fill')?.setAttribute('width', String(fillWidth));
    }
    if (barWidth !== painted.bar) {
      painted.bar = barWidth;
      $('.v-progress i').style.width = barWidth;
    }
    if (total !== painted.total) {
      painted.total = total;
      $('.v-screen-total').textContent = total;
      $('.v-total').textContent = total;
    }
    if (ended !== painted.ended) {
      painted.ended = ended;
      venue.dataset.ended = ended ? '1' : '0';
    }
  }

  /**
   * The room's count changed without a new snapshot (someone joined, someone
   * closed the tab). The crowd is the count, so it has to follow immediately —
   * waiting for the next state frame would leave the room lying about itself
   * for as long as the host's playhead happens to be still.
   */
  function setListeners(n) {
    if (!snapshot || !Number.isFinite(n)) return;
    snapshot = { ...snapshot, listeners: n };
    renderCrowd();
    $('.v-now-people').textContent = `${n} in the room`;
    if (!snapshot.ended && snapshot.track) {
      $('.v-now-sub').textContent = snapshot.track.channel ?? '';
    }
    if (visible) paintBubble();
  }

  /**
   * The gate, in the venue's own terms.
   *
   * The player shows its overlay over the sleeve, but the venue hides that whole
   * column: a guest who lands here with autoplay blocked would otherwise get
   * silence and no button. This is the same gate, drawn on the stage.
   */
  function paintGate({ needsTap, ended, label, ready }) {
    const gate = $('#listen-venue-gate');
    if (!gate) return;
    // A terminal room still shows the gate, because it is where the reason
    // lives; it is just no longer something to press. `label` carries the
    // honest terminal text from the player ('Invite only' for a room that
    // closed its door), falling back to the ended wording for a plain end.
    gate.hidden = !(needsTap || ended);
    if (!needsTap && !ended) return;
    const text = gate.querySelector('.v-gate-btn span');
    const btn = gate.querySelector('.v-gate-btn');
    const terminal = ended ? (label && label !== 'Listen live' ? label : 'Room ended') : (label ?? 'Listen live');
    if (text) text.textContent = terminal;
    if (btn) btn.disabled = ended || !ready;
    gate.querySelector('.v-gate-note').textContent = ended
      ? (terminal === 'Invite only' ? 'This room is invite only now.' : 'This room has ended.')
      : ready
        ? 'This browser needs a tap before the room can play.'
        : 'Waiting for the host to pick something.';
  }

  function paintVolume({ muted, volume }) {
    const btn = $('#listen-venue-mute');
    const slider = $('#listen-venue-volume');
    const wave = btn?.querySelector('.v-vol-wave');
    if (btn) {
      btn.setAttribute('aria-pressed', String(muted));
      btn.setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
    }
    if (wave) wave.setAttribute('d', muted ? 'M19 9.5l3.5 5M22.5 9.5l-3.5 5' : 'M16.5 8.5a5 5 0 0 1 0 7');
    if (slider) {
      const pct = Math.round((muted ? 0 : volume) * 100);
      if (document.activeElement !== slider) slider.value = String(pct);
      slider.style.setProperty('--fill', `${pct}%`);
    }
  }

  function show() {
    if (visible) return;
    visible = true;
    root.hidden = false;
    venue.classList.add('is-live');
    renderBulbs();
    // A hidden venue skips every progress tick (see paintProgress), so the cache
    // describes a frame from before it was hidden: throw it away and let the next
    // tick paint the truth, even if the numbers happen to match.
    painted = { second: -1, fill: -1, bar: '', total: '', ended: null };
    if (snapshot) paint(snapshot);
    startBubbles();
  }

  function hide() {
    visible = false;
    root.hidden = true;
    stopBubbles();
  }

  function destroy() {
    stopBubbles();
    root.innerHTML = '';
    root.hidden = true;
    visible = false;
  }

  // ── wiring ───────────────────────────────────────────────────────────
  root.querySelectorAll('[data-theme-id]').forEach((btn) => {
    btn.addEventListener('click', () => setTheme(btn.dataset.themeId));
  });
  $('.v-auto').addEventListener('click', () => {
    hue = null;
    applyLight();
    save();
  });
  hueInput.addEventListener('input', (e) => {
    hue = ((Number(e.target.value) % 360) + 360) % 360;
    applyLight();
    save();
  });
  $('.v-exit').addEventListener('click', () => onExit?.());
  $('#listen-venue-start')?.addEventListener('click', () => onStart?.());
  $('#listen-venue-mute')?.addEventListener('click', () => onMute?.());
  $('#listen-venue-volume')?.addEventListener('input', (e) => onVolume?.(Number(e.target.value) / 100));
  $('#listen-venue-queue-toggle')?.addEventListener('click', (e) => {
    const open = queueEl.hidden;
    queueEl.hidden = !open;
    e.currentTarget.setAttribute('aria-expanded', String(open));
  });
  // `column-reverse` keeps the button pinned to the bottom of the deck while the
  // drawer opens above it; without it the button jumps up the screen and lands
  // on top of whatever the room is saying.

  root.querySelector('[data-copy-share]')?.addEventListener('click', () => onShare?.());

  document.addEventListener('visibilitychange', () => {
    if (!visible) return;
    if (document.visibilityState === 'visible') startBubbles();
    else stopBubbles();
  });

  applyLight();

  return {
    show,
    hide,
    paint,
    paintGate,
    paintProgress,
    paintVolume,
    setListeners,
    destroy,
    get visible() { return visible; },
    get theme() { return theme; },
    get hue() { return hue ?? autoHue; },
  };
}
