import {
  computeEuclideanDistanceField,
  extractIsoLines,
  extractSafetyFillGeoJson,
  isoLinesToGeoJson,
} from './algorithms';
import {
  feetToMeters,
  lonLatToTileFloat,
  metersToFeet,
  resolveGridMetrics,
  sampleTileBilinear,
  terrariumToMeters,
  TILE_SIZE,
} from './math';
import type {
  TerrainComputeRequest,
  TerrainComputeResult,
  TerrainProbeRequest,
  TerrainProbeResult,
  WorkerInboundMessage,
} from './types';

const TERRARIUM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
const MAX_CACHED_TILES = 240;

const tileCache = new Map<string, Float32Array>();
let activeComputeAbort: AbortController | null = null;
let activeProbeAbort: AbortController | null = null;
let latestComputeJobId = 0;

function getTileFromCache(key: string): Float32Array | undefined {
  const existing = tileCache.get(key);
  if (existing) {
    // Refresh LRU order
    tileCache.delete(key);
    tileCache.set(key, existing);
  }
  return existing;
}

function putTileInCache(key: string, data: Float32Array): void {
  if (tileCache.has(key)) {
    tileCache.delete(key);
  }
  tileCache.set(key, data);
  while (tileCache.size > MAX_CACHED_TILES) {
    const oldestKey = tileCache.keys().next().value;
    if (oldestKey !== undefined) {
      tileCache.delete(oldestKey);
    } else {
      break;
    }
  }
}

const FETCH_TIMEOUT_MS = 12000;

