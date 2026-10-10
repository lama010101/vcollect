// =============================================================================
// SVG frame emitter — turns a VizFrameState (shared math) into an SVG string
// that sharp/libvips rasterizes to rgb24. The Canvas preview draws the same
// primitives, so the export matches the preview in geometry.
//
// Emit order: mode visuals (rings/bars/particles/mirrors/blocks/ribbons) → dancer → star.
// =============================================================================

import { visualsForRow, type VizFrameState, type VizModeVisuals } from "@twio/shared";

const f = (n: number): string => (Math.round(n * 10) / 10).toString();

/** "M x y L x y …" from an interleaved [x,y] point list. */
function linePath(pts: Float32Array): string {
  if (pts.length < 4) return "";
  let d = `M${f(pts[0]!)} ${f(pts[1]!)}`;
  for (let i = 2; i < pts.length; i += 2) d += `L${f(pts[i]!)} ${f(pts[i + 1]!)}`;
  return d;
}

/** "M x y L … Z" closed polygon for a ribbon outline. */
function polyPath(pts: Float32Array): string {
  const d = linePath(pts);
  return d ? `${d}Z` : "";
}

/** Batched circles as one path: per circle `Mcx cy m -r 0 a r r 0 1 0 2r 0 a r r 0 1 0 -2r 0`. */
function circlesPath(pts: Float32Array): string {
  let d = "";
  for (let i = 0; i + 2 < pts.length; i += 3) {
    const cx = f(pts[i]!);
    const cy = f(pts[i + 1]!);
    const r = f(Math.max(0.4, pts[i + 2]!));
    d += `M${cx} ${cy}m-${r} 0a${r} ${r} 0 1 0 ${2 * +r} 0a${r} ${r} 0 1 0 -${2 * +r} 0`;
  }
  return d;
}

/** Batched rects as one path (x,y,w,h quads). */
function rectsPath(bars: Float32Array): string {
  let d = "";
  for (let i = 0; i + 3 < bars.length; i += 4) {
    const x = f(bars[i]!);
    const y = f(bars[i + 1]!);
    const w = f(bars[i + 2]!);
    const h = f(bars[i + 3]!);
    d += `M${x} ${y}h${w}v${h}h-${w}Z`;
  }
  return d;
}

/** Batched strand polylines: `packed` holds `count` polylines of `n` points
 *  each — emitted as M..L..M..L.. subpaths in a single path string so one
 *  <path> node carries the whole silk stack. */
function strandsPath(packed: Float32Array, count: number, n: number): string {
  let d = "";
  for (let k = 0; k < count; k++) {
    const off = k * n * 2;
    if (off + 1 >= packed.length) break;
    d += `M${f(packed[off]!)} ${f(packed[off + 1]!)}`;
    for (let i = 1; i < n; i++) d += `L${f(packed[off + i * 2]!)} ${f(packed[off + i * 2 + 1]!)}`;
  }
  return d;
}

/** Batched quads as one path: each 8 floats is a closed 4-point polygon. */
function quadsPath(pts: ArrayLike<number>): string {
  let d = "";
  for (let i = 0; i + 7 < pts.length; i += 8) {
    d += `M${f(pts[i]!)} ${f(pts[i + 1]!)}L${f(pts[i + 2]!)} ${f(pts[i + 3]!)}L${f(pts[i + 4]!)} ${f(pts[i + 5]!)}L${f(pts[i + 6]!)} ${f(pts[i + 7]!)}Z`;
  }
  return d;
}

/** Batched joint dots (x,y pairs) as one circle path. */
function dotsPath(joints: Float32Array, r: number): string {
  let d = "";
  for (let i = 0; i + 1 < joints.length; i += 2) {
    const cx = f(joints[i]!);
    const cy = f(joints[i + 1]!);
    const rr = f(r);
    d += `M${cx} ${cy}m-${rr} 0a${rr} ${rr} 0 1 0 ${2 * +rr} 0a${rr} ${rr} 0 1 0 -${2 * +rr} 0`;
  }
  return d;
}

/** One media layer's <image> — render.ts hands in the decoded frame already
 *  cover-cropped to width×height; `scale` resizes the destination rect about
 *  the layer's center (cx·w, cy·h) and cx/cy place that center anywhere in
 *  the frame (<1 centered inset, >1 zooms — the viewBox clips the overflow).
 *  Identical placement math to the Canvas preview's drawImage. */
