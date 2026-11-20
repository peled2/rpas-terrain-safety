import type {
  BBox,
  TerrainComputeResult,
  TerrainProbeResult,
  WorkerOutboundMessage,
} from './types';

export class TerrainClient {
  private worker: Worker;
  private nextJobId = 1;
  private nextProbeId = 1;
  private latestJobId = 0;
  private onComputeResult: (result: TerrainComputeResult) => void;
  private onProbeResult: (result: TerrainProbeResult) => void;

  constructor(
    onComputeResult: (result: TerrainComputeResult) => void,
    onProbeResult: (result: TerrainProbeResult) => void,
  ) {
    this.onComputeResult = onComputeResult;
    this.onProbeResult = onProbeResult;

    this.worker = new Worker(new URL('./terrainWorker.ts', import.meta.url), {
      type: 'module',
    });

    this.worker.onmessage = (event: MessageEvent<WorkerOutboundMessage>) => {
      const msg = event.data;
      if (msg.type === 'compute-result') {
        this.onComputeResult(msg);
      } else if (msg.type === 'probe-result') {
        this.onProbeResult(msg);
      }
    };

    this.worker.onerror = (event: ErrorEvent) => {
      this.onComputeResult({
        type: 'compute-result',
        jobId: this.latestJobId,
        contourGeoJson: { type: 'FeatureCollection', features: [] },
        safetyFillGeoJson: { type: 'FeatureCollection', features: [] },
        safetyOutlineGeoJson: { type: 'FeatureCollection', features: [] },
        resolutionMetersPerPx: 0,
        computeTimeMs: 0,
        tileCount: 0,
        hasIntersections: false,
        error: event.message || 'שגיאה בהפעלת מנוע החישוב (Web Worker)',
      });
    };

    this.worker.onmessageerror = () => {
      this.onComputeResult({
        type: 'compute-result',
        jobId: this.latestJobId,
        contourGeoJson: { type: 'FeatureCollection', features: [] },
        safetyFillGeoJson: { type: 'FeatureCollection', features: [] },
        safetyOutlineGeoJson: { type: 'FeatureCollection', features: [] },
        resolutionMetersPerPx: 0,
        computeTimeMs: 0,
        tileCount: 0,
        hasIntersections: false,
        error: 'שגיאת תקשורת עם מנוע החישוב',
      });
    };
  }

  requestCompute(params: {
    fetchBounds: BBox;
    demZoom: number;
    altitudeFeet: number;
    safetyRangeMeters: number;
  }): number {
    const jobId = this.nextJobId++;
    this.latestJobId = jobId;
    this.worker.postMessage({
      type: 'compute',
      jobId,
      ...params,
    });
    return jobId;
  }

  requestProbe(params: { lon: number; lat: number; demZoom: number }): number {
    const probeId = this.nextProbeId++;
    this.worker.postMessage({
      type: 'probe',
      probeId,
      ...params,
    });
    return probeId;
  }

  dispose(): void {
    this.worker.terminate();
  }
}
