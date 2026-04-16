import mongoose from "mongoose";

const ConversationSchema = new mongoose.Schema(
  {
    taskId: { type: mongoose.Schema.Types.ObjectId, refPath: "taskType" },
    taskType: {
      type: String,
      enum: ["DelegationTask", "RecurringTask", "FmsInstanceTask"],
    },

    participants: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],

    lastMessage: { type: mongoose.Schema.Types.ObjectId, ref: "Message" },
  },
  { timestamps: true },
);
const Conversations = mongoose.model("Conversation", ConversationSchema);
export default Conversations;
