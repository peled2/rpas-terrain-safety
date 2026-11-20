export type BaseMapStyle = 'satellite' | 'topo';

export type SafetyUnit = 'm' | 'km';

export interface BBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface GridMetrics {
  demZoom: number;
  minTileX: number;
  maxTileX: number;
  minTileY: number;
  maxTileY: number;
  stride: number;
  width: number;
  height: number;
  metersPerGridPixel: number;
}

export interface ComputationEnvelope {
  demZoom: number;
  fetchBounds: BBox;
  safeInnerBounds: BBox;
  safetyRangeMeters: number;
}

export interface TerrainComputeRequest {
  type: 'compute';
  jobId: number;
  fetchBounds: BBox;
  demZoom: number;
  altitudeFeet: number;
  safetyRangeMeters: number;
}

export interface TerrainProbeRequest {
  type: 'probe';
  probeId: number;
  lon: number;
  lat: number;
  demZoom: number;
}

export type WorkerInboundMessage = TerrainComputeRequest | TerrainProbeRequest;

export interface TerrainComputeResult {
  type: 'compute-result';
  jobId: number;
  contourGeoJson: GeoJSON.FeatureCollection<GeoJSON.LineString>;
  safetyFillGeoJson: GeoJSON.FeatureCollection<GeoJSON.MultiPolygon | GeoJSON.Polygon>;
  safetyOutlineGeoJson: GeoJSON.FeatureCollection<GeoJSON.LineString>;
  resolutionMetersPerPx: number;
  computeTimeMs: number;
  tileCount: number;
  hasIntersections: boolean;
  error?: string;
}

export interface TerrainProbeResult {
  type: 'probe-result';
  probeId: number;
  lon: number;
  lat: number;
  elevationMeters: number | null;
  elevationFeet: number | null;
}

export type WorkerOutboundMessage = TerrainComputeResult | TerrainProbeResult;

export interface ElevationProbe {
  lon: number;
  lat: number;
  elevationMeters: number;
  elevationFeet: number;
}
