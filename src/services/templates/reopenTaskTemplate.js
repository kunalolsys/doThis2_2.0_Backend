export const taskReopenedEmail = ({ task, reopenReason, frontendUrl }) => {
  const taskId = task.TaskId || "—";
  const title = task.title || "Untitled Task";
  const status = task.status || "Reopened";
  const reopenedBy = task.assignedBy?.name || "A manager";
  const department = task.departmentOfAssignToUser?.name || null;
  const dueDate = task.dueDate
    ? new Date(task.dueDate).toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      })
    : null;

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Task Reopened — ${taskId}</title>
</head>
<body style="margin:0;padding:0;background:#F1F5F9;font-family:'Segoe UI',Arial,sans-serif;">

  <!-- Outer wrapper -->
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F1F5F9;padding:32px 16px;">
    <tr>
      <td align="center">

        <!-- Card -->
        <table width="600" cellpadding="0" cellspacing="0" border="0"
          style="max-width:600px;width:100%;background:#FFFFFF;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">

          <!-- ── TOP ACCENT BAR ───────────────────────────────────── -->
          <tr>
            <td style="background:linear-gradient(90deg,#1E3A8A 0%,#2563EB 50%,#7C3AED 100%);height:5px;font-size:0;line-height:0;">&nbsp;</td>
          </tr>

          <!-- ── HEADER ───────────────────────────────────────────── -->
          <tr>
            <td style="padding:32px 40px 0;background:#FFFFFF;">
              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td>
                    <!-- Logo / Brand -->
                    <span style="font-size:20px;font-weight:800;color:#0F172A;letter-spacing:-0.5px;">
                      Do<span style="color:#2563EB;">this</span>2
                    </span>
                  </td>
                  <td align="right">
                    <!-- Status chip -->
                    <span style="background:#EFF6FF;color:#2563EB;font-size:11px;font-weight:700;
                      padding:4px 12px;border-radius:20px;border:1px solid #BFDBFE;
                      letter-spacing:0.5px;text-transform:uppercase;">
                      Task Notification
                    </span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- ── HERO SECTION ──────────────────────────────────────── -->
          <tr>
            <td style="padding:28px 40px 24px;">
              <!-- Icon + heading -->
              <table cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="vertical-align:middle;">
                    <div style="font-size:22px;font-weight:800;color:#0F172A;margin-bottom:2px;line-height:1.2;">
                      Task Reopened
                    </div>
                    <div style="font-size:13px;color:#64748B;">
                      Action required — please review and continue
                    </div>
                  </td>
                </tr>
              </table>

              <!-- Divider -->
              <div style="height:1px;background:#F1F5F9;margin:20px 0;"></div>

              <!-- Task title banner -->
              <div style="background:#F8FAFC;border:1px solid #E2E8F0;border-left:4px solid #2563EB;
                border-radius:10px;padding:14px 18px;">
                <div style="font-size:11px;font-weight:700;color:#94A3B8;text-transform:uppercase;
                  letter-spacing:0.8px;margin-bottom:4px;">Task Title</div>
                <div style="font-size:16px;font-weight:700;color:#0F172A;">${title}</div>
              </div>
            </td>
          </tr>

          <!-- ── DETAILS TABLE ──────────────────────────────────────── -->
          <tr>
            <td style="padding:0 40px 28px;">
              <table width="100%" cellpadding="0" cellspacing="0" border="0"
                style="border:1px solid #E2E8F0;border-radius:12px;overflow:hidden;">

                <!-- Row 1 -->
                <tr style="background:#F8FAFC;">
                  <td style="padding:12px 16px;border-bottom:1px solid #E2E8F0;
                    font-size:11px;font-weight:700;color:#94A3B8;text-transform:uppercase;
                    letter-spacing:0.6px;width:36%;vertical-align:top;">
                    Task ID
                  </td>
                  <td style="padding:12px 16px;border-bottom:1px solid #E2E8F0;
                    font-size:13px;color:#0F172A;vertical-align:top;">
                    <span style="font-family:monospace;background:#EFF6FF;color:#2563EB;
                      padding:3px 8px;border-radius:6px;font-size:12px;font-weight:700;
                      border:1px solid #BFDBFE;">
                      ${taskId}
                    </span>
                  </td>
                </tr>

                <!-- Row 2 -->
                <tr style="background:#FFFFFF;">
                  <td style="padding:12px 16px;border-bottom:1px solid #E2E8F0;
                    font-size:11px;font-weight:700;color:#94A3B8;text-transform:uppercase;
                    letter-spacing:0.6px;vertical-align:top;">
                    New Status
                  </td>
                  <td style="padding:12px 16px;border-bottom:1px solid #E2E8F0;vertical-align:top;">
                    <span style="display:inline-flex;align-items:center;gap:5px;
                      background:#FEF3C7;color:#D97706;font-size:12px;font-weight:700;
                      padding:3px 10px;border-radius:20px;border:1px solid #FDE68A;">
                      ● ${status}
                    </span>
                  </td>
                </tr>

                <!-- Row 3 -->
                <tr style="background:#F8FAFC;">
                  <td style="padding:12px 16px;border-bottom:1px solid #E2E8F0;
                    font-size:11px;font-weight:700;color:#94A3B8;text-transform:uppercase;
                    letter-spacing:0.6px;vertical-align:top;">
                    Reopened By
                  </td>
                  <td style="padding:12px 16px;border-bottom:1px solid #E2E8F0;
                    font-size:13px;color:#0F172A;font-weight:500;vertical-align:top;">
                    ${reopenedBy}
                  </td>
                </tr>

                ${
                  department
                    ? `
                <!-- Row 4 — Department -->
                <tr style="background:#FFFFFF;">
                  <td style="padding:12px 16px;border-bottom:1px solid #E2E8F0;
                    font-size:11px;font-weight:700;color:#94A3B8;text-transform:uppercase;
                    letter-spacing:0.6px;vertical-align:top;">
                    Department
                  </td>
                  <td style="padding:12px 16px;border-bottom:1px solid #E2E8F0;
                    font-size:13px;color:#0F172A;vertical-align:top;">
                    ${department}
                  </td>
                </tr>`
                    : ""
                }

                ${
                  dueDate
                    ? `
                <!-- Row 5 — Due Date -->
                <tr style="background:${department ? "#F8FAFC" : "#FFFFFF"};">
                  <td style="padding:12px 16px;border-bottom:1px solid #E2E8F0;
                    font-size:11px;font-weight:700;color:#94A3B8;text-transform:uppercase;
                    letter-spacing:0.6px;vertical-align:top;">
                    Due Date
                  </td>
                  <td style="padding:12px 16px;border-bottom:1px solid #E2E8F0;
                    font-size:13px;color:#DC2626;font-weight:600;vertical-align:top;">
                    📅 ${dueDate}
                  </td>
                </tr>`
                    : ""
                }

                <!-- Reason row — highlighted -->
                <tr style="background:#FFF7ED;">
                  <td style="padding:14px 16px;
                    font-size:11px;font-weight:700;color:#D97706;text-transform:uppercase;
                    letter-spacing:0.6px;vertical-align:top;border-top:1px solid #FDE68A;">
                    Reopen Reason
                  </td>
                  <td style="padding:14px 16px;
                    font-size:13px;color:#92400E;line-height:1.6;vertical-align:top;
                    border-top:1px solid #FDE68A;font-style:italic;">
                    "${reopenReason}"
                  </td>
                </tr>

              </table>
            </td>
          </tr>

          <!-- ── WHAT TO DO NEXT ────────────────────────────────────── -->
          <tr>
            <td style="padding:0 40px 28px;">
              <div style="background:#F0FDF4;border:1px solid #BBF7D0;border-radius:12px;padding:16px 20px;">
                <div style="font-size:12px;font-weight:700;color:#059669;text-transform:uppercase;
                  letter-spacing:0.6px;margin-bottom:8px;">
                  ✅ What to do next
                </div>
                <ul style="margin:0;padding-left:18px;color:#065F46;font-size:13px;line-height:1.8;">
                  <li>Open the task and review the reopen reason</li>
                  <li>Coordinate with ${reopenedBy} if clarification is needed</li>
                  <li>Complete the required changes and resubmit for approval</li>
                </ul>
              </div>
            </td>
          </tr>

          <!-- ── CTA BUTTON ─────────────────────────────────────────── -->
          <tr>
            <td style="padding:0 40px 36px;text-align:center;">
              <a href="${frontendUrl}"
                style="display:inline-block;background:linear-gradient(135deg,#1E3A8A,#2563EB);
                  color:#FFFFFF;font-size:14px;font-weight:700;padding:14px 32px;
                  border-radius:10px;text-decoration:none;letter-spacing:0.3px;
                  box-shadow:0 4px 14px rgba(37,99,235,0.35);">
                Open Task →
              </a>
              <div style="margin-top:10px;font-size:12px;color:#94A3B8;">
                Or copy this link: <span style="color:#2563EB;">${frontendUrl}</span>
              </div>
            </td>
          </tr>

          <!-- ── FOOTER ─────────────────────────────────────────────── -->
          <tr>
            <td style="background:#F8FAFC;border-top:1px solid #E2E8F0;padding:20px 40px;border-radius:0 0 16px 16px;">
              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="font-size:12px;color:#94A3B8;line-height:1.6;">
                    This is an automated notification from
                    <strong style="color:#64748B;">DoThis2</strong>.<br />
                    Please do not reply to this email directly.
                  </td>
                  <td align="right" style="font-size:12px;color:#CBD5E1;white-space:nowrap;">
                    DoThis2 &copy; ${new Date().getFullYear()}
                  </td>
                </tr>
              </table>
            </td>
          </tr>

        </table>
        <!-- /Card -->

      </td>
    </tr>
  </table>

</body>
</html>`;
};
