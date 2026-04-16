import mongoose from "mongoose";

const QuerySchema = new mongoose.Schema(
  {
    taskId: mongoose.Schema.Types.ObjectId,
    raisedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    repliedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Conversation",
    },

    message: String,
    status: {
      type: String,
      enum: ["Open", "Resolved", "Pending", "Responded"],
      default: "Open",
    },
  },
  { timestamps: true },
);
const Queries = mongoose.model("Queries", QuerySchema);
export default Queries;
