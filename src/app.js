import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import cookieParser from "cookie-parser";
import { errorHandler } from "./middleware/errorHandler.js";
import path from "path";
import { fileURLToPath } from "url";
import allRoutes from "./routes/index.js";
import fmsRoutes from "./routes/fms.js";

dotenv.config();

const app = express();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(
  cors({
    origin: true,
    credentials: true,
  }),
);
app.use(express.json());
app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));

app.use("/uploads", express.static(path.join(__dirname, "../uploads")));

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

const frontendPath = path.join(__dirname, "../../frontend/dist");

app.use(express.static(frontendPath));

app.get(/(.*)/, (_, res) => {
  res.sendFile(path.resolve(frontendPath, "index.html"));
});

app.use(errorHandler);

export default app;
//GLOABL COMMIT