async function fetchTerrariumTile(
  z: number,
  x: number,
  y: number,
  signal: AbortSignal,
): Promise<Float32Array> {
  const key = `${z}/${x}/${y}`;
  const cached = getTileFromCache(key);
  if (cached) return cached;

  const url = `${TERRARIUM_URL}/${z}/${x}/${y}.png`;
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), FETCH_TIMEOUT_MS);
  const onParentAbort = () => timeoutController.abort();
  signal.addEventListener('abort', onParentAbort, { once: true });

  let response: Response;
  try {
    response = await fetch(url, { mode: 'cors', signal: timeoutController.signal });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onParentAbort);
  }

  if (response.status === 404) {
    // Ocean / out-of-coverage Terrarium tile defaults to sea level (0m)
    const zeroTile = new Float32Array(TILE_SIZE * TILE_SIZE);
    putTileInCache(key, zeroTile);
    return zeroTile;
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} loading DEM tile ${key}`);
  }

  const blob = await response.blob();
  if (signal.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bitmap.close();
    throw new Error('Failed to acquire 2D context on OffscreenCanvas');
  }

  ctx.drawImage(bitmap, 0, 0, TILE_SIZE, TILE_SIZE);
  bitmap.close();

  const rgba = ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data;
  const elevations = new Float32Array(TILE_SIZE * TILE_SIZE);
  for (let i = 0; i < elevations.length; i++) {
    const offset = i * 4;
    elevations[i] = terrariumToMeters(rgba[offset], rgba[offset + 1], rgba[offset + 2]);
  }

  putTileInCache(key, elevations);
  return elevations;
}

async function fetchTilesWithConcurrency(
  coords: Array<{ z: number; x: number; y: number }>,
  signal: AbortSignal,
  concurrency = 10,
): Promise<Map<string, Float32Array>> {
  const result = new Map<string, Float32Array>();
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < coords.length) {
      if (signal.aborted) return;
      const item = coords[cursor++];
      const key = `${item.z}/${item.x}/${item.y}`;
      const data = await fetchTerrariumTile(item.z, item.x, item.y, signal);
      result.set(key, data);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, coords.length) }, () => worker());
  await Promise.all(workers);
  return result;
}

async function handleCompute(req: TerrainComputeRequest): Promise<void> {
  latestComputeJobId = req.jobId;
  if (activeComputeAbort) {
    activeComputeAbort.abort();
  }
  const abortController = new AbortController();
  activeComputeAbort = abortController;

  const tStart = performance.now();

  try {
    const metrics = resolveGridMetrics(req.fetchBounds, req.demZoom);
    const tileCoords: Array<{ z: number; x: number; y: number }> = [];
    for (let ty = metrics.minTileY; ty <= metrics.maxTileY; ty++) {
      for (let tx = metrics.minTileX; tx <= metrics.maxTileX; tx++) {
        tileCoords.push({ z: metrics.demZoom, x: tx, y: ty });
      }
    }

    const tiles = await fetchTilesWithConcurrency(tileCoords, abortController.signal);
    if (abortController.signal.aborted || req.jobId !== latestComputeJobId) {
      return;
    }

    const { width, height, stride, minTileX, minTileY, demZoom } = metrics;
    const elevations = new Float32Array(width * height);
    const sampleOffset = Math.floor(stride / 2);

    for (let gy = 0; gy < height; gy++) {
      const globalPy = gy * stride + sampleOffset;
      const ty = minTileY + Math.floor(globalPy / TILE_SIZE);
      const localPy = globalPy % TILE_SIZE;
      const rowOut = gy * width;
      const rowTile = localPy * TILE_SIZE;

      for (let gx = 0; gx < width; gx++) {
        const globalPx = gx * stride + sampleOffset;
        const tx = minTileX + Math.floor(globalPx / TILE_SIZE);
        const localPx = globalPx % TILE_SIZE;
        const tile = tiles.get(`${demZoom}/${tx}/${ty}`);
        elevations[rowOut + gx] = tile ? tile[rowTile + localPx] : -32768;
      }
    }

    const targetMeters = feetToMeters(req.altitudeFeet);

    // 1. Continuous red contour line along every mountain intersecting target altitude
    const contourLines = extractIsoLines(elevations, width, height, targetMeters, 0.35);
    const contourGeoJson = isoLinesToGeoJson(contourLines, metrics);

    // 2. 2D Euclidean Distance Transform from all cells >= targetMeters
    const { distPx, hasFeature } = computeEuclideanDistanceField(
      elevations,
      width,
      height,
      targetMeters,
    );

    let safetyFillGeoJson: GeoJSON.FeatureCollection<GeoJSON.MultiPolygon> = {
      type: 'FeatureCollection',
      features: [],
    };
    let safetyOutlineGeoJson: GeoJSON.FeatureCollection<GeoJSON.LineString> = {
      type: 'FeatureCollection',
      features: [],
    };

    if (hasFeature) {
      const rawRadiusPx = req.safetyRangeMeters / metrics.metersPerGridPixel;
      safetyFillGeoJson = extractSafetyFillGeoJson(distPx, metrics, rawRadiusPx);

      if (req.safetyRangeMeters > 0) {
        const outlineThresholdPx = Math.max(0.25, rawRadiusPx);
        const outlineLines = extractIsoLines(distPx, width, height, outlineThresholdPx, 0.45);
        safetyOutlineGeoJson = isoLinesToGeoJson(outlineLines, metrics);
      }
    }

    if (abortController.signal.aborted || req.jobId !== latestComputeJobId) {
      return;
    }

    const result: TerrainComputeResult = {
      type: 'compute-result',
      jobId: req.jobId,
      contourGeoJson,
      safetyFillGeoJson,
      safetyOutlineGeoJson,
      resolutionMetersPerPx: metrics.metersPerGridPixel,
      computeTimeMs: Math.round(performance.now() - tStart),
      tileCount: tileCoords.length,
      hasIntersections: hasFeature,
    };

    self.postMessage(result);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return;
    }
    if (req.jobId !== latestComputeJobId) {
      return;
    }
    const result: TerrainComputeResult = {
      type: 'compute-result',
      jobId: req.jobId,
      contourGeoJson: { type: 'FeatureCollection', features: [] },
      safetyFillGeoJson: { type: 'FeatureCollection', features: [] },
      safetyOutlineGeoJson: { type: 'FeatureCollection', features: [] },
      resolutionMetersPerPx: 0,
      computeTimeMs: Math.round(performance.now() - tStart),
      tileCount: 0,
      hasIntersections: false,
      error: err instanceof Error ? err.message : 'שגיאה בחישוב נתוני השטח',
    };
    self.postMessage(result);
  }
}

async function handleProbe(req: TerrainProbeRequest): Promise<void> {
  if (activeProbeAbort) {
    activeProbeAbort.abort();
  }
  const abortController = new AbortController();
  activeProbeAbort = abortController;

  const z = Math.max(10, Math.min(14, req.demZoom));
  const [txFloat, tyFloat] = lonLatToTileFloat(req.lon, req.lat, z);
  const tx = Math.floor(txFloat);
  const ty = Math.floor(tyFloat);
  const fracX = (txFloat - tx) * TILE_SIZE - 0.5;
  const fracY = (tyFloat - ty) * TILE_SIZE - 0.5;

  try {
    const tile = await fetchTerrariumTile(z, tx, ty, abortController.signal);
    if (abortController.signal.aborted) return;

    const elevationMeters = sampleTileBilinear(tile, fracX, fracY);
    const result: TerrainProbeResult = {
      type: 'probe-result',
      probeId: req.probeId,
      lon: req.lon,
      lat: req.lat,
      elevationMeters,
      elevationFeet: metersToFeet(elevationMeters),
    };
    self.postMessage(result);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return;
    }
    const result: TerrainProbeResult = {
      type: 'probe-result',
      probeId: req.probeId,
      lon: req.lon,
      lat: req.lat,
      elevationMeters: null,
      elevationFeet: null,
    };
    self.postMessage(result);
  }
}

self.onmessage = (event: MessageEvent<WorkerInboundMessage>) => {
  const msg = event.data;
  if (msg.type === 'compute') {
    void handleCompute(msg);
  } else if (msg.type === 'probe') {
    void handleProbe(msg);
  }
};
