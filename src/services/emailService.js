import nodemailer from "nodemailer";

// export const createTestTransporter = async () => {
//   const testAccount = await nodemailer.createTestAccount();

//   return nodemailer.createTransport({
//     host: "smtp.ethereal.email",
//     port: 587,
//     auth: {
//       user: testAccount.user,
//       pass: testAccount.pass,
//     },
//   });
// };
// export const createProdTransporter = () => {
//   return nodemailer.createTransport({
//     service: "gmail",
//     auth: {
//       user: process.env.EMAIL_USER,
//       pass: process.env.EMAIL_PASS,
//     },
//   });
// };
// const transporter =
//   process.env.NODE_ENV === "production"
//     ? createProdTransporter()
//     : await createTestTransporter();
// export const sendEmail = async ({ to, subject, html }) => {
//   const transporter =
//     process.env.NODE_ENV === "production"
//       ? createProdTransporter()
//       : await createTestTransporter();

//   const info = await transporter.sendMail({
//     from: `"Task App" <no-reply@test.com>`,
//     to,
//     subject,
//     html,
//   });

//   // 👇 ONLY FOR DEV
//   if (process.env.NODE_ENV !== "production") {
//     console.log("Preview URL: ", nodemailer.getTestMessageUrl(info));
//   }
// };

//** FOR TESTING */

export const sendTestEmail = async ({ from, subject, html }) => {
  try {
    const transporter = nodemailer.createTransport({
      host: "smtp.ethereal.email",
      port: 587,
      auth: {
        user: process.env.ETHEREAL_EMAIL,
        pass: process.env.ETHEREAL_PASS,
      },
    });

    const info = await transporter.sendMail({
      from,
      to: process.env.ETHEREAL_EMAIL, // ✅ send to yourself
      subject,
      html,
    });

    console.log("Message sent:", info.messageId);

    // 🔥 Preview link
    console.log("Preview URL:", nodemailer.getTestMessageUrl(info));
  } catch (err) {
    console.error("Email error:", err);
  }
};

//** FOR TESTING GMAIL WITH PASS */
// export const createTransporter = () => {
//   return nodemailer.createTransport({
//     service: "gmail",
//     auth: {
//       user: process.env.SMTP_EMAIL,
//       pass: process.env.SMTP_PASS,
//     },
//   });
// };
// export const sendEmail = async ({ to, subject, html }) => {
//   const transporter = createTransporter();

//   const info = await transporter.sendMail({
//     from: `"Task App" <${process.env.SMTP_EMAIL}>`,
//     to, // ✅ REAL USER EMAIL
//     subject,
//     html,
//   });

//   console.log("Email sent:", info.messageId);
// };
