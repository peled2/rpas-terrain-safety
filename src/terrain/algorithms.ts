import { contours } from 'd3-contour';
import { gridPointToLonLat } from './math';
import type { GridMetrics } from './types';

const INF = 1e20;

/**
 * 1D squared Euclidean distance transform (Felzenszwalb & Huttenlocher, 2012).
 * Operates in O(n) time without heap allocations inside the inner loop when buffers are reused.
 */
function edt1d(
  f: Float32Array,
  n: number,
  d: Float32Array,
  v: Int32Array,
  z: Float32Array,
): void {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;

  for (let q = 1; q < n; q++) {
    let s = 0;
    while (true) {
      const r = v[k];
      s = (f[q] + q * q - (f[r] + r * r)) / (2 * q - 2 * r);
      if (s <= z[k]) {
        k--;
      } else {
        break;
      }
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }

  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) {
      k++;
    }
    const r = v[k];
    const diff = q - r;
    d[q] = diff * diff + f[r];
  }
}

/**
 * Computes exact 2D Euclidean distance (in grid pixels) from every cell to the nearest cell
 * where elevations[i] >= threshold. Cells >= threshold get distance 0.
 */
export function computeEuclideanDistanceField(
  elevations: Float32Array,
  width: number,
  height: number,
  threshold: number,
): { distPx: Float32Array; hasFeature: boolean } {
  const total = width * height;
  const distSq = new Float32Array(total);
  let hasFeature = false;

  for (let i = 0; i < total; i++) {
    if (elevations[i] >= threshold) {
      distSq[i] = 0;
      hasFeature = true;
    } else {
      distSq[i] = INF;
    }
  }

  if (!hasFeature) {
    return { distPx: distSq, hasFeature: false };
  }

  const maxDim = Math.max(width, height);
  const f = new Float32Array(maxDim);
  const d = new Float32Array(maxDim);
  const v = new Int32Array(maxDim);
  const z = new Float32Array(maxDim + 1);

  // Column pass
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      f[y] = distSq[y * width + x];
    }
    edt1d(f, height, d, v, z);
    for (let y = 0; y < height; y++) {
      distSq[y * width + x] = d[y];
    }
  }

  // Row pass
  for (let y = 0; y < height; y++) {
    const rowOffset = y * width;
    for (let x = 0; x < width; x++) {
      f[x] = distSq[rowOffset + x];
    }
    edt1d(f, width, d, v, z);
    for (let x = 0; x < width; x++) {
      distSq[rowOffset + x] = Math.sqrt(d[x]);
    }
  }

  return { distPx: distSq, hasFeature: true };
}

function perpendicularDistance(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (dx === 0 && dy === 0) {
    return Math.hypot(px - x1, py - y1);
  }
  const num = Math.abs(dy * px - dx * py + x2 * y1 - y2 * x1);
  return num / Math.hypot(dx, dy);
}

/**
 * Ramer-Douglas-Peucker simplification in grid pixel space.
 */
export function simplifyPolyline(
  points: [number, number][],
  tolerance: number,
): [number, number][] {
  if (points.length <= 2 || tolerance <= 0) {
    return points;
  }

  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [start, end] = stack.pop()!;
    if (end - start <= 1) continue;

    let maxDist = 0;
    let maxIdx = -1;
    const [x1, y1] = points[start];
    const [x2, y2] = points[end];

    for (let i = start + 1; i < end; i++) {
      const dist = perpendicularDistance(points[i][0], points[i][1], x1, y1, x2, y2);
      if (dist > maxDist) {
        maxDist = dist;
        maxIdx = i;
      }
    }

    if (maxDist > tolerance && maxIdx !== -1) {
      keep[maxIdx] = 1;
      stack.push([start, maxIdx], [maxIdx, end]);
    }
  }

  const result: [number, number][] = [];
  for (let i = 0; i < points.length; i++) {
    if (keep[i]) result.push(points[i]);
  }
  return result;
}

function interp(a: number, b: number, threshold: number): number {
  const denom = b - a;
  if (Math.abs(denom) < 1e-9) return 0.5;
  return Math.max(0, Math.min(1, (threshold - a) / denom));
}

/**
 * Marching Squares iso-line extractor with exact topological edge-key chaining.
 * Unlike polygon contours, this produces ONLY true iso-crossing lines without
 * artificial lines along the bounding box edges.
 */
