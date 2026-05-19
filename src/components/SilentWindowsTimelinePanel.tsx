import React, { useMemo, useState } from 'react';
import { DataFrame, PanelProps } from '@grafana/data';
import { SilentWindowsTimelineOptions } from '../types';

// ─────────────────────────────────────────────────────────────────────────
// Faithful port of fde-dashboard's silent-windows-timeline-chart.tsx into a
// Grafana panel plugin. SVG rendering is identical to the source. The data
// fetch is replaced with reading from props.data.series, where each query
// the panel runs becomes one DataFrame:
//
//   refId=A  cells         columns: ts (number, ms) | active (int) | typical (int) | rounds (int)
//   refId=B  restarts      columns: ts (number, ms) | version (string)
//   refId=C  eras          columns: version (string) | first (number, ms) | last (number, ms)
//   refId=D  silentWindows columns: from (number, ms) | to (number, ms) | label (string) | hoursAffected (int)
//
// Only refId=A is required; missing optional frames render gracefully.
// ─────────────────────────────────────────────────────────────────────────

interface Cell {
  ts: number;
  active: number;
  typical: number;
  rounds: number;
}
interface RestartEvent {
  ts: number;
  version: string;
  scheduled: boolean;
}
interface EraSegment {
  from: number;
  to: number;
  version: string;
}
interface SilentWindow {
  from: number;
  to: number;
  label: string;
  hoursAffected: number;
}

const HOUR_MS = 3_600_000;
const ET_OFFSET_HOURS = 4;

// Stable color per version. Falls back to a deterministic hash for unknown versions.
const VERSION_COLOR: Record<string, string> = {
  '3.1.0': 'hsl(15 75% 55%)',
  '3.1.1': 'hsl(217 70% 55%)',
  '3.1.2': 'hsl(280 60% 55%)',
};
function colorForVersion(v: string): string {
  if (VERSION_COLOR[v]) {
    return VERSION_COLOR[v];
  }
  let h = 0;
  for (let i = 0; i < v.length; i++) {
    h = (h * 31 + v.charCodeAt(i)) | 0;
  }
  return `hsl(${((h % 360) + 360) % 360} 60% 55%)`;
}

// Layout
const LABEL_W = 80;
const HOUR_W = 33;
const DAY_H = 16;
const TOP_PAD = 28;
const VERSION_STRIP_W = 8;
const RIGHT_PAD = 40;

function edtParts(ms: number) {
  const d = new Date(ms - ET_OFFSET_HOURS * HOUR_MS);
  return {
    y: d.getUTCFullYear(),
    m: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    h: d.getUTCHours(),
    min: d.getUTCMinutes(),
    dow: d.getUTCDay(),
  };
}
function dayLabelEdt(ms: number) {
  const p = edtParts(ms);
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][p.dow];
  return `${dow} ${p.m.toString().padStart(2, '0')}-${p.d.toString().padStart(2, '0')}`;
}
function hourLabel(h: number) {
  return h.toString().padStart(2, '0');
}
function fmtEdt(ms: number) {
  const p = edtParts(ms);
  return `${dayLabelEdt(ms)} ${hourLabel(p.h)}:${p.min.toString().padStart(2, '0')} EDT`;
}

// Match cellColor() from the source chart.
function cellColor(c: Cell): string {
  if (c.typical < 5) {
    return 'hsl(220 10% 50% / 0.10)';
  }
  const ratio = c.active / c.typical;
  if (ratio >= 0.85) {
    return 'hsl(150 50% 45% / 0.32)';
  }
  if (ratio >= 0.6) {
    return 'hsl(80 60% 50% / 0.32)';
  }
  if (ratio >= 0.4) {
    return 'hsl(45 90% 55% / 0.50)';
  }
  if (ratio >= 0.2) {
    return 'hsl(20 90% 55% / 0.70)';
  }
  return 'hsl(0 84% 55% / 0.85)';
}

// Extract a Cell[] from refId=A. Tolerant of either time-typed first column
// (Grafana converts most SQL timestamps to time-field Date | number) or a
// plain numeric ms column.
function framesToCells(frames: DataFrame[]): Cell[] {
  const f = frames.find((s) => s.refId === 'A') ?? frames[0];
  if (!f) {
    return [];
  }
  const ts = f.fields.find((x) => x.name === 'ts' || x.type === 'time')?.values;
  const active = f.fields.find((x) => x.name === 'active')?.values;
  const typical = f.fields.find((x) => x.name === 'typical')?.values;
  const rounds = f.fields.find((x) => x.name === 'rounds')?.values;
  if (!ts || !active || !typical) {
    return [];
  }
  const out: Cell[] = [];
  for (let i = 0; i < ts.length; i++) {
    const t = ts.get ? ts.get(i) : (ts as unknown as ArrayLike<unknown>)[i];
    const tms = t instanceof Date ? t.getTime() : Number(t);
    const a = active.get ? active.get(i) : (active as unknown as ArrayLike<number>)[i];
    const tp = typical.get ? typical.get(i) : (typical as unknown as ArrayLike<number>)[i];
    const rd = rounds ? (rounds.get ? rounds.get(i) : (rounds as unknown as ArrayLike<number>)[i]) : 0;
    out.push({ ts: tms, active: Number(a), typical: Number(tp), rounds: Number(rd) });
  }
  return out;
}

