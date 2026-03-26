import multer from "multer";
import path from "path";
import fs from "fs";
import crypto from "crypto";
const uploadsDir = path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  // destination: function (req, file, cb) {
  //     cb(null, uploadsDir);
  // },
  destination: async function (req, file, cb) {
    try {
      const now = new Date();
      const day = String(now.getDate()).padStart(2, "0");
      const month = String(now.getMonth() + 1).padStart(2, "0");
      const year = now.getFullYear();

      const dateFolder = `${day}_${month}_${year}`;
      let taskId = req.body?.title || "task";

      const folderName = `${dateFolder}_${taskId}`;
      const finalPath = path.join(uploadsDir, folderName);

      // ✅ store folder name in request
      req.uploadFolder = folderName;

      if (!fs.existsSync(finalPath)) {
        fs.mkdirSync(finalPath, { recursive: true });
      }

      cb(null, finalPath);
    } catch (err) {
      cb(err);
    }
  },
  //     filename: function (req, file, cb) {
  //     const originalSafeName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, "-");
  //     let finalName = originalSafeName;
  //     let filePath = path.join(uploadsDir, finalName);
  //     let counter = 2;
  //     req.fileWasRenamed = false;

  //     while (fs.existsSync(filePath)) {
  //       req.fileWasRenamed = true;
  //       const fileExt = path.extname(originalSafeName);
  //       const fileBase = path.basename(originalSafeName, fileExt);
  //       finalName = `${fileBase}-${counter}${fileExt}`;
  //       filePath = path.join(uploadsDir, finalName);
  //       counter++;
  //     }
  //     cb(null, finalName);
  //   },
  filename: function (req, file, cb) {
    try {
      const ext = path.extname(file.originalname);

      // 🔐 Create encrypted/random name
      const encryptedName = crypto.randomBytes(16).toString("hex");

      const finalName = `${encryptedName}${ext}`;

      cb(null, finalName);
    } catch (err) {
      cb(err);
    }
  },
});

const upload = multer({ storage });

export default upload;
