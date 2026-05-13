package com.ninja.pdfboxspike;

import org.apache.pdfbox.cos.COSDictionary;
import org.apache.pdfbox.cos.COSName;
import org.apache.pdfbox.cos.COSStream;
import org.apache.pdfbox.cos.COSString;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDDocumentCatalog;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.common.PDMetadata;
import org.apache.pdfbox.pdmodel.documentinterchange.logicalstructure.PDMarkInfo;
import org.apache.pdfbox.pdmodel.documentinterchange.logicalstructure.PDStructureElement;
import org.apache.pdfbox.pdmodel.documentinterchange.logicalstructure.PDStructureTreeRoot;
import org.apache.pdfbox.pdmodel.interactive.viewerpreferences.PDViewerPreferences;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * Core spike: takes a PDF + zone ground truth and writes a Tagged PDF
 * structure tree using PDFBox. Sets the PDF/UA-1 requirements that
 * veraPDF checks at the document level:
 *   - /MarkInfo Marked=true (7.1)
 *   - /Lang at document root (7.2)
 *   - /ViewerPreferences DisplayDocTitle=true (7.1 test 10)
 *   - XMP /pdfuaid:part=1 (7.1 test 8)
 *   - /StructTreeRoot with /RoleMap → standard types
 *   - /Document → page-grouped structure elements
 *
 * Mirrors {@code spikes/pikepdf-write/write_tagged_pdf.py} in shape so
 * the two spikes' results are comparable.
 *
 * Limitations (intentional, time-boxed):
 *   - Does not bind /StructElem objects to content via /MCID. veraPDF
 *     PDF/UA-1 7.1 test 3 will still flag pages whose existing content
 *     isn't covered, but the structure tree itself will validate.
 *   - Does not rewrite running headers/footers as /Artifact in content
 *     streams; they are simply excluded from the struct tree.
 *   - Treats annotations as out-of-scope for the spike.
 */
public final class WriteTaggedPdf {

    public static class Result {
        public final boolean success;
        public final String outputPath;
        public final int zoneCount;
        public final String errorMessage;

        Result(boolean success, String outputPath, int zoneCount, String errorMessage) {
            this.success = success;
            this.outputPath = outputPath;
            this.zoneCount = zoneCount;
            this.errorMessage = errorMessage;
        }

        static Result ok(String path, int zoneCount) { return new Result(true, path, zoneCount, null); }
        static Result fail(String path, String message) { return new Result(false, path, 0, message); }
    }

    /** Minimal zone shape consumed by the writer — matches ground_truth.json entries. */
    public static class Zone {
        public int pageNumber;
        public BBox bounds;
        public String type;
        public String operatorLabel;
        public String altText;
        public Integer headingLevel;
    }

    public static class BBox {
        public double x, y, w, h;
    }

    private WriteTaggedPdf() {}

