import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import cookieParser from "cookie-parser";
import compression from "compression"; // Added compression
import { errorHandler } from "./middleware/errorHandler.js";
import path from "path";
import { fileURLToPath } from "url";
import allRoutes from "./routes/index.js";

dotenv.config();

const app = express();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Enable response compression to make APIs fast
app.use(compression());

app.use(
  cors({
    origin: true,
    credentials: true,
  })
);
app.use(express.json());
app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));

// Uploads static route
app.use("/uploads", express.static(path.join(__dirname, "../uploads")));

// Fast Health Check Endpoint (For testing cPanel latency)
app.get("/api/health", (req, res) => {
  res.status(200).json({ status: "ok", timestamp: new Date() });
});

// Main API Routes
app.use("/api/v1", allRoutes);

app.get("/download/:filename", (req, res) => {
  const { filename } = req.params;
  const filePath = path.join(__dirname, "../uploads", filename);
  res.download(filePath, (err) => {
    if (err) {
      console.error("File download error:", err);
      res.status(404).send("File not found");
    }
  });
});

// Error Handler Middleware
app.use(errorHandler);

export default app;