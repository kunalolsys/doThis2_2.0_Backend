import app from './app.js';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import http from 'http';
import { Server } from 'socket.io';
import startCronJobs from './cron/assignRecurringTask.js'
import {runDependencyCron} from './cron/dependancyCron.js';

import startTaskStatusCron from './cron/taskStatusUpdate.js';
import { setIo, connectedUsers } from './socket.js';
// import Remark from './models/Remark.js';
import User from './models/User.js';


// --- NEW IMPORT FOR LOGGING ---
import ServerLog from './models/ServerLog.js';
import startVisibilityCron from './cron/taskVisibilityCron.js';

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
    console.error('Logging System Error:', error.message);
  }
};
// --- LOGGING FUNCTION END ---

const allowedOrigins = (process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(origin => origin.trim())
  : ['https://fms.dothis2.com', 'http://localhost:4000','http://192.168.1.4:4000']); // Default allowed origins

const io = new Server(server, {
  cors: {
    origin: function (origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins.indexOf(origin) !== -1) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: true
  }
});

setIo(io);

io.on('connection', (socket) => {
  console.log('A user connected');
  console.log('Socket.IO client connected:', socket.id);
  // Optional: Agar socket connection bhi DB me save karna hai to niche wali line uncomment karein
  // logToDb('INFO', `Socket Client Connected: ${socket.id}`);
});

const PORT = process.env.PORT || 4000;
// Accept either MONGODB_URI or MONGO_URI to be resilient to .env naming
const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/dothis2';

// --- DATABASE EVENT LISTENERS (Live Monitoring) ---
mongoose.connection.on('connected', () => {
  logToDb('SUCCESS', 'MongoDB connection established successfully.');
});

mongoose.connection.on('error', (err) => {
  logToDb('ERROR', `MongoDB Connection Error: ${err.message}`);
});

mongoose.connection.on('disconnected', () => {
  console.log('WARNING: MongoDB disconnected');
  // Note: Disconnect hone par DB me write nahi ho payega, isliye console.log rakha hai
});

// --- MAIN CONNECTION ---
mongoose.connect(MONGODB_URI)
  .then(() => {
    // Console log already event listener 'connected' se handle ho jayega, 
    // par server start ka message hum yaha dalenge.

    server.listen(PORT, () => {
      const msg = `Server is running on port ${PORT}`;
      // Console aur DB dono jagah jayega
      logToDb('INFO', msg);
      // Start background cron jobs after server is up
      try {
        startTaskStatusCron();
        startCronJobs();
        runDependencyCron(); // Initial run
        startVisibilityCron()
      } catch (err) {
        console.error('Failed to start task status cron', err);
      }
    });
  })
  .catch((error) => {
    console.error('Error connecting to MongoDB:', error);
  });