    public static Result writeTaggedPdf(File inputPdf, List<Zone> zones, File outputPdf) {
        try (PDDocument pdf = org.apache.pdfbox.Loader.loadPDF(inputPdf)) {
            PDDocumentCatalog catalog = pdf.getDocumentCatalog();

            // 1) MarkInfo — required for any Tagged PDF.
            PDMarkInfo markInfo = new PDMarkInfo();
            markInfo.setMarked(true);
            catalog.setMarkInfo(markInfo);

            // 2) Document language at root.
            catalog.setLanguage("en-US");

            // 3) ViewerPreferences/DisplayDocTitle = true (7.1 test 10).
            PDViewerPreferences viewerPrefs = new PDViewerPreferences(new COSDictionary());
            viewerPrefs.setShowTitleBar(true);
            catalog.setViewerPreferences(viewerPrefs);

            // 4) Document title — required when DisplayDocTitle is true.
            if (pdf.getDocumentInformation() != null) {
                if (pdf.getDocumentInformation().getTitle() == null
                        || pdf.getDocumentInformation().getTitle().isBlank()) {
                    pdf.getDocumentInformation().setTitle("Tagged PDF");
                }
            }

            // 5) XMP metadata declaring pdfuaid:part = 1 (7.1 test 8).
            String xmp = ""
                + "<?xpacket begin=\"﻿\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>"
                + "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\">"
                + " <rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">"
                + "  <rdf:Description rdf:about=\"\""
                + "    xmlns:dc=\"http://purl.org/dc/elements/1.1/\""
                + "    xmlns:pdfuaid=\"http://www.aiim.org/pdfua/ns/id/\">"
                + "   <pdfuaid:part>1</pdfuaid:part>"
                + "   <dc:title><rdf:Alt>"
                + "     <rdf:li xml:lang=\"x-default\">Tagged PDF</rdf:li>"
                + "   </rdf:Alt></dc:title>"
                + "  </rdf:Description>"
                + " </rdf:RDF>"
                + "</x:xmpmeta>"
                + "<?xpacket end=\"w\"?>";
            COSStream metadataStream = pdf.getDocument().createCOSStream();
            try (var os = metadataStream.createOutputStream()) {
                os.write(xmp.getBytes(StandardCharsets.UTF_8));
            }
            metadataStream.setItem(COSName.TYPE, COSName.METADATA);
            metadataStream.setItem(COSName.SUBTYPE, COSName.getPDFName("XML"));
            PDMetadata md = new PDMetadata(metadataStream);
            catalog.setMetadata(md);

            // 6) Structure tree root with role map so any non-standard child
            //    types still validate (covers PDF/UA-1 7.3 test 1). The
            //    PDStructureTreeRoot.setRoleMap signature has varied across
            //    PDFBox minor versions; setting the COS item directly side-
            //    steps that and matches the PDF 1.7 spec exactly.
            PDStructureTreeRoot treeRoot = new PDStructureTreeRoot();
            COSDictionary roleMap = new COSDictionary();
            for (String role : new String[] {
                "P", "Table", "Figure", "Caption", "Note",
                "H", "H1", "H2", "H3", "H4", "H5", "H6"
            }) {
                roleMap.setItem(COSName.getPDFName(role), COSName.getPDFName(role));
            }
            treeRoot.getCOSObject().setItem(COSName.getPDFName("RoleMap"), roleMap);
            catalog.setStructureTreeRoot(treeRoot);

            // 7) Group zones by page (skipping artefacts), in zone-input order.
            Map<Integer, List<Zone>> byPage = new TreeMap<>();
            for (Zone z : zones) {
                if (z == null || z.type == null || ZoneToTags.isArtifact(z.type)) continue;
                byPage.computeIfAbsent(z.pageNumber, k -> new ArrayList<>()).add(z);
            }

            // 8) Build a Document → page → element hierarchy. Each StructElem
            //    references its page (so PDF readers can map back) and uses
            //    the canonical PDF tag role.
            PDStructureElement docElem = new PDStructureElement("Document", treeRoot);
            treeRoot.appendKid(docElem);

            int zoneCount = 0;
            int totalPages = pdf.getNumberOfPages();
            for (Map.Entry<Integer, List<Zone>> entry : byPage.entrySet()) {
                int pageNumber = entry.getKey();
                int pageIdx = pageNumber - 1;
                if (pageIdx < 0 || pageIdx >= totalPages) continue;
                PDPage page = pdf.getPage(pageIdx);

                for (Zone zone : entry.getValue()) {
                    String chosenType = zone.operatorLabel != null && !zone.operatorLabel.isBlank()
                        ? zone.operatorLabel : zone.type;
                    String role = "section-header".equals(chosenType)
                        ? ZoneToTags.getHeadingTag(zone.headingLevel == null ? 1 : zone.headingLevel)
                        : ZoneToTags.getPdfRole(chosenType);

                    PDStructureElement elem = new PDStructureElement(role, docElem);
                    elem.setPage(page);
                    if ("Figure".equals(role) && zone.altText != null && !zone.altText.isBlank()) {
                        elem.setAlternateDescription(zone.altText);
                    }
                    if ("Note".equals(role)) {
                        // Note tags require an ID entry (PDF/UA 7.9 test 1).
                        elem.getCOSObject().setItem(
                            COSName.getPDFName("ID"),
                            new COSString("note-p" + pageNumber + "-" + zoneCount)
                        );
                    }
                    docElem.appendKid(elem);
                    zoneCount++;
                }
            }

            pdf.save(outputPdf);
            return Result.ok(outputPdf.getAbsolutePath(), zoneCount);
        } catch (IOException ioe) {
            return Result.fail(outputPdf.getAbsolutePath(), ioe.getMessage());
        } catch (Exception e) {
            return Result.fail(outputPdf.getAbsolutePath(), e.toString());
        }
    }

}
