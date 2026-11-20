import { useCallback, useState } from 'react';
import { ControlPanel } from './components/ControlPanel';
import { ElevationHud } from './components/ElevationHud';
import { TerrainMap, type ComputeStats } from './components/TerrainMap';
import type { BaseMapStyle, ElevationProbe, SafetyUnit } from './terrain/types';
import './App.css';

export function App() {
  const [altitudeFeet, setAltitudeFeet] = useState<number>(3000);
  const [safetyValue, setSafetyValue] = useState<number>(500);
  const [safetyUnit, setSafetyUnit] = useState<SafetyUnit>('m');
  const [baseMap, setBaseMap] = useState<BaseMapStyle>('satellite');
  const [isAreaLocked, setIsAreaLocked] = useState<boolean>(false);
  const [probe, setProbe] = useState<ElevationProbe | null>(null);
  const [stats, setStats] = useState<ComputeStats>({
    isComputing: true,
    zoomTooLow: false,
    resolutionMetersPerPx: null,
    computeTimeMs: null,
    tileCount: null,
    hasIntersections: null,
    error: null,
  });

  const safetyRangeMeters = safetyUnit === 'km' ? safetyValue * 1000 : safetyValue;

  const handleSafetyUnitChange = useCallback(
    (nextUnit: SafetyUnit) => {
      if (nextUnit === safetyUnit) return;
      if (nextUnit === 'km') {
        setSafetyValue((prev) => Number((prev / 1000).toFixed(2)));
      } else {
        setSafetyValue((prev) => Math.round(prev * 1000));
      }
      setSafetyUnit(nextUnit);
    },
    [safetyUnit],
  );

  return (
    <main className="app-shell">
      <TerrainMap
        altitudeFeet={altitudeFeet}
        safetyRangeMeters={safetyRangeMeters}
        baseMap={baseMap}
        isAreaLocked={isAreaLocked}
        onStatsChange={setStats}
        onProbeChange={setProbe}
      />

      <ControlPanel
        altitudeFeet={altitudeFeet}
        onAltitudeChange={setAltitudeFeet}
        safetyValue={safetyValue}
        safetyUnit={safetyUnit}
        onSafetyValueChange={setSafetyValue}
        onSafetyUnitChange={handleSafetyUnitChange}
        baseMap={baseMap}
        onBaseMapChange={setBaseMap}
        isAreaLocked={isAreaLocked}
        onToggleLock={() => setIsAreaLocked((prev) => !prev)}
        stats={stats}
      />

      <ElevationHud probe={probe} targetAltitudeFeet={altitudeFeet} />
    </main>
  );
}

export default App;
