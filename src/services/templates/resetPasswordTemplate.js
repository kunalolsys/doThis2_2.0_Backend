export const resetPasswordTemplate = ({ email, resetLink }) => {
  return {
    subject: "Reset Your Password",

    html: `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Reset Password</title>
</head>

<body style="margin:0;padding:0;background-color:#f1f5f9;font-family:Arial,sans-serif;">

<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f1f5f9;padding:30px 0;">
<tr>
<td align="center">

<table width="700" cellpadding="0" cellspacing="0" border="0"
style="
background:#ffffff;
border-radius:20px;
overflow:hidden;
border:1px solid #e2e8f0;
box-shadow:0 10px 25px rgba(0,0,0,0.05);
">

  <!-- Header -->
  <tr>
    <td
      style="
      background:linear-gradient(135deg,#ea580c,#f97316);
      padding:35px;
      color:#ffffff;
      "
    >
      <h1 style="margin:0;font-size:30px;font-weight:700;">
        Reset Your Password
      </h1>

      <p style="margin-top:10px;font-size:14px;opacity:0.95;">
        A password reset request has been received for your account.
      </p>
    </td>
  </tr>

  <!-- Body -->
  <tr>
    <td style="padding:35px;">

      <p style="font-size:15px;color:#1e293b;line-height:1.8;margin-top:0;">
        Hello,
      </p>

      <p style="font-size:14px;color:#475569;line-height:1.8;">
        We received a request to reset the password associated with your
        <strong>DoThis2</strong> account.
      </p>

      <p style="font-size:14px;color:#475569;line-height:1.8;">
        Click the button below to create a new password.
      </p>

      <div
        style="
        background:#f8fafc;
        border:1px solid #e2e8f0;
        border-radius:16px;
        padding:22px;
        margin-top:25px;
        "
      >
        <table width="100%" cellpadding="0" cellspacing="0">

          <tr>
            <td
              style="
              width:140px;
              padding:8px 0;
              font-size:14px;
              color:#64748b;
              "
            >
              Email
            </td>

            <td
              style="
              padding:8px 0;
              font-size:14px;
              font-weight:600;
              color:#0f172a;
              "
            >
              ${email}
            </td>
          </tr>

        </table>
      </div>

      <!-- Button -->
      <div style="text-align:center;margin-top:35px;">
        <a
          href="${resetLink}"
          style="
          display:inline-block;
          background:#ea580c;
          color:#ffffff;
          text-decoration:none;
          padding:14px 30px;
          border-radius:12px;
          font-size:14px;
          font-weight:700;
          "
        >
          Reset Password
        </a>
      </div>

      <p
        style="
        margin-top:35px;
        font-size:13px;
        color:#64748b;
        line-height:1.7;
        "
      >
        If the button above doesn't work, copy and paste the following link into your browser:
      </p>

      <div
        style="
        background:#f8fafc;
        border:1px solid #e2e8f0;
        border-radius:10px;
        padding:14px;
        font-size:12px;
        color:#ea580c;
        word-break:break-all;
        "
      >
        ${resetLink}
      </div>

      <p
        style="
        margin-top:25px;
        font-size:13px;
        color:#64748b;
        line-height:1.7;
        "
      >
        This password reset link may expire after a limited time.
      </p>

      <p
        style="
        margin-top:10px;
        font-size:13px;
        color:#64748b;
        line-height:1.7;
        "
      >
        If you did not request a password reset, you can safely ignore this email.
      </p>

    </td>
  </tr>

  <!-- Footer -->
  <tr>
    <td
      style="
      background:#f8fafc;
      border-top:1px solid #e2e8f0;
      padding:20px;
      text-align:center;
      "
    >
      <p
        style="
        margin:0;
        font-size:12px;
        color:#64748b;
        "
      >
        © ${new Date().getFullYear()} DoThis2. All rights reserved.
      </p>
    </td>
  </tr>

</table>

</td>
</tr>
</table>

</body>
</html>
    `,
  };
};
