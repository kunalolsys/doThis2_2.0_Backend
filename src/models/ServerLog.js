import mongoose from 'mongoose';

const serverLogSchema = new mongoose.Schema({
  level: { type: String, required: true }, // INFO, SUCCESS, ERROR
  message: { type: String, required: true },
  timestamp: { type: Date, default: Date.now, expires: 604800 } // 7 days auto-delete
});

const ServerLog = mongoose.model('ServerLog', serverLogSchema);
export default ServerLog;