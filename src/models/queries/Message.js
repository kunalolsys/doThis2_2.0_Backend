import mongoose from "mongoose";

const MessageSchema = new mongoose.Schema(
  {
    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Conversation",
    },

    sender: { type: mongoose.Schema.Types.ObjectId, ref: "User" },

    text: String,

    attachments: [
      {
        fileUrl: String,
        fileName: String,
      },
    ],

    // 🧵 Thread support
    parentMessage: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Message",
      default: null,
    },

    seenBy: [
      {
        user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        seenAt: Date,
      },
    ],
  },
  { timestamps: true },
);
const Messages = mongoose.model("Messages", MessageSchema);
export default Messages;
