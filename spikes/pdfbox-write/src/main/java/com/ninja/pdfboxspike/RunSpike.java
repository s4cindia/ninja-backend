package com.ninja.pdfboxspike;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

/**
 * Batch runner + report generator. Mirrors {@code spikes/pikepdf-write/run_spike.py}:
 *
 *   1. Read ground_truth.json (documents[] with documentId, pdfPath,
 *      contentType, publisher, zones[]).
 *   2. For each document, write a tagged PDF via {@link WriteTaggedPdf}.
 *   3. Run veraPDF in PDF/UA-1 mode (binary path from VERAPDF_PATH env).
 *   4. Emit spike_results.json + spike_report.md to output dir.
 *   5. Print GO/NO-GO based on >=95% pass rate threshold.
 *
 * Invocation: {@code java -jar pdfbox-write-spike.jar <ground_truth.json> <output_dir>}
 */
public final class RunSpike {

    private RunSpike() {}

    public static void main(String[] args) throws Exception {
        if (args.length < 2) {
            System.err.println("Usage: java -jar pdfbox-write-spike.jar <ground_truth.json> <output_dir>");
            System.exit(2);
        }

        File groundTruth = new File(args[0]);
        File outputDir = new File(args[1]);
        outputDir.mkdirs();
        File bundleRoot = groundTruth.getAbsoluteFile().getParentFile();

        ObjectMapper mapper = new ObjectMapper();
        JsonNode root = mapper.readTree(groundTruth);
        JsonNode docs = root.get("documents");
        if (docs == null || !docs.isArray()) {
            System.err.println("ground_truth.json missing documents array");
            System.exit(2);
        }

        System.out.println();
        System.out.println("Ninja PDFBox Write Spike");
        System.out.println("Documents: " + docs.size());
        System.out.println("Output:    " + outputDir.getAbsolutePath());
        System.out.println();

        List<Map<String, Object>> results = new ArrayList<>();
        int total = docs.size();
        int i = 0;
        for (JsonNode doc : docs) {
            i++;
            String docId = doc.path("documentId").asText("doc-" + i);
            String pdfPath = doc.path("pdfPath").asText("");
            String contentType = doc.path("contentType").asText("unknown");
            String publisher = doc.path("publisher").asText("unknown");

            File pdfFile = resolveAgainst(bundleRoot, pdfPath);
            int zoneCount = doc.path("zones").isArray() ? doc.path("zones").size() : 0;
            System.out.printf("[%d/%d] %s (%s, %d zones)...%n", i, total, docId, contentType, zoneCount);

            if (!pdfFile.exists()) {
                results.add(skipped(docId, contentType, publisher, "PDF not found: " + pdfFile.getAbsolutePath()));
                System.out.println("  SKIPPED - PDF not found");
                continue;
            }

            List<WriteTaggedPdf.Zone> zones = parseZones(doc.path("zones"));
            File outputPdf = new File(outputDir, docId + "_tagged.pdf");

            long t0 = System.nanoTime();
            WriteTaggedPdf.Result wr = WriteTaggedPdf.writeTaggedPdf(pdfFile, zones, outputPdf);
            long writeMs = Duration.ofNanos(System.nanoTime() - t0).toMillis();

            if (!wr.success) {
                Map<String, Object> row = baseRow(docId, contentType, publisher);
                row.put("status", "WRITE_FAILED");
                row.put("error", wr.errorMessage);
                results.add(row);
                System.out.println("  WRITE FAILED: " + wr.errorMessage);
                continue;
            }

            Validation v = runVerapdf(outputPdf);
            String status = v.passed == null ? "NO_VALIDATOR" : (v.passed ? "PASS" : "FAIL");

            Map<String, Object> row = baseRow(docId, contentType, publisher);
            row.put("status", status);
            row.put("zoneCount", wr.zoneCount);
            row.put("writeMs", writeMs);
            row.put("failures", v.failures);
            results.add(row);

            String symbol = "NO_VALIDATOR".equals(status) ? "?" : ("PASS".equals(status) ? "v" : "x");
            System.out.printf("  %s %s - %d zones, %dms%n", symbol, status, wr.zoneCount, writeMs);
        }

        Map<String, Object> resultsJson = new LinkedHashMap<>();
        resultsJson.put("documents", results);
        Files.writeString(
            new File(outputDir, "spike_results.json").toPath(),
            mapper.writerWithDefaultPrettyPrinter().writeValueAsString(resultsJson),
            StandardCharsets.UTF_8
        );

        generateReport(results, outputDir);
        System.out.println();
        System.out.println("Results: " + new File(outputDir, "spike_results.json").getAbsolutePath());
    }

