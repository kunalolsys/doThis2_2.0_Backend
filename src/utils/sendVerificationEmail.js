import nodemailer from "nodemailer";

export const sendVerificationEmail = async (email, token, type = 'verify', subject = 'Verify Your Email') => {
  let link;
  let title;
  let message;

  if (type === 'reset-password') {
    link = `${process.env.BASE_URL}/reset-password?token=${token}`;
    title = 'Password Reset';
    message = 'Click the link below to reset your password:';
  } else {
    link = `${process.env.BASE_URL}/verify/${token}`;
    title = 'Email Verification';
    message = 'Click the link below to verify your account:';
  }

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS, // App password
    },
  });

  await transporter.sendMail({
    from: process.env.EMAIL_USER,
    to: email,
    subject: subject,
    html: `
      <h2>${title}</h2>
      <p>${message}</p>
      <a href="${link}">${link}</a>
    `,
  });
};