function layerImageTag(href: string, opacity: number, scale: number, width: number, height: number, cx: number, cy: number): string {
  const dw = width * scale;
  const dh = height * scale;
  const x = cx * width - dw / 2;
  const y = cy * height - dh / 2;
  return `<image href="${href}" xlink:href="${href}" x="${f(x)}" y="${f(y)}" width="${f(dw)}" height="${f(dh)}" preserveAspectRatio="none" opacity="${f(opacity)}"/>`;
}

/** One waveform layer's primitives (ribbons/rings/bars/particles/mirrors/
 *  blocks/eqbars/eqradial/stereos/silk) pushed into `parts` — extracted from
 *  frameSvg so each visuals row can draw its OWN mode geometry at its stack
 *  position (wrapped in the row's opacity/scale <g>). `gradPrefix` namespaces
 *  the silk gradient ids so several silk layers don't collide in one doc. */
function modeVisualsSvg(vis: VizModeVisuals, parts: string[], gradPrefix: string): void {
  // --- ribbons mode --------------------------------------------------------------
  for (const s of vis.stems) {
    if (s.glowWidth > 0 && s.glowAlpha > 0.01) {
      const d = linePath(s.centerline);
      if (d) {
        // Two stacked glow strokes: wide/soft + tighter/brighter.
        parts.push(
          `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${f(s.glowWidth)}" opacity="${f(s.glowAlpha * 0.55)}" stroke-linecap="round" stroke-linejoin="round"/>`,
          `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${f(s.glowWidth * 0.45)}" opacity="${f(s.glowAlpha)}" stroke-linecap="round" stroke-linejoin="round"/>`,
        );
      }
    }
    const core = polyPath(s.ribbon);
    if (core) parts.push(`<path d="${core}" fill="${s.color}" opacity="${f(s.alpha)}"/>`);
    for (const h of s.harmonics) {
      const hd = polyPath(h);
      if (hd) parts.push(`<path d="${hd}" fill="${s.color}" opacity="${f(s.alpha * 0.45)}"/>`);
    }
  }

  // --- circular mode ----------------------------------------------------------------
  for (const r of vis.rings) {
    const d = polyPath(r.points);
    if (!d) continue;
    if (r.glowWidth > 0 && r.glowAlpha > 0.01) {
      parts.push(`<path d="${d}" fill="none" stroke="${r.color}" stroke-width="${f(r.glowWidth)}" opacity="${f(r.glowAlpha * 0.5)}" stroke-linejoin="round"/>`);
    }
    parts.push(`<path d="${d}" fill="${r.color}" fill-opacity="${f(r.fillAlpha)}" stroke="${r.color}" stroke-width="${f(r.lineWidth)}" opacity="${f(r.alpha)}" stroke-linejoin="round"/>`);
  }

  // --- spectrum mode ------------------------------------------------------------------
  for (const g of vis.bars) {
    const d = rectsPath(g.bars);
    if (!d) continue;
    if (g.glowAlpha > 0.01) {
      parts.push(`<path d="${d}" fill="${g.color}" opacity="${f(g.glowAlpha * 0.35)}"/>`);
    }
    parts.push(`<path d="${d}" fill="${g.color}" opacity="${f(g.alpha)}"/>`);
  }

  // --- particles mode -------------------------------------------------------------------
  for (const g of vis.particles) {
    const d = circlesPath(g.points);
    if (d) parts.push(`<path d="${d}" fill="${g.color}" opacity="${f(g.alpha)}"/>`);
  }

  // --- mirror mode (mirrored waveforms on the center axis) -------------------------------
  for (const m of vis.mirrors) {
    const d = polyPath(m.fill);
    if (d) {
      if (m.glowWidth > 0 && m.glowAlpha > 0.01) {
        parts.push(`<path d="${d}" fill="none" stroke="${m.color}" stroke-width="${f(m.glowWidth)}" opacity="${f(m.glowAlpha * 0.5)}" stroke-linejoin="round"/>`);
      }
      parts.push(`<path d="${d}" fill="${m.color}" opacity="${f(m.alpha * 0.4)}"/>`);
      parts.push(`<path d="${d}" fill="none" stroke="${m.color}" stroke-width="1.4" opacity="${f(m.alpha)}" stroke-linejoin="round"/>`);
    }
    for (const e of m.echoes) {
      const ed = linePath(e);
      if (ed) parts.push(`<path d="${ed}" fill="none" stroke="${m.color}" stroke-width="1" opacity="${f(m.alpha * 0.5)}" stroke-linejoin="round"/>`);
    }
    const dd = circlesPath(m.dots);
    if (dd) parts.push(`<path d="${dd}" fill="${m.color}" opacity="${f(Math.min(1, m.alpha + 0.25))}"/>`);
  }

  // --- blocks mode (segmented mirrored columns, x-slice per stem) -------------------------
  for (const g of vis.blocks) {
    const d = rectsPath(g.rects);
    if (d) {
      if (g.glowAlpha > 0.01) {
        parts.push(`<path d="${d}" fill="${g.color}" opacity="${f(g.glowAlpha * 0.35)}"/>`);
      }
      parts.push(`<path d="${d}" fill="${g.color}" opacity="${f(g.alpha)}"/>`);
    }
    const dd = circlesPath(g.dots);
    if (dd) parts.push(`<path d="${dd}" fill="${g.color}" opacity="${f(Math.min(1, g.alpha + 0.3))}"/>`);
  }

  // --- eqbars mode (segmented mirrored LED columns, glowing tips + sparks) -------
  const EQ_BUCKETS = 5;
  for (const g of vis.eqbars) {
    // Segments carry a per-seg brightness (stride 5) — bucket them into one
    // path per brightness level so the column ramp renders with few nodes.
    const buckets: number[][] = Array.from({ length: EQ_BUCKETS }, () => []);
    const all: number[] = [];
    for (let i = 0; i + 4 < g.segs.length; i += 5) {
      all.push(g.segs[i]!, g.segs[i + 1]!, g.segs[i + 2]!, g.segs[i + 3]!);
      const b = Math.min(EQ_BUCKETS - 1, Math.floor(g.segs[i + 4]! * EQ_BUCKETS));
      buckets[b]!.push(g.segs[i]!, g.segs[i + 1]!, g.segs[i + 2]!, g.segs[i + 3]!);
    }
    if (g.glowAlpha > 0.01) {
      const d = rectsPath(Float32Array.from(all));
      if (d) parts.push(`<path d="${d}" fill="${g.color}" opacity="${f(g.glowAlpha * 0.3)}"/>`);
    }
    for (let b = 0; b < EQ_BUCKETS; b++) {
      const d = rectsPath(Float32Array.from(buckets[b]!));
      if (d) parts.push(`<path d="${d}" fill="${g.color}" opacity="${f(g.alpha * ((b + 0.5) / EQ_BUCKETS))}"/>`);
    }
    const ad = rectsPath(g.axis);
    if (ad) parts.push(`<path d="${ad}" fill="${g.tipColor}" opacity="${f(Math.min(1, g.glowAlpha + 0.3))}"/>`);
    const gd = circlesPath(g.tipGlow);
    if (gd) parts.push(`<path d="${gd}" fill="${g.tipColor}" opacity="${f(g.glowAlpha * 0.6)}"/>`);
    const td = rectsPath(g.tips);
    if (td) parts.push(`<path d="${td}" fill="${g.tipColor}" opacity="${f(Math.min(1, g.alpha + 0.2))}"/>`);
    const sd = circlesPath(g.sparks);
    if (sd) parts.push(`<path d="${sd}" fill="${g.tipColor}" opacity="${f(Math.min(1, g.glowAlpha + 0.35))}"/>`);
  }

  // --- eqradial mode (radial LED columns around the center, tips + sparks) --
  for (const g of vis.eqradial) {
    // Stride-9 segments (quad + brightness) — bucket into one path per
    // brightness level like the linear eqbars columns.
    const buckets: number[][] = Array.from({ length: EQ_BUCKETS }, () => []);
    const all: number[] = [];
    for (let i = 0; i + 8 < g.segs.length; i += 9) {
      for (let k = 0; k < 8; k++) all.push(g.segs[i + k]!);
      const b = Math.min(EQ_BUCKETS - 1, Math.floor(g.segs[i + 8]! * EQ_BUCKETS));
      for (let k = 0; k < 8; k++) buckets[b]!.push(g.segs[i + k]!);
    }
    if (g.glowAlpha > 0.01) {
      const d = quadsPath(all);
      if (d) parts.push(`<path d="${d}" fill="${g.color}" opacity="${f(g.glowAlpha * 0.3)}"/>`);
    }
    for (let b = 0; b < EQ_BUCKETS; b++) {
      const d = quadsPath(buckets[b]!);
      if (d) parts.push(`<path d="${d}" fill="${g.color}" opacity="${f(g.alpha * ((b + 0.5) / EQ_BUCKETS))}"/>`);
    }
    for (let i = 0; i + 3 < g.ring.length; i += 4) {
      parts.push(
        `<circle cx="${f(g.ring[i]!)}" cy="${f(g.ring[i + 1]!)}" r="${f(g.ring[i + 2]!)}" fill="none" stroke="${g.tipColor}" stroke-width="${f(g.ring[i + 3]!)}" opacity="${f(Math.min(1, g.glowAlpha + 0.3))}"/>`,
      );
    }
    const gd = circlesPath(g.tipGlow);
    if (gd) parts.push(`<path d="${gd}" fill="${g.tipColor}" opacity="${f(g.glowAlpha * 0.6)}"/>`);
    const td = quadsPath(g.tips);
    if (td) parts.push(`<path d="${td}" fill="${g.tipColor}" opacity="${f(Math.min(1, g.alpha + 0.2))}"/>`);
    const sd = circlesPath(g.sparks);
    if (sd) parts.push(`<path d="${sd}" fill="${g.tipColor}" opacity="${f(Math.min(1, g.glowAlpha + 0.35))}"/>`);
  }

  // --- stereo mode (channel waveforms meeting along the vertical center line) --
  for (const s of vis.stereos) {
    for (const fill of [s.leftFill, s.rightFill]) {
      const d = polyPath(fill);
      if (!d) continue;
      if (s.glowWidth > 0 && s.glowAlpha > 0.01) {
        parts.push(`<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${f(s.glowWidth)}" opacity="${f(s.glowAlpha * 0.5)}" stroke-linejoin="round"/>`);
      }
      parts.push(`<path d="${d}" fill="${s.color}" opacity="${f(s.alpha * 0.45)}"/>`);
      parts.push(`<path d="${d}" fill="none" stroke="${s.color}" stroke-width="1.2" opacity="${f(s.alpha)}" stroke-linejoin="round"/>`);
    }
    for (const e of [s.leftEcho, s.rightEcho]) {
      const ed = linePath(e);
      if (ed) parts.push(`<path d="${ed}" fill="none" stroke="${s.color}" stroke-width="1" opacity="${f(s.alpha * 0.5)}" stroke-linejoin="round"/>`);
    }
  }

  // --- silk mode (nested mirrored waveform strands, spectral x-gradient) ------
  // Each stem's strand pack strokes through a userSpace linear gradient: the
  // violet→cyan / amber→magenta sweep, hot toward the convergence point.
  if (vis.silks.length > 0) {
    const defs: string[] = [];
    for (let si = 0; si < vis.silks.length; si++) {
      const s = vis.silks[si]!;
      defs.push(
        `<linearGradient id="${gradPrefix}silk${si}" gradientUnits="userSpaceOnUse" x1="${f(s.gradX0)}" y1="0" x2="${f(s.gradX1)}" y2="0">` +
          `<stop offset="0%" stop-color="${s.grad0}"/>` +
          `<stop offset="${f(s.gradMid * 100)}%" stop-color="${s.grad1}"/>` +
          `<stop offset="100%" stop-color="${s.grad2}"/>` +
          `</linearGradient>`,
      );
    }
    parts.push(`<defs>${defs.join("")}</defs>`);
    for (let si = 0; si < vis.silks.length; si++) {
      const s = vis.silks[si]!;
      const stroke = `url(#${gradPrefix}silk${si})`;
      const d = strandsPath(s.up, s.strandCount, s.strandN) + strandsPath(s.down, s.strandCount, s.strandN);
      if (d) {
        if (s.glowWidth > 0 && s.glowAlpha > 0.01) {
          parts.push(`<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${f(Math.max(2, s.glowWidth * 0.4))}" opacity="${f(s.glowAlpha * 0.35)}" stroke-linecap="round" stroke-linejoin="round"/>`);
        }
        parts.push(`<path d="${d}" fill="none" stroke="${stroke}" stroke-width="1" opacity="${f(s.alpha)}" stroke-linecap="round" stroke-linejoin="round"/>`);
        // Edge = the last (scale-1) strand, re-stroked brighter.
        const eoff = (s.strandCount - 1) * s.strandN * 2;
        const ed = linePath(s.up.subarray(eoff, eoff + s.strandN * 2)) + linePath(s.down.subarray(eoff, eoff + s.strandN * 2));
        if (ed) parts.push(`<path d="${ed}" fill="none" stroke="${stroke}" stroke-width="1.6" opacity="${f(Math.min(1, s.alpha + 0.45))}" stroke-linecap="round" stroke-linejoin="round"/>`);
      }
      const ad = rectsPath(s.axis);
      if (ad) {
        parts.push(`<path d="${ad}" fill="${stroke}" opacity="${f(Math.min(1, s.glowAlpha + 0.4))}"/>`);
        const cd = rectsPath(Float32Array.from([s.axis[0]!, s.axis[1]! + s.axis[3]! * 0.3, s.axis[2]!, s.axis[3]! * 0.4]));
        if (cd) parts.push(`<path d="${cd}" fill="#FFFFFF" opacity="${f(Math.min(1, s.glowAlpha + 0.25))}"/>`);
      }
      const dd = circlesPath(s.dust);
      if (dd) parts.push(`<path d="${dd}" fill="${s.color}" opacity="${f(Math.min(1, s.alpha + 0.3))}"/>`);
    }
  }

}