    private static List<WriteTaggedPdf.Zone> parseZones(JsonNode arr) {
        List<WriteTaggedPdf.Zone> out = new ArrayList<>();
        if (arr == null || !arr.isArray()) return out;
        for (JsonNode z : arr) {
            WriteTaggedPdf.Zone zone = new WriteTaggedPdf.Zone();
            zone.pageNumber = z.path("pageNumber").asInt(1);
            zone.type = z.path("type").asText(null);
            zone.operatorLabel = z.path("operatorLabel").asText(null);
            zone.altText = z.path("altText").asText(null);
            if (z.has("headingLevel") && !z.path("headingLevel").isNull()) {
                zone.headingLevel = z.path("headingLevel").asInt(1);
            }
            JsonNode b = z.path("bounds");
            if (b != null && b.isObject()) {
                WriteTaggedPdf.BBox bb = new WriteTaggedPdf.BBox();
                bb.x = b.path("x").asDouble(0);
                bb.y = b.path("y").asDouble(0);
                bb.w = b.path("w").asDouble(0);
                bb.h = b.path("h").asDouble(0);
                zone.bounds = bb;
            }
            out.add(zone);
        }
        return out;
    }

    private static File resolveAgainst(File bundleRoot, String pdfPath) {
        File f = new File(pdfPath);
        if (f.isAbsolute()) return f;
        return new File(bundleRoot, pdfPath);
    }

    /** Lightweight veraPDF run result. */
    static class Validation {
        Boolean passed;        // true / false / null (no validator)
        List<String> failures;
        String raw;
    }

    static Validation runVerapdf(File pdf) {
        String bin = System.getenv().getOrDefault("VERAPDF_PATH", "C:/verapdf/verapdf.bat");
        Validation v = new Validation();
        v.failures = new ArrayList<>();
        try {
            ProcessBuilder pb = new ProcessBuilder(bin, "--flavour", "ua1", pdf.getAbsolutePath());
            pb.redirectErrorStream(true);
            Process p = pb.start();
            boolean finished = p.waitFor(60, TimeUnit.SECONDS);
            if (!finished) {
                p.destroyForcibly();
                v.passed = false;
                v.failures.add("Validation timed out");
                return v;
            }
            String output = new String(p.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
            v.raw = output.length() > 500 ? output.substring(0, 500) : output;
            v.passed = output.contains("isCompliant=\"true\"");
            for (String line : output.split("\n")) {
                if (line.contains("status=\"failed\"")) {
                    v.failures.add(line.strip());
                    if (v.failures.size() >= 10) break;
                }
            }
        } catch (IOException notFound) {
            v.passed = null; // NO_VALIDATOR
            v.raw = "veraPDF not found at " + bin + " — skipping validation";
        } catch (Exception e) {
            v.passed = false;
            v.failures.add("Validation error: " + e.getMessage());
        }
        return v;
    }

    private static Map<String, Object> baseRow(String docId, String contentType, String publisher) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("documentId", docId);
        row.put("contentType", contentType);
        row.put("publisher", publisher);
        return row;
    }

    private static Map<String, Object> skipped(String docId, String ct, String pub, String reason) {
        Map<String, Object> row = baseRow(docId, ct, pub);
        row.put("status", "SKIPPED");
        row.put("reason", reason);
        return row;
    }

