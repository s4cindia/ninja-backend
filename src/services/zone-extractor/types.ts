export type CanonicalZoneType =
  | 'paragraph'
  | 'section-header'
  | 'table'
  | 'figure'
  | 'caption'
  | 'footnote'
  | 'header'
  | 'footer';

export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DetectedZone {
  pageNumber: number;
  bbox: BBox;
  zoneType: CanonicalZoneType;
  confidence: number;
  source: 'docling' | 'pdfxt' | 'operator';
  doclingLabel?: string;
}

export interface DoclingServiceResponse {
  jobId: string;
  zones: Array<{
    page: number;
    bbox: { x: number; y: number; w: number; h: number };
    label: string;
    confidence?: number;
  }>;
  processingTimeMs: number;
}
