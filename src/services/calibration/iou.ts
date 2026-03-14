export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function calculateIoU(a: BBox, b: BBox): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);

  if (x2 <= x1 || y2 <= y1) return 0;

  const intersection = (x2 - x1) * (y2 - y1);
  const union = a.w * a.h + b.w * b.h - intersection;

  if (union <= 0) return 0;

  return Math.min(1, Math.max(0, intersection / union));
}
