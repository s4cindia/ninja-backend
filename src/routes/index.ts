import { Router } from "express";
import { config } from "../config";
import authRoutes from "./auth.routes";
import usersRoutes from "./users.routes";
import productsRoutes from "./products.routes";
import jobsRoutes from "./jobs.routes";
import filesRoutes from "./files.routes";
import aiRoutes from "./ai.routes";
import pdfRoutes from "./pdf.routes";
import accessibilityRoutes from "./accessibility.routes";
import complianceRoutes from "./compliance.routes";
import dashboardRoutes from "./dashboard.routes";
import acrRoutes from "./acr.routes";
import confidenceRoutes from "./confidence.routes";
import verificationRoutes from "./verification.routes";
import exportsRoutes from "./exports.routes";
import altTextRoutes from "./alt-text.routes";
import epubRoutes from "./epub.routes";
import feedbackRoutes from "./feedback.routes";

const router = Router();

router.get("/", (req, res) => {
  res.json({
    name: "Ninja Platform API",
    version: config.version,
    endpoints: {
      health: "GET /health",
      auth: {
        register: "POST /api/v1/auth/register",
        login: "POST /api/v1/auth/login",
        logout: "POST /api/v1/auth/logout",
        refresh: "POST /api/v1/auth/refresh",
        me: "GET /api/v1/auth/me",
      },
      users: {
        list: "GET /api/v1/users",
        get: "GET /api/v1/users/:id",
        update: "PATCH /api/v1/users/:id",
        delete: "DELETE /api/v1/users/:id",
      },
      products: {
        list: "GET /api/v1/products",
        create: "POST /api/v1/products",
        get: "GET /api/v1/products/:id",
        update: "PATCH /api/v1/products/:id",
        delete: "DELETE /api/v1/products/:id",
        jobs: "GET /api/v1/products/:id/jobs",
        vpats: "GET /api/v1/products/:id/vpats",
      },
      jobs: {
        list: "GET /api/v1/jobs",
        create: "POST /api/v1/jobs",
        get: "GET /api/v1/jobs/:id",
        status: "GET /api/v1/jobs/:id/status",
        cancel: "DELETE /api/v1/jobs/:id",
        results: "GET /api/v1/jobs/:id/results",
      },
      files: {
        upload: "POST /api/v1/files/upload",
        get: "GET /api/v1/files/:id",
        download: "GET /api/v1/files/:id/download",
        delete: "DELETE /api/v1/files/:id",
      },
      ai: {
        health: "GET /api/v1/ai/health",
        test: "POST /api/v1/ai/test",
      },
    },
  });
});

router.use("/auth", authRoutes);
router.use("/users", usersRoutes);
router.use("/products", productsRoutes);
router.use("/jobs", jobsRoutes);
router.use("/files", filesRoutes);
router.use("/ai", aiRoutes);
router.use("/pdf", pdfRoutes);
router.use("/accessibility", accessibilityRoutes);
router.use("/compliance", complianceRoutes);
router.use("/dashboard", dashboardRoutes);
router.use("/acr", acrRoutes);
router.use("/confidence", confidenceRoutes);
router.use("/verification", verificationRoutes);
router.use("/exports", exportsRoutes);
router.use("/alt-text", altTextRoutes);
router.use("/epub", epubRoutes);
router.use("/feedback", feedbackRoutes);

export default router;
