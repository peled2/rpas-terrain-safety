import { useCallback, useEffect, useRef } from 'react';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import {
  buildComputationEnvelope,
  expandBBoxByMeters,
  isViewportInsideBounds,
  selectDemZoomTier,
} from '../terrain/math';
import { TerrainClient } from '../terrain/terrainClient';
import type {
  BaseMapStyle,
  BBox,
  ComputationEnvelope,
  ElevationProbe,
  TerrainComputeResult,
} from '../terrain/types';

export interface ComputeStats {
  isComputing: boolean;
  zoomTooLow: boolean;
  resolutionMetersPerPx: number | null;
  computeTimeMs: number | null;
  tileCount: number | null;
  hasIntersections: boolean | null;
  error: string | null;
}

interface TerrainMapProps {
  altitudeFeet: number;
  safetyRangeMeters: number;
  baseMap: BaseMapStyle;
  isAreaLocked: boolean;
  onStatsChange: (stats: ComputeStats) => void;
  onProbeChange: (probe: ElevationProbe | null) => void;
}

const EMPTY_LINES: GeoJSON.FeatureCollection<GeoJSON.LineString> = {
  type: 'FeatureCollection',
  features: [],
};

const EMPTY_POLYGONS: GeoJSON.FeatureCollection<GeoJSON.MultiPolygon> = {
  type: 'FeatureCollection',
  features: [],
};

function mapBoundsToBBox(bounds: maplibregl.LngLatBounds): BBox {
  return {
    west: bounds.getWest(),
    south: bounds.getSouth(),
    east: bounds.getEast(),
    north: bounds.getNorth(),
  };
}

function bboxToGeoJson(bbox: BBox): GeoJSON.FeatureCollection<GeoJSON.LineString> {
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'LineString',
          coordinates: [
            [bbox.west, bbox.south],
            [bbox.east, bbox.south],
            [bbox.east, bbox.north],
            [bbox.west, bbox.north],
            [bbox.west, bbox.south],
          ],
        },
      },
    ],
  };
}

