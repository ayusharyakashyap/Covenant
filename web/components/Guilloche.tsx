import { useMemo } from "react";

// Security-printing rosette, seeded by the contract id so every contract's "note" is unique.
function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function Guilloche({ seed, width = 1200, height = 320, opacity = 0.55, dense = true }: { seed: string; width?: number; height?: number; opacity?: number; dense?: boolean }) {
  const paths = useMemo(() => {
    const r = rng(hash(seed));
    const cx = width * (0.72 + r() * 0.12);
    const cy = height * (0.5 + (r() - 0.5) * 0.2);
    const lobes = 9 + Math.floor(r() * 9);
    const lobes2 = 3 + Math.floor(r() * 5);
    const rings = dense ? 14 : 8;
    const out: string[] = [];
    for (let k = 0; k < rings; k++) {
      const base = 40 + k * (dense ? 13 : 20);
      const amp = 6 + (k % 4) * 3;
      const phase = k * 0.37 + r() * 0.2;
      let d = "";
      const steps = 540;
      for (let i = 0; i <= steps; i++) {
        const t = (i / steps) * Math.PI * 2;
        const rad = base + amp * Math.sin(lobes * t + phase) + (amp * 0.6) * Math.sin(lobes2 * t - phase * 2);
        const x = cx + rad * Math.cos(t) * 1.25;
        const y = cy + rad * Math.sin(t);
        d += `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
      }
      out.push(d + "Z");
    }
    // a band of sine waves along the bottom, like the border of a banknote
    for (let k = 0; k < 6; k++) {
      let d = "";
      for (let x = 0; x <= width; x += 6) {
        const y = height - 16 - k * 3 + Math.sin(x / (18 + k * 3) + k) * 5;
        d += `${x ? "L" : "M"}${x} ${y.toFixed(1)}`;
      }
      out.push(d);
    }
    return out;
  }, [seed, width, height, dense]);

  return (
    <svg className="g" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <g fill="none" stroke="var(--guilloche)" strokeWidth="0.7" opacity={opacity}>
        {paths.map((d, i) => (
          <path key={i} d={d} />
        ))}
      </g>
    </svg>
  );
}

export function Mark() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="16" cy="16" r="14.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M21.5 10.6a7.2 7.2 0 1 0 0 10.8" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
      <circle cx="21.6" cy="16" r="2" fill="var(--held)" />
    </svg>
  );
}
