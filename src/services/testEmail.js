// utils/testEmail.js

import nodemailer from "nodemailer";

export const sendTestEmail = async (email) => {
  try {
    const transporter = nodemailer.createTransport({
      host:"new-india.openlogichost.com", // smtp.gmail.com
      port: Number(465), // 587 or 465
      secure: Number(465) === 465,
      auth: {
        user: "info@v2.dothis2.com",
        pass: "M8ynrK=KD9h}hTxa",
      },
    });

    // Verify SMTP connection
    await transporter.verify();
    console.log("✅ SMTP Connected");

    const info = await transporter.sendMail({
      from: `"DoThis Test" <info@v2.dothis2.com>`,
      to: email,
      subject: "SMTP Test Email",
      html: `
        <h2>SMTP Test Successful</h2>
        <p>This email confirms your SMTP configuration is working.</p>
        <p>Sent at: ${new Date().toISOString()}</p>
      `,
    });

    console.log("✅ Test email sent:", info.messageId);

    return info;
  } catch (error) {
    console.error("❌ SMTP Test Failed:", error);
    throw error;
  }
};
