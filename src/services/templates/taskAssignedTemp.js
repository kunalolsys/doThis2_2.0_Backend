export const taskAssignedTemplate = ({
  userName,
  taskId,
  title,
  description,
  dueDate,
  assignedBy,
  frontendUrl,
}) => {
  return {
    subject: `New Task Assigned — ${taskId}: ${title}`,

    html: `
      <div style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,sans-serif;">
        <div style="max-width:700px;margin:30px auto;background:#ffffff;border-radius:20px;overflow:hidden;border:1px solid #e2e8f0;box-shadow:0 10px 25px rgba(0,0,0,0.05)">
          
          <div style="background:linear-gradient(135deg,#2563eb,#4f46e5);padding:30px;color:white;">
            <h1 style="margin:0;font-size:28px;">New Task Assigned</h1>
            <p style="margin-top:10px;font-size:14px;opacity:0.9;">
              A new task has been assigned to you.
            </p>
          </div>

          <div style="padding:30px;color:#1e293b;">
            <p style="font-size:15px;">
              Hello <strong>${userName}</strong>,
            </p>

            <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:16px;padding:22px;margin-top:20px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding:8px 0;font-size:14px;color:#64748b;width:140px;">
                    Task ID
                  </td>
                  <td style="padding:8px 0;font-size:14px;font-weight:600;color:#0f172a;">
                    ${taskId}
                  </td>
                </tr>

                <tr>
                  <td style="padding:8px 0;font-size:14px;color:#64748b;">
                    Title
                  </td>
                  <td style="padding:8px 0;font-size:14px;font-weight:600;color:#0f172a;">
                    ${title}
                  </td>
                </tr>

                <tr>
                  <td style="padding:8px 0;font-size:14px;color:#64748b;vertical-align:top;">
                    Description
                  </td>
                  <td style="padding:8px 0;font-size:14px;color:#334155;line-height:1.7;">
                    ${description || "-"}
                  </td>
                </tr>

                <tr>
                  <td style="padding:8px 0;font-size:14px;color:#64748b;">
                    Due Date
                  </td>
                  <td style="padding:8px 0;font-size:14px;font-weight:600;color:#dc2626;">
                    ${dueDate || "N/A"}
                  </td>
                </tr>

                <tr>
                  <td style="padding:8px 0;font-size:14px;color:#64748b;">
                    Assigned By
                  </td>
                  <td style="padding:8px 0;font-size:14px;font-weight:600;color:#0f172a;">
                    ${assignedBy || "System"}
                  </td>
                </tr>
              </table>
            </div>
          </div>

          <div style="padding:20px;background:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;font-size:12px;color:#64748b;">
            Dothis2
          </div>
        </div>
      </div>
    `,
  };
};