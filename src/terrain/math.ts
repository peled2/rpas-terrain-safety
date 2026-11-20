import type { BBox, ComputationEnvelope, GridMetrics } from './types';

export const FEET_TO_METERS = 0.3048;
export const METERS_TO_FEET = 1 / FEET_TO_METERS;
export const EARTH_CIRCUMFERENCE_METERS = 40075016.68557849;
export const TILE_SIZE = 256;
export const MAX_DEM_ZOOM = 15;
export const MIN_SUPPORTED_MAP_ZOOM = 8.5;
export const MAX_GRID_DIMENSION = 512;
export const MAX_TILES_PER_JOB = 20;

export function feetToMeters(feet: number): number {
  return feet * FEET_TO_METERS;
}

export function metersToFeet(meters: number): number {
  return meters * METERS_TO_FEET;
}

/**
 * Decodes AWS Mapzen Terrarium RGB elevation in meters.
 * Formula: (R * 256 + G + B / 256) - 32768
 */
export function terrariumToMeters(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768;
}

/**
 * Ground resolution in meters per Web Mercator tile pixel (256px tile) at latitude.
 */
export function metersPerTilePixel(lat: number, zoom: number): number {
  const clampedLat = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const latRad = (clampedLat * Math.PI) / 180;
  return (EARTH_CIRCUMFERENCE_METERS * Math.cos(latRad)) / (TILE_SIZE * Math.pow(2, zoom));
}

export function lonLatToTileFloat(lon: number, lat: number, zoom: number): [number, number] {
  const n = Math.pow(2, zoom);
  const clampedLat = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const latRad = (clampedLat * Math.PI) / 180;
  const x = ((lon + 180) / 360) * n;
  const y =
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  return [x, y];
}

export function tileFloatToLonLat(x: number, y: number, zoom: number): [number, number] {
  const n = Math.pow(2, zoom);
  const lon = (x / n) * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
  const lat = (latRad * 180) / Math.PI;
  return [lon, lat];
}

/**
 * Maps continuous map zoom to discrete DEM zoom tiers with hysteresis
 * so small zoom adjustments never thrash tile downloads or trigger recomputation.
 */
export function selectDemZoomTier(mapZoom: number, currentDemZoom: number | null): number | null {
  if (mapZoom < MIN_SUPPORTED_MAP_ZOOM) {
    return null;
  }

  if (currentDemZoom === 14) {
    if (mapZoom >= 12.2) return 14;
  } else if (currentDemZoom === 12) {
    if (mapZoom >= 13.0) return 14;
    if (mapZoom >= 10.2) return 12;
  } else if (currentDemZoom === 10) {
    if (mapZoom >= 13.0) return 14;
    if (mapZoom >= 11.0) return 12;
    if (mapZoom >= 8.5) return 10;
  }

  if (mapZoom >= 12.6) return 14;
  if (mapZoom >= 10.6) return 12;
  return 10;
}

/**
 * Expands a geographic bounding box by meters on all four sides.
 */
export function expandBBoxByMeters(bbox: BBox, meters: number): BBox {
  const centerLat = (bbox.north + bbox.south) / 2;
  const latDegPerMeter = 1 / 111320;
  const cosLat = Math.max(0.15, Math.cos((centerLat * Math.PI) / 180));
  const lonDegPerMeter = 1 / (111320 * cosLat);

  const dLat = meters * latDegPerMeter;
  const dLon = meters * lonDegPerMeter;

  return {
    west: Math.max(-180, bbox.west - dLon),
    south: Math.max(-85, bbox.south - dLat),
    east: Math.min(180, bbox.east + dLon),
    north: Math.min(85, bbox.north + dLat),
  };
}

/**
 * Builds a computation envelope around the viewport with overscan + safety-buffer padding.
 * Small pans/zooms inside safeInnerBounds avoid any recomputation.
 */
export function buildComputationEnvelope(
  viewport: BBox,
  demZoom: number,
  safetyRangeMeters: number,
  overscanRatio = 0.4,
): ComputationEnvelope {
  const lonSpan = Math.max(0.001, viewport.east - viewport.west);
  const latSpan = Math.max(0.001, viewport.north - viewport.south);

  const candidateRatios = [overscanRatio, 0.2, 0.1].filter(
    (r, idx, arr) => r > 0 && arr.indexOf(r) === idx,
  );

  for (const ratio of candidateRatios) {
    const overscanBounds: BBox = {
      west: Math.max(-180, viewport.west - lonSpan * ratio),
      south: Math.max(-85, viewport.south - latSpan * ratio),
      east: Math.min(180, viewport.east + lonSpan * ratio),
      north: Math.min(85, viewport.north + latSpan * ratio),
    };

    const paddedOverscan = expandBBoxByMeters(overscanBounds, safetyRangeMeters);
    const tileRange = computeTileRange(paddedOverscan, demZoom);
    const tileCount =
      (tileRange.maxTileX - tileRange.minTileX + 1) *
      (tileRange.maxTileY - tileRange.minTileY + 1);

    if (tileCount <= MAX_TILES_PER_JOB) {
      return {
        demZoom,
        fetchBounds: paddedOverscan,
        safeInnerBounds: overscanBounds,
        safetyRangeMeters,
      };
    }
  }

  // Fallback to tight viewport + safety padding, and resolve effective demZoom.
  const tightFetch = expandBBoxByMeters(viewport, safetyRangeMeters);
  const metrics = resolveGridMetrics(tightFetch, demZoom);
  return {
    demZoom: metrics.demZoom,
    fetchBounds: tightFetch,
    safeInnerBounds: viewport,
    safetyRangeMeters,
  };
}

