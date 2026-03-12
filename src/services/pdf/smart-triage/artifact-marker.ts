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

// Top 12% of page height is treated as header zone (PDF bottom-left origin: high y values)
const HEADER_HEIGHT_RATIO = 0.12;
// Bottom 10% of page height is treated as footer zone (PDF bottom-left origin: low y values)
const FOOTER_HEIGHT_RATIO = 0.10;

export class ArtifactMarker {
  /**
   * Build a map of pageNumber → artifact regions for every page in the document.
   * Regions are stored in PDF coordinate space (origin at bottom-left):
   *   header → y > (page.height - headerHeight)
   *   footer → y < footerHeight
   * Synchronous — no I/O required.
   */
  detectArtifactRegions(parsed: PdfParseResult): Map<number, ArtifactRegion[]> {
    const regions = new Map<number, ArtifactRegion[]>();

    for (const page of parsed.pages) {
      const headerHeight = page.height * HEADER_HEIGHT_RATIO;
      const footerHeight = page.height * FOOTER_HEIGHT_RATIO;

      regions.set(page.pageNumber, [
        // Header: top 12% — high y values in PDF coordinates
        { type: 'header', yMin: page.height - headerHeight, yMax: page.height },
        // Footer: bottom 10% — low y values in PDF coordinates
        { type: 'footer', yMin: 0, yMax: footerHeight },
      ]);
    }

    return regions;
  }

  /**
   * Returns the artifact region if the given y coordinate (in PDF points, bottom-left origin)
   * falls inside a header or footer region for the specified page, or null otherwise.
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