export function extractIsoLines(
  values: Float32Array,
  width: number,
  height: number,
  threshold: number,
  simplifyTolerancePx = 0.35,
): [number, number][][] {
  if (width < 2 || height < 2) return [];

  // Unique integer edge key:
  // Edge is either Top (horizontal between (i, j) and (i+1, j)) -> type 0
  // or Left (vertical between (i, j) and (i, j+1)) -> type 1
  const stride = width + 1;
  const edgeKeyH = (col: number, row: number): number => (row * stride + col) * 2;
  const edgeKeyV = (col: number, row: number): number => (row * stride + col) * 2 + 1;

  const edgePoints = new Map<number, [number, number]>();
  const adj = new Map<number, number[]>();

  const addSeg = (k1: number, p1: [number, number], k2: number, p2: [number, number]) => {
    if (!edgePoints.has(k1)) edgePoints.set(k1, p1);
    if (!edgePoints.has(k2)) edgePoints.set(k2, p2);

    let list1 = adj.get(k1);
    if (!list1) {
      list1 = [];
      adj.set(k1, list1);
    }
    list1.push(k2);

    let list2 = adj.get(k2);
    if (!list2) {
      list2 = [];
      adj.set(k2, list2);
    }
    list2.push(k1);
  };

  for (let j = 0; j < height - 1; j++) {
    const row0 = j * width;
    const row1 = (j + 1) * width;

    for (let i = 0; i < width - 1; i++) {
      const v0 = values[row0 + i]; // top-left
      const v1 = values[row0 + i + 1]; // top-right
      const v2 = values[row1 + i + 1]; // bottom-right
      const v3 = values[row1 + i]; // bottom-left

      const b0 = v0 >= threshold ? 8 : 0;
      const b1 = v1 >= threshold ? 4 : 0;
      const b2 = v2 >= threshold ? 2 : 0;
      const b3 = v3 >= threshold ? 1 : 0;
      const code = b0 | b1 | b2 | b3;

      if (code === 0 || code === 15) continue;

      const topPt = (): [number, number] => [i + 0.5 + interp(v0, v1, threshold), j + 0.5];
      const rightPt = (): [number, number] => [i + 1.5, j + 0.5 + interp(v1, v2, threshold)];
      const bottomPt = (): [number, number] => [i + 0.5 + interp(v3, v2, threshold), j + 1.5];
      const leftPt = (): [number, number] => [i + 0.5, j + 0.5 + interp(v0, v3, threshold)];

      const kTop = edgeKeyH(i, j);
      const kRight = edgeKeyV(i + 1, j);
      const kBottom = edgeKeyH(i, j + 1);
      const kLeft = edgeKeyV(i, j);

      switch (code) {
        case 1:
        case 14:
          addSeg(kLeft, leftPt(), kBottom, bottomPt());
          break;
        case 2:
        case 13:
          addSeg(kBottom, bottomPt(), kRight, rightPt());
          break;
        case 3:
        case 12:
          addSeg(kLeft, leftPt(), kRight, rightPt());
          break;
        case 4:
        case 11:
          addSeg(kTop, topPt(), kRight, rightPt());
          break;
        case 6:
        case 9:
          addSeg(kTop, topPt(), kBottom, bottomPt());
          break;
        case 7:
        case 8:
          addSeg(kLeft, leftPt(), kTop, topPt());
          break;
        case 5: {
          const center = 0.25 * (v0 + v1 + v2 + v3);
          if (center >= threshold) {
            addSeg(kLeft, leftPt(), kBottom, bottomPt());
            addSeg(kTop, topPt(), kRight, rightPt());
          } else {
            addSeg(kLeft, leftPt(), kTop, topPt());
            addSeg(kBottom, bottomPt(), kRight, rightPt());
          }
          break;
        }
        case 10: {
          const center = 0.25 * (v0 + v1 + v2 + v3);
          if (center >= threshold) {
            addSeg(kLeft, leftPt(), kTop, topPt());
            addSeg(kBottom, bottomPt(), kRight, rightPt());
          } else {
            addSeg(kLeft, leftPt(), kBottom, bottomPt());
            addSeg(kTop, topPt(), kRight, rightPt());
          }
          break;
        }
      }
    }
  }

  // Chain connected segments into continuous polylines
  const visitedEdges = new Set<string>();
  const segId = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);
  const polylines: [number, number][][] = [];

  const traceFrom = (startKey: number, firstNeighbor: number, closeLoop: boolean) => {
    const chain: [number, number][] = [];
    const pStart = edgePoints.get(startKey);
    if (!pStart) return;
    chain.push(pStart);

    let prev = startKey;
    let curr = firstNeighbor;
    visitedEdges.add(segId(prev, curr));

    while (true) {
      const pt = edgePoints.get(curr);
      if (pt) chain.push(pt);

      if (curr === startKey && closeLoop) {
        break;
      }

      const neighbors = adj.get(curr);
      if (!neighbors) break;

      let next: number | null = null;
      for (const n of neighbors) {
        if (!visitedEdges.has(segId(curr, n))) {
          next = n;
          break;
        }
      }
      if (next === null) break;

      visitedEdges.add(segId(curr, next));
      prev = curr;
      curr = next;
    }

    if (chain.length >= 2) {
      const isClosed =
        chain.length >= 4 &&
        chain[0][0] === chain[chain.length - 1][0] &&
        chain[0][1] === chain[chain.length - 1][1];

      if (isClosed) {
        const simplified = simplifyPolyline(chain.slice(0, -1), simplifyTolerancePx);
        if (simplified.length >= 3) {
          simplified.push(simplified[0]);
          polylines.push(simplified);
        }
      } else {
        const simplified = simplifyPolyline(chain, simplifyTolerancePx);
        if (simplified.length >= 2) {
          polylines.push(simplified);
        }
      }
    }
  };

  // Pass 1: Trace open paths starting from degree-1 (or odd-degree) endpoints
  for (const [key, neighbors] of adj.entries()) {
    if (neighbors.length === 1) {
      const n = neighbors[0];
      if (!visitedEdges.has(segId(key, n))) {
        traceFrom(key, n, false);
      }
    }
  }

  // Pass 2: Trace closed loops
  for (const [key, neighbors] of adj.entries()) {
    for (const n of neighbors) {
      if (!visitedEdges.has(segId(key, n))) {
        traceFrom(key, n, true);
      }
    }
  }

  return polylines;
}

