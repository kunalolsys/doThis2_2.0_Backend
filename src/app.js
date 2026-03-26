import express from "express"
import cors from "cors"
import dotenv from "dotenv"
import cookieParser from "cookie-parser"
import { errorHandler } from "./middleware/errorHandler.js"
import path from "path"
import { fileURLToPath } from "url"
import allRoutes from "./routes/index.js" // Import ko upar rakhein

dotenv.config()

const app = express()

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 1. CORS Update (Live URL add kiya)
// app.use(cors({
//   origin: ["http://localhost:5173", "http://fms.dothis2.com"],
//   credentials: true
// }));
app.use(cors({
  origin: true,
  credentials: true
}));
app.use(express.json())
app.use(cookieParser())
app.use(express.urlencoded({ extended: true }));

// 2. Uploads Path (Assuming 'uploads' folder 'src' ke bahar 'backend' mein hai)
// Agar uploads folder 'src' ke andar hai to './uploads' use karein.
// Agar 'backend' folder ke root mein hai (common practice) to ye sahi hai:
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// 3. API Routes (SABSE PEHLE AANA CHAHIYE)
app.use("/api/v1", allRoutes)

// 4. Download Route
app.get('/download/:filename', (req, res) => {
  const { filename } = req.params;
  const filePath = path.join(__dirname, '../uploads', filename);
  res.download(filePath, (err) => {
    if (err) {
      console.error("File download error:", err);
      res.status(404).send('File not found');
    }
  });
});

// 5. Frontend Setup (CRITICAL FIX FOR SRC FOLDER)
// Agar server.js 'src' mein hai:
// ../  -> Backend folder mein pahunche
// ../../ -> Root folder mein pahunche (jahan backend aur frontend dono hain)
const frontendPath = path.join(__dirname, '../../frontend/dist');

app.use(express.static(frontendPath));

// Catch-All Route (Regex fix + Path fix)
app.get(/(.*)/, (_, res) => {
  res.sendFile(path.resolve(frontendPath, 'index.html'));
});

// Error Handler
app.use(errorHandler)

export default app