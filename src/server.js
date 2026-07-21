import app from "./app.js";
import mongoose from "mongoose";
import dotenv from "dotenv";
import http from "http";

import startCronJobs from "./cron/assignRecurringTask.js";
import { runDependencyCron } from "./cron/dependancyCron.js";
import startTaskStatusCron from "./cron/taskStatusUpdate.js";
import startVisibilityCron from "./cron/taskVisibilityCron.js";
import startFmsVisibilityCron from "./cron/fmsInstanceTaskVisibilityCron.js";
import startFMSProgressCronJobs from "./cron/fmsInstanceTaskProgressCron.js";
import startRecurringFmsTaskJob from "./cron/assignRecurringFmsTask.js";
import startFmsUpcomingInstancesCron from "./cron/fmsUpcomingInstancesCron.js";
import { initSocket } from "./socket.js";
import "../scripts/seedSuperRolesAndUser.js";
import ModuleSetting from "./models/ModuleSetting.js";
import "./services/telegram/telegramBOT.js";

dotenv.config();

const server = http.createServer(app);

// Initialize Socket IO
initSocket(server);

const PORT = process.env.PORT || 4000;
const MONGODB_URI =
  process.env.MONGODB_URI ||
  process.env.MONGO_URI ||
  "mongodb://localhost:27017/dothis2";

// Database Connection with optimized settings
mongoose
  .connect(MONGODB_URI, {
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
  })
  .then(() => {
    console.log("MongoDB connection established successfully.");

    server.listen(PORT, async () => {
      console.log(`Server running on port ${PORT}`);

      // Start Cron Jobs safely after DB connects
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
          startFmsUpcomingInstancesCron();
        }
      } catch (err) {
        console.error("Failed to start crons:", err);
      }
    });
  })
  .catch((error) => {
    console.error("Error connecting to MongoDB:", error);
  });
