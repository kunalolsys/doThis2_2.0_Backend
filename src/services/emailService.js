import nodemailer from "nodemailer";
import User from "../models/User.js";

const sendEmail = async ({ to, subject, html }) => {
  try {
    if (!to) {
      console.log("❌ No target email provided in arguments.");
      return null;
    }

    const cleanTo = String(to).trim().toLowerCase();

    // ✅ FIX: Search for active users only (isDeleted: false or not true)
    // and match primary OR secondary email (case-insensitive)
    const user = await User.findOne({
      isDeleted: { $ne: true }, // 🛑 Exclude deleted users
      $or: [
        { email: { $regex: `^${cleanTo}$`, $options: "i" } },
        { secondaryEmail: { $regex: `^${cleanTo}$`, $options: "i" } },
      ],
    }).select("email secondaryEmail mainEmailType isEmailNotificationEnabled");

    console.log("🔍 DB lookup for:", cleanTo, "| Active user found:", !!user);

    // ✅ Respect notification preference
    if (user && user.isEmailNotificationEnabled === false) {
      console.log(`🚫 Email notifications disabled for user: ${cleanTo}`);
      return null;
    }

    // ✅ Route to secondary email if selected and non-empty
    let sendTo = cleanTo;

    if (user) {
      const preferredType = String(user.mainEmailType).trim();
      const hasSecondary =
        user.secondaryEmail && user.secondaryEmail.trim() !== "";

      if (preferredType === "secondaryEmail" && hasSecondary) {
        sendTo = user.secondaryEmail.trim();
        console.log(
          `📌 Preference is Secondary Email -> Sending to: ${sendTo}`,
        );
      } else {
        sendTo = user.email ? user.email.trim() : cleanTo;
        console.log(`📌 Preference is Primary Email -> Sending to: ${sendTo}`);
      }
    } else {
      console.log(
        `⚠️ No active user matched '${cleanTo}'. Sending directly to provided address.`,
      );
    }

    // ✅ Create Transporter with cPanel TLS settings
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || "tms.himaira.com",
      port: Number(process.env.SMTP_PORT) || 465,
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: {
        user: process.env.SMTP_EMAIL,
        pass: process.env.SMTP_PASS,
      },
      tls: {
        rejectUnauthorized: false, // Bypasses cPanel SSL handshake errors
      },
    });

    const mailOptions = {
      from: `"Himaira TMS" <${process.env.SMTP_EMAIL}>`,
      to: sendTo,
      subject,
      html,
    };

    const info = await transporter.sendMail(mailOptions);
    console.log(
      `✅ Email sent successfully to ${sendTo} | ID: ${info.messageId}`,
    );

    return info;
  } catch (error) {
    console.error("❌ Email send error:", error);
    throw error;
  }
};

export default sendEmail;