function framesToRestarts(frames: DataFrame[]): RestartEvent[] {
  const f = frames.find((s) => s.refId === 'B');
  if (!f) {
    return [];
  }
  const ts = f.fields.find((x) => x.name === 'ts' || x.type === 'time')?.values;
  const version = f.fields.find((x) => x.name === 'version')?.values;
  if (!ts || !version) {
    return [];
  }
  const out: RestartEvent[] = [];
  for (let i = 0; i < ts.length; i++) {
    const t = ts.get ? ts.get(i) : (ts as unknown as ArrayLike<unknown>)[i];
    const tms = t instanceof Date ? t.getTime() : Number(t);
    const v = String(version.get ? version.get(i) : (version as unknown as ArrayLike<unknown>)[i]);
    const edt = new Date(tms - ET_OFFSET_HOURS * HOUR_MS);
    const minutes = edt.getUTCHours() * 60 + edt.getUTCMinutes();
    const scheduled = Math.abs(minutes - (4 * 60 + 2)) <= 10;
    out.push({ ts: tms, version: v, scheduled });
  }
  return out;
}

function framesToEras(frames: DataFrame[]): EraSegment[] {
  const f = frames.find((s) => s.refId === 'C');
  if (!f) {
    return [];
  }
  const version = f.fields.find((x) => x.name === 'version')?.values;
  const first = f.fields.find((x) => x.name === 'first')?.values;
  const last = f.fields.find((x) => x.name === 'last')?.values;
  if (!version || !first || !last) {
    return [];
  }
  const out: EraSegment[] = [];
  for (let i = 0; i < version.length; i++) {
    const v = String(version.get ? version.get(i) : (version as unknown as ArrayLike<unknown>)[i]);
    const fm = first.get ? first.get(i) : (first as unknown as ArrayLike<unknown>)[i];
    const lm = last.get ? last.get(i) : (last as unknown as ArrayLike<unknown>)[i];
    out.push({
      version: v,
      from: fm instanceof Date ? fm.getTime() : Number(fm),
      to: lm instanceof Date ? lm.getTime() : Number(lm),
    });
  }
  return out;
}

function framesToSilentWindows(frames: DataFrame[]): SilentWindow[] {
  const f = frames.find((s) => s.refId === 'D');
  if (!f) {
    return [];
  }
  const from = f.fields.find((x) => x.name === 'from')?.values;
  const to = f.fields.find((x) => x.name === 'to')?.values;
  const label = f.fields.find((x) => x.name === 'label')?.values;
  const hoursAffected = f.fields.find((x) => x.name === 'hoursAffected' || x.name === 'hours_affected')?.values;
  if (!from || !to || !label) {
    return [];
  }
  const out: SilentWindow[] = [];
  for (let i = 0; i < from.length; i++) {
    const a = from.get ? from.get(i) : (from as unknown as ArrayLike<unknown>)[i];
    const b = to.get ? to.get(i) : (to as unknown as ArrayLike<unknown>)[i];
    const l = String(label.get ? label.get(i) : (label as unknown as ArrayLike<unknown>)[i]);
    const h = hoursAffected
      ? Number(hoursAffected.get ? hoursAffected.get(i) : (hoursAffected as unknown as ArrayLike<number>)[i])
      : 0;
    out.push({
      from: a instanceof Date ? a.getTime() : Number(a),
      to: b instanceof Date ? b.getTime() : Number(b),
      label: l,
      hoursAffected: h,
    });
  }
  return out;
}

interface Props extends PanelProps<SilentWindowsTimelineOptions> {}

