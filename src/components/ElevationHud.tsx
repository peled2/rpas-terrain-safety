import { Crosshair } from 'lucide-react';
import { feetToMeters } from '../terrain/math';
import type { ElevationProbe } from '../terrain/types';

interface ElevationHudProps {
  probe: ElevationProbe | null;
  targetAltitudeFeet: number;
}

export function ElevationHud({ probe, targetAltitudeFeet }: ElevationHudProps) {
  if (!probe) {
    return (
      <div className="probe-hud probe-hud--empty">
        <Crosshair size={14} />
        <span>הזז סמן או לחץ על המפה למדידת גובה שטח</span>
      </div>
    );
  }

  const targetMeters = feetToMeters(targetAltitudeFeet);
  const deltaFeet = Math.round(targetAltitudeFeet - probe.elevationFeet);
  const isAboveTerrain = probe.elevationMeters < targetMeters;

  return (
    <div className="probe-hud" aria-live="polite">
      <div className="probe-elevation">
        <Crosshair size={14} className="probe-icon" />
        <span className="probe-label">גובה קרקע:</span>
        <strong className="mono probe-feet">
          {Math.round(probe.elevationFeet).toLocaleString()} ft
        </strong>
        <span className="mono probe-meters">
          ({Math.round(probe.elevationMeters).toLocaleString()} מ׳)
        </span>
      </div>

      <div className="probe-meta">
        <span
          className={`probe-clearance mono ${
            isAboveTerrain ? 'probe-clearance--safe' : 'probe-clearance--danger'
          }`}
        >
          {isAboveTerrain
            ? `מרווח +${deltaFeet.toLocaleString()} ft`
            : `שטח גבוה ב-${Math.abs(deltaFeet).toLocaleString()} ft`}
        </span>
        <span className="probe-coords mono">
          {probe.lat.toFixed(4)}°, {probe.lon.toFixed(4)}°
        </span>
      </div>
    </div>
  );
}
