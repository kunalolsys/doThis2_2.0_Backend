import mongoose from "mongoose";

const NotificationSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    fromUser: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    type: {
      type: String,
      enum: [
        "MESSAGE",
        "TASK_UPDATE",
        "QUERY",
        "MENTION",
        "QUERY_RAISED",
        "QUERY_REPLIED",
      ],
    },

    title: String,
    description: String,

    relatedId: mongoose.Schema.Types.ObjectId, // message/task/etc

    isRead: { type: Boolean, default: false },
    readAt: Date,
  },
  { timestamps: true },
);
const Notifications = mongoose.model("Notifications", NotificationSchema);
export default Notifications;
