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
  }

  requestCompute(params: {
    fetchBounds: BBox;
    demZoom: number;
    altitudeFeet: number;
    safetyRangeMeters: number;
  }): number {
    const jobId = this.nextJobId++;
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