export function isoLinesToGeoJson(
  polylines: [number, number][][],
  metrics: GridMetrics,
): GeoJSON.FeatureCollection<GeoJSON.LineString> {
  const features: GeoJSON.Feature<GeoJSON.LineString>[] = polylines.map((line) => ({
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'LineString',
      coordinates: line.map(([gx, gy]) => gridPointToLonLat(gx, gy, metrics)),
    },
  }));

  return {
    type: 'FeatureCollection',
    features,
  };
}

/**
 * Extracts merged GeoJSON MultiPolygon/Polygon representing all terrain >= target
 * plus the safety buffer zone (where distPx <= safetyRadiusPx).
 */
export function extractSafetyFillGeoJson(
  distPx: Float32Array,
  metrics: GridMetrics,
  safetyRadiusPx: number,
): GeoJSON.FeatureCollection<GeoJSON.MultiPolygon> {
  const { width, height } = metrics;
  // Negate distance so inside safety zone is >= -safetyRadiusPx.
  // Adding +1e-4 ensures exact 0-distance mountain cells are always strictly >= threshold even when safetyRadiusPx === 0.
  const score = new Float32Array(distPx.length);
  const effectiveRadius = Math.max(0.05, safetyRadiusPx);
  for (let i = 0; i < distPx.length; i++) {
    score[i] = effectiveRadius - distPx[i];
  }

  const generator = contours().size([width, height]).smooth(true).thresholds([0]);
  const generated = generator(score as unknown as number[]);

  const features: GeoJSON.Feature<GeoJSON.MultiPolygon>[] = [];
  for (const multiPoly of generated) {
    if (!multiPoly.coordinates || multiPoly.coordinates.length === 0) continue;

    const projectedCoordinates = multiPoly.coordinates.map((polygon) =>
      polygon.map((ring) => {
        const simplified = simplifyPolyline(
          ring.slice(0, -1) as [number, number][],
          0.45,
        );
        const closed = simplified.length >= 3 ? [...simplified, simplified[0]] : ring;
        return closed.map(([gx, gy]) => gridPointToLonLat(gx, gy, metrics));
      }),
    );

    features.push({
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'MultiPolygon',
        coordinates: projectedCoordinates,
      },
    });
  }

  return {
    type: 'FeatureCollection',
    features,
  };
}
