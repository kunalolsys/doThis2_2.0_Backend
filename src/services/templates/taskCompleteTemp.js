export const taskCompletedTemplate = ({
  assignedByName,
  completedBy,
  taskId,
  title,
  remark,
  completedAt,
  frontendUrl,
}) => {
  return {
    subject: `Task Completed — ${taskId}: ${title}`,

    html: `
      <div style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,sans-serif;">
        <div style="max-width:700px;margin:30px auto;background:#ffffff;border-radius:20px;overflow:hidden;border:1px solid #e2e8f0;box-shadow:0 10px 25px rgba(0,0,0,0.05)">
          
          <div style="background:linear-gradient(135deg,#16a34a,#22c55e);padding:30px;color:white;">
            <h1 style="margin:0;font-size:28px;">Task Completed</h1>

            <p style="margin-top:10px;font-size:14px;opacity:0.9;">
              A task has been marked as completed successfully.
            </p>
          </div>

          <div style="padding:30px;color:#1e293b;">
            <p style="font-size:15px;">
              Hello <strong>${assignedByName}</strong>,
            </p>

            <p style="font-size:14px;color:#475569;line-height:1.7;">
              The following task has been completed successfully.
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
                  <td style="padding:8px 0;font-size:14px;color:#64748b;">
                    Completed By
                  </td>

                  <td style="padding:8px 0;font-size:14px;font-weight:600;color:#16a34a;">
                    ${completedBy}
                  </td>
                </tr>

                <tr>
                  <td style="padding:8px 0;font-size:14px;color:#64748b;">
                    Completed At
                  </td>

                  <td style="padding:8px 0;font-size:14px;font-weight:600;color:#0f172a;">
                    ${
                      completedAt
                        ? new Date(completedAt).toLocaleString("en-IN", {
                            day: "2-digit",
                            month: "short",
                            year: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                          })
                        : "N/A"
                    }
                  </td>
                </tr>

                <tr>
                  <td style="padding:8px 0;font-size:14px;color:#64748b;vertical-align:top;">
                    Remark
                  </td>

                  <td style="padding:8px 0;font-size:14px;color:#334155;line-height:1.7;">
                    ${remark || "No remark added"}
                  </td>
                </tr>

              </table>
            </div>

            ${
              frontendUrl
                ? `
              <div style="margin-top:35px;text-align:center;">
                <a
                  href="${frontendUrl}"
                  style="display:inline-block;background:#16a34a;color:white;text-decoration:none;padding:14px 24px;border-radius:12px;font-size:14px;font-weight:700;"
                >
                  View Task
                </a>
              </div>
            `
                : ""
            }

          </div>

          <div style="padding:20px;background:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;font-size:12px;color:#64748b;">
            Dothis2
          </div>
        </div>
      </div>
    `,
  };
};