import app from "./app.js";
import mongoose from "mongoose";
import dotenv from "dotenv";
import http from "http";
import startCronJobs from "./cron/assignRecurringTask.js";
import { runDependencyCron } from "./cron/dependancyCron.js";

import startTaskStatusCron from "./cron/taskStatusUpdate.js";
import startVisibilityCron from "./cron/taskVisibilityCron.js";
import startFmsVisibilityCron from "./cron/fmsInstanceTaskVisibilityCron.js";

// import Remark from './models/Remark.js';
import User from "./models/User.js";

// --- NEW IMPORT FOR LOGGING ---
import ServerLog from "./models/ServerLog.js";
import startFMSProgressCronJobs from "./cron/fmsInstanceTaskProgressCron.js";
import startRecurringFmsTaskJob from "./cron/assignRecurringFmsTask.js";
import { initSocket } from "./socket.js";
import "../scripts/seedSuperRolesAndUser.js";
import ModuleSetting from "./models/ModuleSetting.js";
import "./services/telegram/telegramBOT.js";
dotenv.config();

const server = http.createServer(app);

// --- LOGGING FUNCTION START ---
const logToDb = async (level, message) => {
  try {
    // Console par bhi dikhaye taaki development me easy rahe
    console.log(`[${level}] ${message}`);

    // Agar Database connected hai, tabhi save kare
    if (mongoose.connection.readyState === 1) {
      await ServerLog.create({ level, message });
    }
  } catch (error) {
    console.error("Logging System Error:", error.message);
  }
};
// --- LOGGING FUNCTION END ---

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map((origin) => origin.trim())
  : [
      "https://fms.dothis2.com",
      "http://localhost:4000",
      "http://192.168.1.4:4000",
    ]; // Default allowed origins

//**Initialize Socket IO */
initSocket(server);

const PORT = process.env.PORT || 4000;
// Accept either MONGODB_URI or MONGO_URI to be resilient to .env naming
const MONGODB_URI =
  process.env.MONGODB_URI ||
  process.env.MONGO_URI ||
  "mongodb://localhost:27017/dothis2";

// --- DATABASE EVENT LISTENERS (Live Monitoring) ---
mongoose.connection.on("connected", () => {
  logToDb("SUCCESS", "MongoDB connection established successfully.");
});

mongoose.connection.on("error", (err) => {
  logToDb("ERROR", `MongoDB Connection Error: ${err.message}`);
});

mongoose.connection.on("disconnected", () => {
  console.log("WARNING: MongoDB disconnected");
  // Note: Disconnect hone par DB me write nahi ho payega, isliye console.log rakha hai
});

// --- MAIN CONNECTION ---
mongoose
  .connect(MONGODB_URI)
  .then(async () => {
    // Console log already event listener 'connected' se handle ho jayega,
    // par server start ka message hum yaha dalenge.

    server.listen(PORT, async () => {
      const msg = `Server is running on port ${PORT}`;
      // Console aur DB dono jagah jayega
      logToDb("INFO", msg);
      // Start background cron jobs after server is up
      try {
        const moduleSettings = await ModuleSetting.find({
          moduleKey: { $in: ["FMS_ENGINE", "DO_THIS2"] },
        }).lean();

        const isModuleEnabled = (key) => {
          const mod = moduleSettings.find((m) => m.moduleKey === key);
          return mod ? mod.isEnabled : true;
        };

        const isFmsEnabled = isModuleEnabled("FMS_ENGINE");
        const isDoThisEnabled = isModuleEnabled("DO_THIS2");

        startTaskStatusCron();
        runDependencyCron();
        if (isDoThisEnabled) {
          startCronJobs();
          startVisibilityCron();
        }
        if (isFmsEnabled) {
          startFMSProgressCronJobs();
          startFmsVisibilityCron();
          startRecurringFmsTaskJob();
        }
      } catch (err) {
        console.error("Failed to start crons", err);
      }
    });
  })
  .catch((error) => {
    console.error("Error connecting to MongoDB:", error);
  });
