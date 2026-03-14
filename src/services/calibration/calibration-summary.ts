import type { ZoneMatch } from './zone-matcher';

export interface CalibrationSummary {
  greenCount: number;
  amberCount: number;
  redCount: number;
  totalZones: number;
  greenPct: number;
  amberPct: number;
  redPct: number;
  amberBreakdown: Record<string, number>;
}

export function summariseCalibrationRun(
  matches: ZoneMatch[],
): CalibrationSummary {
  const total = matches.length;
  if (total === 0) {
    return {
      greenCount: 0,
      amberCount: 0,
      redCount: 0,
      totalZones: 0,
      greenPct: 0,
      amberPct: 0,
      redPct: 0,
      amberBreakdown: {},
    };
  }

  let green = 0;
  let amber = 0;
  let red = 0;
  const breakdown: Record<string, number> = {};

  for (const m of matches) {
    if (m.reconciliationBucket === 'GREEN') {
      green++;
    } else if (m.reconciliationBucket === 'AMBER') {
      amber++;
      if (m.typeDisagreement) {
        const key = `${m.typeDisagreement.doclingLabel}→${m.typeDisagreement.pdfxtLabel}`;
        breakdown[key] = (breakdown[key] ?? 0) + 1;
      }
    } else {
      red++;
    }
  }

  const pct = (n: number) => Math.round(((n / total) * 100) * 10) / 10;

  return {
    greenCount: green,
    amberCount: amber,
    redCount: red,
    totalZones: total,
    greenPct: pct(green),
    amberPct: pct(amber),
    redPct: pct(red),
    amberBreakdown: breakdown,
  };
}