    /**
     * Generate spike_report.md — same shape and headings as the pikepdf
     * spike's Python report so they're trivially comparable.
     */
    @SuppressWarnings("unchecked")
    static void generateReport(List<Map<String, Object>> results, File outputDir) throws IOException {
        int total = results.size();
        int passed = (int) results.stream().filter(r -> "PASS".equals(r.get("status"))).count();
        int failed = (int) results.stream().filter(r -> "FAIL".equals(r.get("status"))).count();
        int skipped = (int) results.stream().filter(r -> {
            String s = String.valueOf(r.get("status"));
            return "SKIPPED".equals(s) || "WRITE_FAILED".equals(s);
        }).count();
        int noVal = (int) results.stream().filter(r -> "NO_VALIDATOR".equals(r.get("status"))).count();

        int denom = total - skipped - noVal;
        double passRate = denom > 0 ? (double) passed / denom : 0.0;
        boolean go = passRate >= 0.95;

        Map<String, int[]> ctStats = new LinkedHashMap<>(); // {ct: [pass, fail, total]}
        for (Map<String, Object> r : results) {
            String ct = String.valueOf(r.get("contentType"));
            int[] s = ctStats.computeIfAbsent(ct, k -> new int[3]);
            if ("PASS".equals(r.get("status"))) s[0]++;
            else if ("FAIL".equals(r.get("status"))) s[1]++;
            s[2]++;
        }

        Map<String, Integer> failureCats = new LinkedHashMap<>();
        for (Map<String, Object> r : results) {
            Object failuresObj = r.get("failures");
            if (failuresObj instanceof List<?> failures) {
                for (Object f : failures) {
                    String key = String.valueOf(f);
                    failureCats.merge(key, 1, Integer::sum);
                }
            }
        }

        List<String> lines = new ArrayList<>();
        lines.add("# Ninja PDFBox Write Spike - Report");
        lines.add("");
        lines.add("## Summary");
        lines.add("");
        lines.add("| Metric | Value |");
        lines.add("|--------|-------|");
        lines.add("| Total documents | " + total + " |");
        lines.add("| Passed (PAC/veraPDF) | " + passed + " |");
        lines.add("| Failed | " + failed + " |");
        lines.add("| Skipped (PDF not found / write failed) | " + skipped + " |");
        lines.add("| No validator | " + noVal + " |");
        lines.add(String.format("| **Overall pass rate** | **%.1f%%** |", passRate * 100));
        lines.add("| **Go/No-Go threshold** | **95%** |");
        lines.add("| **Decision** | **" + (go ? "GO" : "NO-GO") + "** |");
        lines.add("");
        lines.add("## Per Content Type");
        lines.add("");
        lines.add("| Content Type | Pass | Fail | Rate |");
        lines.add("|-------------|------|------|------|");
        for (Map.Entry<String, int[]> e : ctStats.entrySet()) {
            int[] s = e.getValue();
            double rate = s[2] > 0 ? (double) s[0] / s[2] : 0.0;
            lines.add(String.format("| %s | %d | %d | %.1f%% |", e.getKey(), s[0], s[1], rate * 100));
        }
        lines.add("");
        lines.add("## Failure Categories");
        lines.add("");
        if (failureCats.isEmpty()) {
            lines.add("No failures recorded.");
        } else {
            lines.add("| Failure | Count |");
            lines.add("|---------|-------|");
            failureCats.entrySet().stream()
                .sorted((a, b) -> Integer.compare(b.getValue(), a.getValue()))
                .forEach(e -> lines.add("| " +
                    (e.getKey().length() > 80 ? e.getKey().substring(0, 80) : e.getKey())
                    + " | " + e.getValue() + " |"));
        }
        lines.add("");
        lines.add("## Recommendation");
        lines.add("");
        lines.add(go
            ? "**PROCEED to Phase 2 write step migration with PDFBox**"
            : "**EVALUATE alternatives — pass rate below 95% threshold**");
        lines.add("");

        Files.writeString(new File(outputDir, "spike_report.md").toPath(),
            String.join("\n", lines), StandardCharsets.UTF_8);

        System.out.println();
        System.out.println("==================================================");
        System.out.println("Go/No-Go: " + (go ? "GO" : "NO-GO"));
        System.out.printf("Pass rate: %.1f%% (%s 95%% threshold)%n",
            passRate * 100, go ? ">=" : "<");
        System.out.println("Report: " + new File(outputDir, "spike_report.md").getAbsolutePath());
        System.out.println("==================================================");
    }

}
