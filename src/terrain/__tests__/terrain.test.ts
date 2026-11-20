import { describe, expect, it } from 'vitest';
import {
  computeEuclideanDistanceField,
  extractIsoLines,
  extractSafetyFillGeoJson,
} from '../algorithms';
import {
  buildComputationEnvelope,
  feetToMeters,
  isViewportInsideBounds,
  lonLatToTileFloat,
  metersPerTilePixel,
  resolveGridMetrics,
  selectDemZoomTier,
  terrariumToMeters,
  tileFloatToLonLat,
} from '../math';

describe('terrain math', () => {
  it('decodes Terrarium RGB values accurately', () => {
    expect(terrariumToMeters(128, 0, 0)).toBeCloseTo(0, 6);
    expect(terrariumToMeters(126, 100, 0)).toBeCloseTo(-412, 6);
    expect(terrariumToMeters(136, 172, 128)).toBeCloseTo(2220.5, 6);
  });

  it('round-trips lon/lat through Web Mercator tile coordinates', () => {
    const lon = 35.75;
    const lat = 33.15;
    const [tx, ty] = lonLatToTileFloat(lon, lat, 12);
    const [rLon, rLat] = tileFloatToLonLat(tx, ty, 12);
    expect(rLon).toBeCloseTo(lon, 6);
    expect(rLat).toBeCloseTo(lat, 6);
  });

  it('scales meters per pixel by cos(latitude)', () => {
    const eq = metersPerTilePixel(0, 12);
    const northIsrael = metersPerTilePixel(33, 12);
    expect(northIsrael / eq).toBeCloseTo(Math.cos((33 * Math.PI) / 180), 5);
  });

  it('applies zoom tier hysteresis to prevent thrashing on small zoom changes', () => {
    expect(selectDemZoomTier(8.0, null)).toBeNull();
    expect(selectDemZoomTier(11.0, null)).toBe(12);
    // Gentle zoom from 12.4 to 12.6 stays on tier 12 until 13.0
    expect(selectDemZoomTier(12.6, 12)).toBe(12);
    expect(selectDemZoomTier(13.1, 12)).toBe(14);
    // Gentle zoom out from 13.1 to 12.2 stays on tier 14 until 12.2
    expect(selectDemZoomTier(12.2, 14)).toBe(14);
    expect(selectDemZoomTier(12.1, 14)).toBe(12);
  });

  it('builds overscan computation envelope covering small pans without recompute', () => {
    const viewport = { west: 35.65, south: 33.05, east: 35.79, north: 33.19 };
    const env = buildComputationEnvelope(viewport, 12, 1000);
    expect(isViewportInsideBounds(viewport, env.safeInnerBounds)).toBe(true);

    // Small pan inside overscan margin
    const smallPan = { west: 35.665, south: 33.065, east: 35.805, north: 33.205 };
    expect(isViewportInsideBounds(smallPan, env.safeInnerBounds)).toBe(true);

    // Large pan outside overscan margin
    const largePan = { west: 36.1, south: 33.0, east: 36.3, north: 33.2 };
    expect(isViewportInsideBounds(largePan, env.safeInnerBounds)).toBe(false);

    // fetchBounds must include safety buffer outside safeInnerBounds
    expect(env.fetchBounds.west).toBeLessThan(env.safeInnerBounds.west);
    expect(env.fetchBounds.east).toBeGreaterThan(env.safeInnerBounds.east);
    expect(env.fetchBounds.north).toBeGreaterThan(env.safeInnerBounds.north);
    expect(env.fetchBounds.south).toBeLessThan(env.safeInnerBounds.south);
  });
});

describe('terrain algorithms (EDT + Marching Squares)', () => {
  it('computes exact 2D Euclidean distances from thresholded mountain cells', () => {
    const w = 11;
    const h = 11;
    const elev = new Float32Array(w * h).fill(100);
    // Single mountain peak cell at (5, 5) above threshold 500m
    elev[5 * w + 5] = 600;

    const { distPx, hasFeature } = computeEuclideanDistanceField(elev, w, h, 500);
    expect(hasFeature).toBe(true);
    expect(distPx[5 * w + 5]).toBe(0);
    expect(distPx[5 * w + 8]).toBeCloseTo(3, 5);
    expect(distPx[9 * w + 8]).toBeCloseTo(5, 5); // 3-4-5 right triangle
  });

  it('extracts closed contour loop and expanded safety polygon without edge artifacts', () => {
    const w = 64;
    const h = 64;
    const elev = new Float32Array(w * h);
    const cx = 32;
    const cy = 32;

    // Cone mountain centered at (32, 32): peak 1200m, drops 30m per pixel
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const r = Math.hypot(x - cx, y - cy);
        elev[y * w + x] = 1200 - r * 30;
      }
    }

    const thresholdMeters = feetToMeters(3000); // 914.4m -> radius ~9.52 px
    const lines = extractIsoLines(elev, w, h, thresholdMeters, 0.1);
    expect(lines.length).toBe(1);
    const ring = lines[0];
    expect(ring[0][0]).toBeCloseTo(ring[ring.length - 1][0], 4);
    expect(ring[0][1]).toBeCloseTo(ring[ring.length - 1][1], 4);

    // Every point on the contour must lie ~9.52 px from center (32.5, 32.5)
    for (const [px, py] of ring) {
      const distFromPeak = Math.hypot(px - (cx + 0.5), py - (cy + 0.5));
      expect(distFromPeak).toBeGreaterThan(8.5);
      expect(distFromPeak).toBeLessThan(10.5);
    }

    // Distance field + 6 px safety buffer -> outer outline around ~15.5 px
    const { distPx } = computeEuclideanDistanceField(elev, w, h, thresholdMeters);
    const safetyOutline = extractIsoLines(distPx, w, h, 6, 0.1);
    expect(safetyOutline.length).toBe(1);
    for (const [px, py] of safetyOutline[0]) {
      const distFromPeak = Math.hypot(px - (cx + 0.5), py - (cy + 0.5));
      expect(distFromPeak).toBeGreaterThan(14.5);
      expect(distFromPeak).toBeLessThan(16.8);
    }

    const metrics = resolveGridMetrics(
      { west: 35.7, south: 33.1, east: 35.8, north: 33.2 },
      12,
    );
    const safetyFill = extractSafetyFillGeoJson(distPx, { ...metrics, width: w, height: h }, 6);
    expect(safetyFill.features.length).toBe(1);
    expect(safetyFill.features[0].geometry.coordinates.length).toBe(1);
  });
});
