/**
 * Artifact Marker
 *
 * Detects header/footer regions on each page. Reading-order issues flagged
 * for elements in these regions are almost certainly page decorations
 * (running headers, page numbers, footers) that should be marked as
 * PDF artifacts, not accessibility failures in the body content.
 */

import { PdfParseResult } from '../pdf-comprehensive-parser.service';

export interface ArtifactRegion {
  type: 'header' | 'footer';
  yMin: number;
  yMax: number;
}

// Top 12% of page height is treated as header zone
const HEADER_RATIO = 0.12;
// Bottom 10% of page height is treated as footer zone
const FOOTER_RATIO = 0.90;

export class ArtifactMarker {
  /**
   * Build a map of pageNumber → artifact regions for every page in the document.
   * Synchronous — no I/O required.
   */
  detectArtifactRegions(parsed: PdfParseResult): Map<number, ArtifactRegion[]> {
    const regions = new Map<number, ArtifactRegion[]>();

    for (const page of parsed.pages) {
      const headerCutoff = page.height * HEADER_RATIO;
      const footerCutoff = page.height * FOOTER_RATIO;

      regions.set(page.pageNumber, [
        { type: 'header', yMin: 0,           yMax: headerCutoff },
        { type: 'footer', yMin: footerCutoff, yMax: page.height  },
      ]);
    }

    return regions;
  }

  /**
   * Returns true if the given y coordinate (in PDF points, origin at bottom-left)
   * falls inside a header or footer region for the specified page.
   *
   * PDF coordinate systems place y=0 at the bottom, so:
   *   header → y > (height - headerCutoff)
   *   footer → y < footerCutoff (from bottom)
   *
   * We store regions with y measured from top (viewer coordinates) to keep
   * things simple. Callers that have raw PDF coordinates should convert first.
   */
  isInArtifactRegion(
    y: number,
    pageNumber: number,
    regions: Map<number, ArtifactRegion[]>
  ): ArtifactRegion | null {
    const pageRegions = regions.get(pageNumber);
    if (!pageRegions) return null;

    for (const region of pageRegions) {
      if (y >= region.yMin && y <= region.yMax) return region;
    }
    return null;
  }
}

export const artifactMarker = new ArtifactMarker();
