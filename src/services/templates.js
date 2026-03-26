export const greetingTemplate = (name) => `
<div style="font-family: 'Segoe UI', Arial, sans-serif; background:#f4f6f9; padding:40px 0;">
  <div style="max-width:600px; margin:auto; background:#ffffff; border-radius:12px; overflow:hidden; box-shadow:0 10px 30px rgba(0,0,0,0.1);">
    
    <!-- HEADER -->
    <div style="background:linear-gradient(135deg,#4f46e5,#3b82f6); padding:30px; text-align:center; color:#fff;">
      <h1 style="margin:0; font-size:24px;">Welcome 🎉</h1>
      <p style="margin:5px 0 0;">We're glad to have you!</p>
    </div>

    <!-- BODY -->
    <div style="padding:30px;">
      <h2 style="margin-top:0;">Hi ${name},</h2>
      <p style="color:#555; line-height:1.6;">
        Welcome to our platform. We’re excited to have you onboard.
        You can now explore features and manage your tasks efficiently.
      </p>

      <div style="text-align:center; margin:30px 0;">
        <a href="#" style="background:#4f46e5; color:#fff; padding:12px 25px; border-radius:6px; text-decoration:none; font-weight:500;">
          Get Started
        </a>
      </div>

      <p style="color:#999; font-size:12px;">
        If you didn’t sign up, please ignore this email.
      </p>
    </div>

    <!-- FOOTER -->
    <div style="background:#f9fafb; padding:15px; text-align:center; font-size:12px; color:#888;">
      © 2026 Your Company. All rights reserved.
    </div>

  </div>
</div>
`;

export const taskAssignedTemplate = (name, taskTitle, dueDate) => `
<div style="font-family: Arial, sans-serif; background:#f4f6f9; padding:40px 0;">
  <div style="max-width:600px; margin:auto; background:#fff; border-radius:12px; overflow:hidden;">
    
    <!-- HEADER -->
    <div style="background:#111827; color:#fff; padding:25px;">
      <h2 style="margin:0;">New Task Assigned</h2>
    </div>

    <!-- BODY -->
    <div style="padding:30px;">
      <p>Hello <b>${name}</b>,</p>

      <p style="color:#555;">
        You have been assigned a new task. Please review the details below:
      </p>

      <div style="background:#f3f4f6; padding:15px; border-radius:8px; margin:20px 0;">
        <p><strong>Task:</strong> ${taskTitle}</p>
        <p><strong>Due Date:</strong> ${dueDate}</p>
      </div>

      <div style="text-align:center; margin:25px 0;">
        <a href="#" style="background:#2563eb; color:#fff; padding:10px 20px; border-radius:6px; text-decoration:none;">
          View Task
        </a>
      </div>

      <p style="font-size:13px; color:#888;">
        Stay productive 🚀
      </p>
    </div>

  </div>
</div>
`;

export const otpTemplate = (otp) => `
<div style="font-family: Arial; background:#f4f4f4; padding:40px;">
  <div style="max-width:500px; margin:auto; background:#fff; padding:30px; border-radius:10px; text-align:center;">
    
    <h2>Verify Your Account</h2>
    
    <p style="color:#555;">
      Use the OTP below to complete your verification:
    </p>

    <div style="font-size:32px; font-weight:bold; letter-spacing:5px; margin:20px 0; color:#111;">
      ${otp}
    </div>

    <p style="color:#999; font-size:12px;">
      This OTP is valid for 5 minutes.
    </p>

  </div>
</div>
`;
export const resetPasswordTemplate = (resetLink) => `
<div style="font-family: Arial; background:#f9fafb; padding:40px;">
  <div style="max-width:600px; margin:auto; background:#fff; padding:30px; border-radius:12px;">
    
    <h2>Password Reset Request</h2>

    <p style="color:#555;">
      We received a request to reset your password. Click below:
    </p>

    <div style="text-align:center; margin:25px 0;">
      <a href="${resetLink}" style="background:#ef4444; color:#fff; padding:12px 25px; border-radius:6px; text-decoration:none;">
        Reset Password
      </a>
    </div>

    <p style="font-size:12px; color:#999;">
      If you didn’t request this, ignore this email.
    </p>

  </div>
</div>
`;
