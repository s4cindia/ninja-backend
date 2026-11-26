export type CanonicalZoneType =
  | 'paragraph'
  | 'section-header'
  | 'table'
  | 'figure'
  | 'caption'
  | 'footnote'
  | 'header'
  | 'footer'
  | 'list-item'
  | 'toci'
  | 'formula';

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
  confidence: number | null;
  source: 'docling' | 'pdfxt' | 'operator' | 'yolo';
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

// The YOLO zone-detector service returns the same wire shape as Docling, so the
// client mirrors the docling submit-and-poll flow. Labels are already the
// canonical class names (the model's class list), unlike Docling's raw labels.
export interface YoloServiceResponse {
  jobId: string;
  zones: Array<{
    page: number;
    bbox: { x: number; y: number; w: number; h: number };
    label: string;
    confidence?: number;
  }>;
  processingTimeMs: number;
  /** Self-describes what produced this exact result (zone-detector-service's
   *  own cuDNN-determinism/provenance fix) -- the zone-detection cache uses
   *  weightsSha256 as a safety net against its own SSM-URI+ETag identity
   *  proxy. Optional: an older/degraded service response might not carry it. */
  modelInfo?: {
    device?: string;
    weightsSha256?: string | null;
    ultralyticsVersion?: string;
    renderDpi?: number;
    maxEdge?: number;
    imgsz?: number;
    conf?: number;
  };
}
