import { useState } from 'react';
import {
  ChevronDown,
  ChevronUp,
  Layers,
  Lock,
  Minus,
  Mountain,
  Plus,
  ShieldAlert,
  Unlock,
} from 'lucide-react';
import type { ComputeStats } from './TerrainMap';
import { feetToMeters } from '../terrain/math';
import type { BaseMapStyle, SafetyUnit } from '../terrain/types';

interface ControlPanelProps {
  altitudeFeet: number;
  onAltitudeChange: (feet: number) => void;
  safetyValue: number;
  safetyUnit: SafetyUnit;
  onSafetyValueChange: (val: number) => void;
  onSafetyUnitChange: (unit: SafetyUnit) => void;
  baseMap: BaseMapStyle;
  onBaseMapChange: (style: BaseMapStyle) => void;
  isAreaLocked: boolean;
  onToggleLock: () => void;
  stats: ComputeStats;
}

const ALTITUDE_PRESETS_FT = [1500, 3000, 5000, 8000];
const SAFETY_PRESETS_M = [250, 500, 1000, 2000];
const SAFETY_PRESETS_KM = [0.5, 1, 2, 5];

export function ControlPanel({
  altitudeFeet,
  onAltitudeChange,
  safetyValue,
  safetyUnit,
  onSafetyValueChange,
  onSafetyUnitChange,
  baseMap,
  onBaseMapChange,
  isAreaLocked,
  onToggleLock,
  stats,
}: ControlPanelProps) {
  const [collapsed, setCollapsed] = useState(false);

  const altitudeMeters = Math.round(feetToMeters(altitudeFeet));
  const safetyPresets = safetyUnit === 'm' ? SAFETY_PRESETS_M : SAFETY_PRESETS_KM;
  const safetyStep = safetyUnit === 'm' ? 50 : 0.25;

  const handleAltStep = (delta: number) => {
    onAltitudeChange(Math.max(-1400, Math.min(35000, altitudeFeet + delta)));
  };

  const handleSafetyStep = (delta: number) => {
    const next = Math.max(0, Number((safetyValue + delta).toFixed(2)));
    onSafetyValueChange(next);
  };

  return (
    <aside className={`hud-panel ${collapsed ? 'hud-panel--collapsed' : ''}`}>
      <header className="hud-header">
        <div className="hud-title-group">
          <span className="hud-brand-icon" aria-hidden="true">
            <Mountain size={18} />
          </span>
          <div>
            <h1 className="hud-title">בקרת גובה שטח</h1>
            <p className="hud-subtitle">קווי גובה וטווח בטיחות לכטמ״ם</p>
          </div>
        </div>

        <div className="hud-header-actions">
          <span
            className={`status-pill ${
              stats.error
                ? 'status-pill--error'
                : stats.zoomTooLow
                  ? 'status-pill--warn'
                  : stats.isComputing
                    ? 'status-pill--busy'
                    : 'status-pill--ready'
            }`}
          >
            <span className="status-dot" />
            {stats.error
              ? 'שגיאת טעינה'
              : stats.zoomTooLow
                ? 'נדרש זום פנימה'
                : stats.isComputing
                  ? 'מחשב...'
                  : 'פעיל'}
          </span>

          <button
            type="button"
            className="icon-btn"
            onClick={() => setCollapsed((c) => !c)}
            aria-label={collapsed ? 'הרחב תפריט בקרה' : 'צמצם תפריט בקרה'}
            title={collapsed ? 'הרחב' : 'צמצם'}
          >
            {collapsed ? <ChevronDown size={18} /> : <ChevronUp size={18} />}
          </button>
        </div>
      </header>

      {!collapsed && (
        <div className="hud-body">
          {/* Altitude Input */}
          <section className="control-group">
            <div className="control-label-row">
              <label htmlFor="altitude-input" className="control-label">
                <Mountain size={14} />
                גובה טיסה (AMSL)
              </label>
              <span className="control-converted mono">{altitudeMeters.toLocaleString()} מ׳</span>
            </div>

            <div className="stepper-row">
              <button
                type="button"
                className="step-btn"
                onClick={() => handleAltStep(-100)}
                aria-label="הפחת 100 רגל"
              >
                <Minus size={15} />
              </button>
              <div className="input-wrap">
                <input
                  id="altitude-input"
                  type="number"
                  className="num-input mono"
                  value={altitudeFeet}
                  step={50}
                  min={-1400}
                  max={35000}
                  onChange={(e) => {
                    const parsed = Number(e.target.value);
                    if (!Number.isNaN(parsed)) {
                      onAltitudeChange(Math.max(-1400, Math.min(35000, parsed)));
                    }
                  }}
                />
                <span className="input-unit">רגל (ft)</span>
              </div>
              <button
                type="button"
                className="step-btn"
                onClick={() => handleAltStep(100)}
                aria-label="הוסף 100 רגל"
              >
                <Plus size={15} />
              </button>
            </div>

            <div className="preset-row">
              {ALTITUDE_PRESETS_FT.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  className={`preset-btn mono ${altitudeFeet === preset ? 'preset-btn--active' : ''}`}
                  onClick={() => onAltitudeChange(preset)}
                >
                  {preset.toLocaleString()} ft
                </button>
              ))}
            </div>
          </section>

          {/* Safety Buffer Input */}
          <section className="control-group">
            <div className="control-label-row">
              <label htmlFor="safety-input" className="control-label">
                <ShieldAlert size={14} />
                טווח בטיחות מקו הגובה
              </label>

              <div className="segmented-toggle" role="group" aria-label="יחידת טווח בטיחות">
                <button
                  type="button"
                  className={`seg-btn ${safetyUnit === 'm' ? 'seg-btn--active' : ''}`}
                  onClick={() => onSafetyUnitChange('m')}
                >
                  מטר
                </button>
                <button
                  type="button"
                  className={`seg-btn ${safetyUnit === 'km' ? 'seg-btn--active' : ''}`}
                  onClick={() => onSafetyUnitChange('km')}
                >
                  ק״מ
                </button>
              </div>
            </div>

            <div className="stepper-row">
              <button
                type="button"
                className="step-btn"
                onClick={() => handleSafetyStep(-safetyStep)}
                aria-label="הקטן טווח בטיחות"
              >
                <Minus size={15} />
              </button>
              <div className="input-wrap">
                <input
                  id="safety-input"
                  type="number"
                  className="num-input mono"
                  value={safetyValue}
                  step={safetyStep}
                  min={0}
                  max={safetyUnit === 'm' ? 15000 : 15}
                  onChange={(e) => {
                    const parsed = Number(e.target.value);
                    if (!Number.isNaN(parsed)) {
                      const max = safetyUnit === 'm' ? 15000 : 15;
                      onSafetyValueChange(Math.max(0, Math.min(max, parsed)));
                    }
                  }}
                />
                <span className="input-unit">{safetyUnit === 'm' ? 'מטרים' : 'קילומטר'}</span>
              </div>
              <button
                type="button"
                className="step-btn"
                onClick={() => handleSafetyStep(safetyStep)}
                aria-label="הגדל טווח בטיחות"
              >
                <Plus size={15} />
              </button>
            </div>

            <div className="preset-row">
              {safetyPresets.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  className={`preset-btn mono ${safetyValue === preset ? 'preset-btn--active' : ''}`}
                  onClick={() => onSafetyValueChange(preset)}
                >
                  {preset} {safetyUnit === 'm' ? 'מ׳' : 'ק״מ'}
                </button>
              ))}
            </div>
          </section>

          {/* Base Map & Compute Area Lock */}
          <section className="control-group control-group--row">
            <div className="sub-control">
              <span className="sub-label">
                <Layers size={13} />
                מפת רקע
              </span>
              <div className="segmented-toggle" role="group" aria-label="בחירת מפת רקע">
                <button
                  type="button"
                  className={`seg-btn ${baseMap === 'satellite' ? 'seg-btn--active' : ''}`}
                  onClick={() => onBaseMapChange('satellite')}
                >
                  לוויין
                </button>
                <button
                  type="button"
                  className={`seg-btn ${baseMap === 'topo' ? 'seg-btn--active' : ''}`}
                  onClick={() => onBaseMapChange('topo')}
                >
                  טופוגרפית
                </button>
              </div>
            </div>

            <button
              type="button"
              className={`lock-btn ${isAreaLocked ? 'lock-btn--active' : ''}`}
              onClick={onToggleLock}
              title="נעל את מעטפת החישוב הנוכחית למניעת חישובים נוספים בזמן זום ותזוזה באזור המשימה"
            >
              {isAreaLocked ? <Lock size={14} /> : <Unlock size={14} />}
              <span>{isAreaLocked ? 'אזור חישוב נעול' : 'נעל אזור חישוב'}</span>
            </button>
          </section>

          {/* Legend & Compute Telemetry */}
          <footer className="hud-footer">
            <div className="legend-row">
              <span className="legend-item">
                <span className="legend-swatch legend-swatch--contour" />
                קו גובה ({altitudeFeet.toLocaleString()} ft)
              </span>
              <span className="legend-item">
                <span className="legend-swatch legend-swatch--safety" />
                אזור בטיחות (+{safetyValue} {safetyUnit === 'm' ? 'מ׳' : 'ק״מ'})
              </span>
            </div>

            {stats.zoomTooLow ? (
              <p className="telemetry-note telemetry-note--warn">
                התקרב למפה (Zoom 8.5+) כדי לטעון נתוני גובה ולהימנע מעומס אריחים.
              </p>
            ) : stats.error ? (
              <p className="telemetry-note telemetry-note--error">
                שגיאה בטעינת נתוני גובה: {stats.error}
              </p>
            ) : (
              <div className="telemetry-row mono">
                <span>
                  רזולוציה:{' '}
                  {stats.resolutionMetersPerPx
                    ? `~${Math.round(stats.resolutionMetersPerPx)} מ׳/px`
                    : '—'}
                </span>
                <span>
                  חישוב: {stats.computeTimeMs !== null ? `${stats.computeTimeMs} ms` : '—'}
                </span>
                {stats.hasIntersections === false && (
                  <span className="telemetry-clear">אין שטח בגובה זה</span>
                )}
              </div>
            )}
          </footer>
        </div>
      )}
    </aside>
  );
}
