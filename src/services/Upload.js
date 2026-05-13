import multer from "multer";
import path from "path";
import fs from "fs";

const getDestination = (file) => {
  switch (file.fieldname) {
    case "logo":
      return "uploads/companies/logos";

    case "favicon":
      return "uploads/companies/favicons";

    case "profilePhoto":
      return "uploads/users/profiles";

    default:
      return "uploads/misc";
  }
};

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = getDestination(file);

    // auto create folder if not exists
    fs.mkdirSync(dir, { recursive: true });

    cb(null, dir);
  },

  filename: (req, file, cb) => {
    const uniqueName =
      `${Date.now()}-${Math.round(Math.random() * 1e9)}` +
      path.extname(file.originalname);

    cb(null, uniqueName);
  },
});

const fileFilter = (req, file, cb) => {
  const allowed = [
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/webp",
    "image/svg+xml",
    "image/x-icon",
  ];

  if (!allowed.includes(file.mimetype)) {
    return cb(new Error("Invalid file type"), false);
  }

  cb(null, true);
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
});

export default upload;
