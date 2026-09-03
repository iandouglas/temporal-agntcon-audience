/**
 * Tiled hexagon backdrop.
 *
 * Drawn as an SVG <pattern> rather than an image so it stays crisp at any DPR
 * and costs nothing to download. The tile holds hexes at each corner plus one in
 * the middle, which is the standard offset-row hex grid.
 */

const CIRCUMRADIUS = 28;
const HALF_WIDTH = (Math.sqrt(3) / 2) * CIRCUMRADIUS; // 24.2487
const TILE_W = HALF_WIDTH * 2;
const TILE_H = CIRCUMRADIUS * 3;

function hex(cx: number, cy: number): string {
  const points: Array<[number, number]> = [
    [cx, cy - CIRCUMRADIUS],
    [cx + HALF_WIDTH, cy - CIRCUMRADIUS / 2],
    [cx + HALF_WIDTH, cy + CIRCUMRADIUS / 2],
    [cx, cy + CIRCUMRADIUS],
    [cx - HALF_WIDTH, cy + CIRCUMRADIUS / 2],
    [cx - HALF_WIDTH, cy - CIRCUMRADIUS / 2],
  ];
  return points.map(([x, y]) => `${x.toFixed(3)},${y.toFixed(3)}`).join(" ");
}

const CENTERS: Array<[number, number]> = [
  [0, 0],
  [TILE_W, 0],
  [0, TILE_H],
  [TILE_W, TILE_H],
  [TILE_W / 2, TILE_H / 2],
];

export function HexField() {
  return (
    <>
      <svg className="hexfield" aria-hidden="true" focusable="false">
        <defs>
          <pattern
            id="hexgrid"
            width={TILE_W}
            height={TILE_H}
            patternUnits="userSpaceOnUse"
          >
            {CENTERS.map(([cx, cy]) => (
              <polygon
                key={`${cx}-${cy}`}
                points={hex(cx, cy)}
                fill="none"
                stroke="rgba(255,255,255,0.075)"
                strokeWidth="1"
              />
            ))}
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#hexgrid)" />
      </svg>
      <div className="vignette" aria-hidden="true" />
    </>
  );
}