export function TerrainMap({
  altitudeFeet,
  safetyRangeMeters,
  baseMap,
  isAreaLocked,
  onStatsChange,
  onProbeChange,
}: TerrainMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const clientRef = useRef<TerrainClient | null>(null);
  const mapLoadedRef = useRef(false);

  const altitudeRef = useRef(altitudeFeet);
  const safetyRef = useRef(safetyRangeMeters);
  const lockedRef = useRef(isAreaLocked);
  const baseMapRef = useRef(baseMap);
  const envelopeRef = useRef<ComputationEnvelope | null>(null);
  const latestRequestedJobIdRef = useRef(0);
  const debounceTimerRef = useRef<number | null>(null);
  const probeTimerRef = useRef<number>(0);

  const onStatsRef = useRef(onStatsChange);
  const onProbeRef = useRef(onProbeChange);

  useEffect(() => {
    onStatsRef.current = onStatsChange;
  }, [onStatsChange]);

  useEffect(() => {
    onProbeRef.current = onProbeChange;
  }, [onProbeChange]);

  const triggerCompute = useCallback((forceRebuildEnvelope: boolean) => {
    const map = mapRef.current;
    const client = clientRef.current;
    if (!map || !client || !mapLoadedRef.current) return;

    const mapZoom = map.getZoom();
    const viewport = mapBoundsToBBox(map.getBounds());
    const currentEnv = envelopeRef.current;

    if (lockedRef.current && currentEnv && !forceRebuildEnvelope) {
      return;
    }

    const demZoom =
      lockedRef.current && currentEnv
        ? currentEnv.demZoom
        : selectDemZoomTier(mapZoom, currentEnv?.demZoom ?? null);

    if (demZoom === null) {
      onStatsRef.current({
        isComputing: false,
        zoomTooLow: true,
        resolutionMetersPerPx: null,
        computeTimeMs: null,
        tileCount: null,
        hasIntersections: null,
        error: null,
      });
      return;
    }

    const safetyMeters = safetyRef.current;
    let nextEnv = currentEnv;

    const canReuseEnvelope =
      !forceRebuildEnvelope &&
      currentEnv !== null &&
      currentEnv.demZoom === demZoom &&
      currentEnv.safetyRangeMeters >= safetyMeters &&
      isViewportInsideBounds(viewport, currentEnv.safeInnerBounds);

    if (!canReuseEnvelope) {
      if (lockedRef.current && currentEnv) {
        nextEnv = {
          demZoom: currentEnv.demZoom,
          safeInnerBounds: currentEnv.safeInnerBounds,
          fetchBounds: expandBBoxByMeters(currentEnv.safeInnerBounds, safetyMeters),
          safetyRangeMeters: safetyMeters,
        };
      } else {
        nextEnv = buildComputationEnvelope(viewport, demZoom, safetyMeters);
      }
      envelopeRef.current = nextEnv;
    } else if (
      forceRebuildEnvelope &&
      currentEnv &&
      currentEnv.safetyRangeMeters < safetyMeters
    ) {
      nextEnv = {
        ...currentEnv,
        fetchBounds: expandBBoxByMeters(currentEnv.safeInnerBounds, safetyMeters),
        safetyRangeMeters: safetyMeters,
      };
      envelopeRef.current = nextEnv;
    }

    if (!nextEnv) return;

    onStatsRef.current({
      isComputing: true,
      zoomTooLow: false,
      resolutionMetersPerPx: null,
      computeTimeMs: null,
      tileCount: null,
      hasIntersections: null,
      error: null,
    });

    latestRequestedJobIdRef.current = client.requestCompute({
      fetchBounds: nextEnv.fetchBounds,
      demZoom: nextEnv.demZoom,
      altitudeFeet: altitudeRef.current,
      safetyRangeMeters: safetyMeters,
    });
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;

    const client = new TerrainClient(
      (result: TerrainComputeResult) => {
        if (result.jobId !== latestRequestedJobIdRef.current) return;

        const map = mapRef.current;
        if (map && mapLoadedRef.current) {
          const safetyFillSrc = map.getSource('safety-fill-source') as
            | maplibregl.GeoJSONSource
            | undefined;
          const safetyOutlineSrc = map.getSource('safety-outline-source') as
            | maplibregl.GeoJSONSource
            | undefined;
          const contourSrc = map.getSource('contour-source') as
            | maplibregl.GeoJSONSource
            | undefined;

          safetyFillSrc?.setData(result.safetyFillGeoJson);
          safetyOutlineSrc?.setData(result.safetyOutlineGeoJson);
          contourSrc?.setData(result.contourGeoJson);
        }

        onStatsRef.current({
          isComputing: false,
          zoomTooLow: false,
          resolutionMetersPerPx: result.resolutionMetersPerPx || null,
          computeTimeMs: result.computeTimeMs,
          tileCount: result.tileCount,
          hasIntersections: result.hasIntersections,
          error: result.error ?? null,
        });
      },
      (probeResult) => {
        if (
          probeResult.elevationMeters !== null &&
          probeResult.elevationFeet !== null
        ) {
          onProbeRef.current({
            lon: probeResult.lon,
            lat: probeResult.lat,
            elevationMeters: probeResult.elevationMeters,
            elevationFeet: probeResult.elevationFeet,
          });
        }
      },
    );
    clientRef.current = client;

    const initialBaseMap = baseMapRef.current;

    const map = new maplibregl.Map({
      container: containerRef.current,
      // Centered on Mt. Hermon & Northern Golan Heights for immediate mountain contour clarity
      center: [35.76, 33.24],
      zoom: 11.2,
      minZoom: 6,
      maxZoom: 17,
      attributionControl: false,
      style: {
        version: 8,
        sources: {
          satellite: {
            type: 'raster',
            tiles: [
              'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
            ],
            tileSize: 256,
            maxzoom: 18,
            attribution: 'Esri World Imagery',
          },
          topo: {
            type: 'raster',
            tiles: ['https://tile.opentopomap.org/{z}/{x}/{y}.png'],
            tileSize: 256,
            maxzoom: 17,
            attribution: 'OpenTopoMap (CC-BY-SA)',
          },
          'safety-fill-source': {
            type: 'geojson',
            data: EMPTY_POLYGONS,
          },
          'safety-outline-source': {
            type: 'geojson',
            data: EMPTY_LINES,
          },
          'contour-source': {
            type: 'geojson',
            data: EMPTY_LINES,
          },
          'locked-bounds-source': {
            type: 'geojson',
            data: EMPTY_LINES,
          },
        },
        layers: [
          {
            id: 'base-satellite',
            type: 'raster',
            source: 'satellite',
            layout: {
              visibility: initialBaseMap === 'satellite' ? 'visible' : 'none',
            },
          },
          {
            id: 'base-topo',
            type: 'raster',
            source: 'topo',
            layout: {
              visibility: initialBaseMap === 'topo' ? 'visible' : 'none',
            },
          },
          {
            id: 'safety-fill-layer',
            type: 'fill',
            source: 'safety-fill-source',
            paint: {
              'fill-color': '#dc2626',
              'fill-opacity': 0.25,
            },
          },
          {
            id: 'safety-outline-layer',
            type: 'line',
            source: 'safety-outline-source',
            layout: {
              'line-join': 'round',
              'line-cap': 'round',
            },
            paint: {
              'line-color': '#fca5a5',
              'line-width': 2,
              'line-opacity': 0.92,
            },
          },
          {
            id: 'contour-line-layer',
            type: 'line',
            source: 'contour-source',
            layout: {
              'line-join': 'round',
              'line-cap': 'round',
            },
            paint: {
              'line-color': '#ef233c',
              'line-width': ['interpolate', ['linear'], ['zoom'], 9, 2, 12, 2.75, 15, 3.5],
              'line-opacity': 1,
            },
          },
          {
            id: 'locked-bounds-layer',
            type: 'line',
            source: 'locked-bounds-source',
            paint: {
              'line-color': '#38bdf8',
              'line-width': 1.75,
              'line-dasharray': [4, 3],
              'line-opacity': 0.85,
            },
          },
        ],
      },
    });

    map.addControl(
      new maplibregl.NavigationControl({ showCompass: true, showZoom: true }),
      'top-left',
    );
    map.addControl(
      new maplibregl.ScaleControl({ maxWidth: 120, unit: 'metric' }),
      'bottom-left',
    );
    map.addControl(
      new maplibregl.AttributionControl({ compact: true }),
      'bottom-left',
    );

    mapRef.current = map;

    map.on('load', () => {
      mapLoadedRef.current = true;
      triggerCompute(true);
    });

    const scheduleViewportCheck = () => {
      if (lockedRef.current) return;
      if (debounceTimerRef.current !== null) {
        window.clearTimeout(debounceTimerRef.current);
      }
      debounceTimerRef.current = window.setTimeout(() => {
        triggerCompute(false);
      }, 180);
    };

    map.on('moveend', scheduleViewportCheck);
    map.on('zoomend', scheduleViewportCheck);

    const requestPointProbe = (lngLat: maplibregl.LngLat, forceImmediate: boolean) => {
      const now = performance.now();
      if (!forceImmediate && now - probeTimerRef.current < 75) return;
      probeTimerRef.current = now;

      const demZoom = envelopeRef.current?.demZoom ?? 12;
      client.requestProbe({
        lon: lngLat.lng,
        lat: lngLat.lat,
        demZoom,
      });
    };

    map.on('mousemove', (e: maplibregl.MapMouseEvent) => requestPointProbe(e.lngLat, false));
    map.on('click', (e: maplibregl.MapMouseEvent) => requestPointProbe(e.lngLat, true));

    return () => {
      if (debounceTimerRef.current !== null) {
        window.clearTimeout(debounceTimerRef.current);
      }
      map.remove();
      client.dispose();
      mapRef.current = null;
      clientRef.current = null;
      mapLoadedRef.current = false;
    };
  }, [triggerCompute]);

  // Switch satellite / topo base layer cleanly
  useEffect(() => {
    baseMapRef.current = baseMap;
    const map = mapRef.current;
    if (!map || !mapLoadedRef.current) return;

    if (map.getLayer('base-satellite')) {
      map.setLayoutProperty(
        'base-satellite',
        'visibility',
        baseMap === 'satellite' ? 'visible' : 'none',
      );
    }
    if (map.getLayer('base-topo')) {
      map.setLayoutProperty(
        'base-topo',
        'visibility',
        baseMap === 'topo' ? 'visible' : 'none',
      );
    }
  }, [baseMap]);

  // Recompute immediately when altitude or safety range changes (reuses cached DEM tiles!)
  useEffect(() => {
    altitudeRef.current = altitudeFeet;
    safetyRef.current = safetyRangeMeters;
    if (!mapLoadedRef.current) return;

    const timer = window.setTimeout(() => {
      triggerCompute(true);
    }, 120);
    return () => window.clearTimeout(timer);
  }, [altitudeFeet, safetyRangeMeters, triggerCompute]);

  // Show/hide locked mission envelope frame & trigger fresh compute when unlocked
  useEffect(() => {
    lockedRef.current = isAreaLocked;
    const map = mapRef.current;
    if (!map || !mapLoadedRef.current) return;

    const lockedSrc = map.getSource('locked-bounds-source') as
      | maplibregl.GeoJSONSource
      | undefined;

    if (isAreaLocked && envelopeRef.current) {
      lockedSrc?.setData(bboxToGeoJson(envelopeRef.current.safeInnerBounds));
    } else {
      lockedSrc?.setData(EMPTY_LINES);
      if (!isAreaLocked) {
        triggerCompute(false);
      }
    }
  }, [isAreaLocked, triggerCompute]);

  return (
    <div
      ref={containerRef}
      className="map-canvas"
      aria-label="מפת קווי גובה וטווחי בטיחות"
    />
  );
}