export const SilentWindowsTimelinePanel: React.FC<Props> = ({ data, width, height }) => {
  const [hover, setHover] = useState<Cell | null>(null);

  const cells = useMemo(() => framesToCells(data.series), [data.series]);
  const restarts = useMemo(() => framesToRestarts(data.series), [data.series]);
  const eras = useMemo(() => framesToEras(data.series), [data.series]);
  const silentWindows = useMemo(() => framesToSilentWindows(data.series), [data.series]);

  const grid = useMemo(() => {
    if (cells.length === 0) {
      return null;
    }
    const dayMsSet = new Set<number>();
    for (const c of cells) {
      const p = edtParts(c.ts);
      const dayStartUtc = Date.UTC(p.y, p.m - 1, p.d, ET_OFFSET_HOURS, 0, 0, 0);
      dayMsSet.add(dayStartUtc);
    }
    const dayMs = Array.from(dayMsSet).sort((a, b) => a - b);
    const byKey = new Map<string, Cell>();
    for (const c of cells) {
      const p = edtParts(c.ts);
      const dayStartUtc = Date.UTC(p.y, p.m - 1, p.d, ET_OFFSET_HOURS, 0, 0, 0);
      byKey.set(`${dayStartUtc}|${p.h}`, c);
    }
    const totalW = LABEL_W + 24 * HOUR_W + VERSION_STRIP_W + RIGHT_PAD;
    const totalH = TOP_PAD + dayMs.length * DAY_H + 12;
    return { dayMs, byKey, totalW, totalH };
  }, [cells]);

  if (data.series.length === 0 || cells.length === 0) {
    return (
      <div style={{ padding: 12, color: 'var(--text-color-weak, #888)', fontSize: 12 }}>
        No data. Define query A returning columns: ts, active, typical, rounds.
      </div>
    );
  }
  if (!grid) {
    return null;
  }

  const xForHour = (h: number) => LABEL_W + h * HOUR_W;
  const yForDay = (dayStartUtc: number) => TOP_PAD + grid.dayMs.indexOf(dayStartUtc) * DAY_H;

  const restartByCell: Array<{ x: number; y: number; r: RestartEvent }> = [];
  for (const r of restarts) {
    const p = edtParts(r.ts);
    const dayStartUtc = Date.UTC(p.y, p.m - 1, p.d, ET_OFFSET_HOURS, 0, 0, 0);
    const rowIdx = grid.dayMs.indexOf(dayStartUtc);
    if (rowIdx < 0) {
      continue;
    }
    restartByCell.push({
      x: xForHour(p.h) + (p.min / 60) * HOUR_W,
      y: yForDay(dayStartUtc) + DAY_H / 2,
      r,
    });
  }

  // Pick the era with the most overlap into the EDT day. Overlap > noon-test:
  // a 2-hour-of-data stage era (10:00–12:00 UTC) wouldn't include noon EDT
  // (16:00 UTC), but it overlaps the day so it's still the right label.
  const eraForDay = (dayStartUtc: number): EraSegment | undefined => {
    const dayEnd = dayStartUtc + 24 * HOUR_MS;
    let best: EraSegment | undefined;
    let bestOverlap = 0;
    for (const e of eras) {
      const ovl = Math.min(e.to, dayEnd) - Math.max(e.from, dayStartUtc);
      if (ovl > bestOverlap) {
        bestOverlap = ovl;
        best = e;
      }
    }
    return best;
  };
  const eraColorForDay = (dayStartUtc: number): string => {
    const e = eraForDay(dayStartUtc);
    return e ? colorForVersion(e.version) : 'hsl(220 10% 70%)';
  };
  const eraLabelForDay = (dayStartUtc: number): string => eraForDay(dayStartUtc)?.version ?? '';

  return (
    <div style={{ width, height, overflow: 'auto', color: 'currentColor', fontFamily: 'inherit' }}>
      <svg
        width={grid.totalW}
        height={grid.totalH}
        style={{ display: 'block', color: 'currentColor' }}
        onMouseLeave={() => setHover(null)}
      >
        {Array.from({ length: 24 }, (_, h) => (
          <text
            key={`hh-${h}`}
            x={xForHour(h) + HOUR_W / 2}
            y={TOP_PAD - 10}
            textAnchor="middle"
            fontSize={10}
            fill="currentColor"
            opacity={0.6}
          >
            {hourLabel(h)}
          </text>
        ))}
        <text
          x={LABEL_W + (24 * HOUR_W) / 2}
          y={12}
          textAnchor="middle"
          fontSize={10}
          fill="currentColor"
          opacity={0.6}
        >
          hour of day (EDT)
        </text>

        {grid.dayMs.map((dayStartUtc) => {
          const y = yForDay(dayStartUtc);
          return (
            <g key={`d-${dayStartUtc}`}>
              <text
                x={LABEL_W - 6}
                y={y + DAY_H / 2 + 3}
                textAnchor="end"
                fontSize={10}
                fill="currentColor"
                opacity={0.7}
              >
                {dayLabelEdt(dayStartUtc)}
              </text>
              {Array.from({ length: 24 }, (_, h) => {
                const c = grid.byKey.get(`${dayStartUtc}|${h}`);
                const cx = xForHour(h);
                if (!c) {
                  return (
                    <rect
                      key={`c-${dayStartUtc}-${h}`}
                      x={cx}
                      y={y}
                      width={HOUR_W}
                      height={DAY_H}
                      fill="hsl(220 10% 50% / 0.05)"
                    />
                  );
                }
                return (
                  <rect
                    key={`c-${dayStartUtc}-${h}`}
                    x={cx}
                    y={y}
                    width={HOUR_W}
                    height={DAY_H}
                    fill={cellColor(c)}
                    stroke="white"
                    strokeOpacity={0.15}
                    strokeWidth={0.5}
                    onMouseEnter={() => setHover(c)}
                  />
                );
              })}
              <rect
                x={LABEL_W + 24 * HOUR_W + 4}
                y={y}
                width={VERSION_STRIP_W}
                height={DAY_H}
                fill={eraColorForDay(dayStartUtc)}
                fillOpacity={0.55}
              />
              <text
                x={LABEL_W + 24 * HOUR_W + 4 + VERSION_STRIP_W + 2}
                y={y + DAY_H / 2 + 3}
                fontSize={9}
                fill="currentColor"
                opacity={0.55}
              >
                {eraLabelForDay(dayStartUtc)}
              </text>
            </g>
          );
        })}

        {[0, 6, 12, 18, 24].map((h) => (
          <line
            key={`v-${h}`}
            x1={xForHour(h)}
            x2={xForHour(h)}
            y1={TOP_PAD}
            y2={TOP_PAD + grid.dayMs.length * DAY_H}
            stroke="currentColor"
            strokeOpacity={0.15}
            strokeWidth={0.5}
          />
        ))}

        {restartByCell.map(({ x, y, r }, i) => (
          <g key={`r-${i}`}>
            <line
              x1={x}
              x2={x}
              y1={y - DAY_H / 2 + 2}
              y2={y + DAY_H / 2 - 2}
              stroke={r.scheduled ? 'hsl(220 10% 20%)' : 'hsl(0 80% 45%)'}
              strokeWidth={r.scheduled ? 1.2 : 1.8}
              opacity={r.scheduled ? 0.7 : 1}
            />
          </g>
        ))}
      </svg>

      <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-color-weak, #999)' }}>
        {[
          { label: '≤ 20% (silent)', color: 'hsl(0 84% 55% / 0.85)' },
          { label: '20–40%', color: 'hsl(20 90% 55% / 0.70)' },
          { label: '40–60%', color: 'hsl(45 90% 55% / 0.50)' },
          { label: '60–85%', color: 'hsl(80 60% 50% / 0.32)' },
          { label: '≥ 85% (normal)', color: 'hsl(150 50% 45% / 0.32)' },
          { label: 'low-volume hour', color: 'hsl(220 10% 50% / 0.10)' },
        ].map((s) => (
          <span key={s.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginRight: 12 }}>
            <span
              style={{
                background: s.color,
                display: 'inline-block',
                height: 12,
                width: 16,
                border: '1px solid var(--border-weak, #444)',
                borderRadius: 2,
              }}
            />
            {s.label}
          </span>
        ))}
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginRight: 12 }}>
          <span style={{ background: 'hsl(220 10% 20%)', display: 'inline-block', height: 12, width: 2 }} />
          scheduled restart (~04:02 EDT)
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <span style={{ background: 'hsl(0 80% 45%)', display: 'inline-block', height: 12, width: 2 }} />
          off-cycle restart
        </span>
      </div>

      <div style={{ marginTop: 6, fontSize: 12, minHeight: 18, color: 'var(--text-color-weak, #999)' }}>
        {hover ? (
          <>
            {fmtEdt(hover.ts)} · {hover.active} active table{hover.active === 1 ? '' : 's'} (typical {hover.typical}) ·{' '}
            {hover.rounds.toLocaleString()} round{hover.rounds === 1 ? '' : 's'}
          </>
        ) : (
          <>Hover over a cell to see hourly detail.</>
        )}
      </div>

      {silentWindows.length > 0 && (
        <div style={{ marginTop: 14, fontSize: 12 }}>
          <div style={{ fontWeight: 500 }}>Silent-window incidents</div>
          <ol style={{ marginTop: 6, paddingLeft: 20 }}>
            {silentWindows.map((sw, i) => (
              <li key={`sw-${i}`} style={{ marginBottom: 2 }}>
                <span style={{ fontWeight: 500 }}>{sw.label}</span>
                <span style={{ color: 'var(--text-color-weak, #999)', marginLeft: 6 }}>
                  · {dayLabelEdt(sw.from)} {fmtEdt(sw.from).split(' ').slice(2).join(' ')} →{' '}
                  {fmtEdt(sw.to).split(' ').slice(2).join(' ')} · {sw.hoursAffected}h
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
};
