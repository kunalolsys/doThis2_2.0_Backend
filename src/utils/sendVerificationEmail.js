import sendEmail from "../services/emailService.js";
import { resetPasswordTemplate } from "../services/templates/resetPasswordTemplate.js";

export const sendVerificationEmail = async (email, token, type = "verify") => {
  let link;
  let title;
  let message;

  if (type === "reset-password") {
    link = `${process.env.BASE_URL}/reset-password?token=${token}`;
    title = "Password Reset";
    message = "Click the link below to reset your password:";
  } else {
    link = `${process.env.BASE_URL}/verify/${token}`;
    title = "Email Verification";
    message = "Click the link below to verify your account:";
  }
  const { subject, html } = resetPasswordTemplate({
    email,
    resetLink: link,
  });

  await sendEmail({
    to: email,
    subject,
    html,
  });
};