export function frameSvg(state: VizFrameState, width: number, height: number, background: string, layerImageHrefs?: ReadonlyArray<string | null>): string {
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<defs><radialGradient id="star"><stop offset="0%" stop-color="#ffffff" stop-opacity="1"/>`,
    `<stop offset="35%" stop-color="#fff7e0" stop-opacity="0.55"/>`,
    `<stop offset="100%" stop-color="#ffffff" stop-opacity="0"/></radialGradient></defs>`,
    `<rect width="${width}" height="${height}" fill="${background}"/>`,
  ];

  // The layer stack — row order is the z-order, composited over the
  // background. Media rows embed their decoded frame; a visuals row draws ITS
  // OWN mode geometry (that row's channel) at that position (wrapped in the
  // row's opacity/scale <g>). With no visuals row the waveforms don't render
  // at all. The dancer + convergence star always ride on top of the stack.
  state.videoLayers.forEach((v, i) => {
    if (v.hidden || v.visible === false || v.opacity <= 0) return;
    if (v.kind === "visuals") {
      const inner: string[] = [];
      modeVisualsSvg(visualsForRow(state, i), inner, `l${i}_`);
      if (inner.length === 0) return;
      // Scale about the row's own center — which x/y move off the frame
      // center (translate-to-center → scale → translate-back).
      const tr =
        Math.abs(v.scale - 1) > 1e-6 || v.x !== 0.5 || v.y !== 0.5
          ? ` transform="translate(${f(v.x * width)} ${f(v.y * height)}) scale(${f(v.scale)}) translate(${f(-width / 2)} ${f(-height / 2)})"`
          : "";
      parts.push(`<g opacity="${f(v.opacity)}"${tr}>`, ...inner, "</g>");
      return;
    }
    const href = layerImageHrefs?.[i];
    if (href) parts.push(layerImageTag(href, v.opacity, v.scale, width, height, v.x, v.y));
  });

  // --- procedural dancer -----------------------------------------------------------------
  const dn = state.dancer;
  if (dn) {
    if (dn.glowWidth > 0) {
      for (const s of dn.strokes) {
        const d = linePath(s.points);
        if (d) {
          parts.push(`<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${f(dn.glowWidth)}" opacity="${f(s.alpha * 0.4)}" stroke-linecap="round" stroke-linejoin="round"/>`);
        }
      }
      parts.push(`<circle cx="${f(dn.head.x)}" cy="${f(dn.head.y)}" r="${f(dn.head.r * 1.9)}" fill="url(#star)" opacity="${f(dn.alpha * 0.35)}"/>`);
    }
    for (const limb of dn.limbs) {
      const d = polyPath(limb.path);
      if (d) parts.push(`<path d="${d}" fill="${limb.color}" opacity="${f(limb.alpha)}"/>`);
    }
    for (const s of dn.strokes) {
      const d = linePath(s.points);
      if (d) parts.push(`<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${f(Math.max(1.2, dn.glowWidth * 0.16))}" opacity="${f(s.alpha)}" stroke-linecap="round" stroke-linejoin="round"/>`);
    }
    parts.push(`<circle cx="${f(dn.head.x)}" cy="${f(dn.head.y)}" r="${f(dn.head.r)}" fill="${dn.head.color}" opacity="${f(dn.head.alpha)}"/>`);
    const joints = dotsPath(dn.joints, Math.max(1.2, dn.head.r * 0.16));
    if (joints) parts.push(`<path d="${joints}" fill="${dn.jointColor}" opacity="${f(dn.alpha * 0.8)}"/>`);
  }

  const star = state.star;
  if (star.r > 0.5) {
    parts.push(`<circle cx="${f(star.x)}" cy="${f(star.y)}" r="${f(star.r)}" fill="url(#star)" opacity="${f(star.alpha)}"/>`);
  }

  parts.push("</svg>");
  return parts.join("");
}
