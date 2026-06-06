import nodemailer from "nodemailer";
import User from "../models/User.js";

const sendEmail = async ({ to, subject, html }) => {
  try {
    // ✅ find user from primary or secondary email
    const user = await User.findOne({
      $or: [{ email: to }],
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

    //   const transporter = nodemailer.createTransport({
    //       service: "gmail",
    //       auth: {
    //         user: process.env.SMTP_EMAIL,
    //         pass: process.env.SMTP_PASS,
    //       },
    //     });
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT),
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: {
        user: process.env.SMTP_EMAIL,
        pass: process.env.SMTP_PASS,
      },
    });
    const mailOptions = {
      from: `"DoThis2" <${process.env.SMTP_EMAIL}>`,
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