export function isViewportInsideBounds(viewport: BBox, outer: BBox): boolean {
  return (
    viewport.west >= outer.west &&
    viewport.east <= outer.east &&
    viewport.south >= outer.south &&
    viewport.north <= outer.north
  );
}

export function computeTileRange(
  bounds: BBox,
  demZoom: number,
): { minTileX: number; maxTileX: number; minTileY: number; maxTileY: number } {
  const maxIndex = Math.pow(2, demZoom) - 1;
  const [x1, y1] = lonLatToTileFloat(bounds.west, bounds.north, demZoom);
  const [x2, y2] = lonLatToTileFloat(bounds.east, bounds.south, demZoom);

  const minTileX = Math.max(0, Math.min(maxIndex, Math.floor(x1)));
  const maxTileX = Math.max(minTileX, Math.min(maxIndex, Math.floor(x2)));
  const minTileY = Math.max(0, Math.min(maxIndex, Math.floor(y1)));
  const maxTileY = Math.max(minTileY, Math.min(maxIndex, Math.floor(y2)));

  return { minTileX, maxTileX, minTileY, maxTileY };
}

/**
 * Computes grid dimensions and stride so the worker grid stays <= MAX_GRID_DIMENSION.
 * Automatically lowers demZoom if a huge viewport + safety buffer exceeds MAX_TILES_PER_JOB.
 */
export function resolveGridMetrics(bounds: BBox, requestedDemZoom: number): GridMetrics {
  let demZoom = requestedDemZoom;
  let range = computeTileRange(bounds, demZoom);

  while (
    demZoom > 8 &&
    (range.maxTileX - range.minTileX + 1) * (range.maxTileY - range.minTileY + 1) >
      MAX_TILES_PER_JOB
  ) {
    demZoom -= 1;
    range = computeTileRange(bounds, demZoom);
  }

  const tilesX = range.maxTileX - range.minTileX + 1;
  const tilesY = range.maxTileY - range.minTileY + 1;
  const rawWidth = tilesX * TILE_SIZE;
  const rawHeight = tilesY * TILE_SIZE;

  const maxRaw = Math.max(rawWidth, rawHeight);
  const stride = Math.max(1, Math.ceil(maxRaw / MAX_GRID_DIMENSION));
  const width = Math.floor(rawWidth / stride);
  const height = Math.floor(rawHeight / stride);

  const centerLat = (bounds.north + bounds.south) / 2;
  const metersPerGridPixel = metersPerTilePixel(centerLat, demZoom) * stride;

  return {
    demZoom,
    minTileX: range.minTileX,
    maxTileX: range.maxTileX,
    minTileY: range.minTileY,
    maxTileY: range.maxTileY,
    stride,
    width,
    height,
    metersPerGridPixel,
  };
}

export function gridPointToLonLat(
  gx: number,
  gy: number,
  metrics: GridMetrics,
): [number, number] {
  const tileX = metrics.minTileX + (gx * metrics.stride) / TILE_SIZE;
  const tileY = metrics.minTileY + (gy * metrics.stride) / TILE_SIZE;
  return tileFloatToLonLat(tileX, tileY, metrics.demZoom);
}

/**
 * Bilinear interpolation on a 256x256 tile elevation buffer.
 */
export function sampleTileBilinear(
  tileData: Float32Array,
  fracPixelX: number,
  fracPixelY: number,
): number {
  const x0 = Math.max(0, Math.min(TILE_SIZE - 1, Math.floor(fracPixelX)));
  const y0 = Math.max(0, Math.min(TILE_SIZE - 1, Math.floor(fracPixelY)));
  const x1 = Math.min(TILE_SIZE - 1, x0 + 1);
  const y1 = Math.min(TILE_SIZE - 1, y0 + 1);

  const dx = Math.max(0, Math.min(1, fracPixelX - x0));
  const dy = Math.max(0, Math.min(1, fracPixelY - y0));

  const v00 = tileData[y0 * TILE_SIZE + x0];
  const v10 = tileData[y0 * TILE_SIZE + x1];
  const v01 = tileData[y1 * TILE_SIZE + x0];
  const v11 = tileData[y1 * TILE_SIZE + x1];

  const top = v00 * (1 - dx) + v10 * dx;
  const bottom = v01 * (1 - dx) + v11 * dx;
  return top * (1 - dy) + bottom * dy;
}
