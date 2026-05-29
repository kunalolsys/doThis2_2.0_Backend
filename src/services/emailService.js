import nodemailer from "nodemailer";
import User from "../models/User.js";

const sendEmail = async ({ to, subject, html }) => {
  try {
    // ✅ find user from primary or secondary email
    const user = await User.findOne({
      $or: [{ email: to }, { secondaryEmail: to }],
    }).select("email secondaryEmail mainEmailType isEmailNotificationEnabled");

    // ✅ don't send if notifications disabled
    if (user && user.isEmailNotificationEnabled === false) {
      console.log(`🚫 Email notification disabled for ${to}`);
      return null;
    }

    // ✅ decide which email to use
    let sendTo = to;

    if (user) {
      sendTo =
        user.mainEmailType === "secondaryEmail"
          ? user.secondaryEmail
          : user.email;
    }

    // ✅ fallback safety
    if (!sendTo) {
      console.log("❌ No valid email found");
      return null;
    }

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });

    const mailOptions = {
      from: `"DoThis Task Manager" <${process.env.EMAIL_USER}>`,
      to: sendTo,
      subject,
      html,
    };

    const info = await transporter.sendMail(mailOptions);

    console.log("✅ Email sent:", info.messageId);

    return info;
  } catch (error) {
    console.error("❌ Email send error:", error);
    throw error;
  }
};

export default sendEmail;
