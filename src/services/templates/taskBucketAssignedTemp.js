export const taskBucketAssignedTemplate = ({
  userName,
  bucketId,
  bucketTitle,
  description,
  createdAt,
//   assignmentMode,
//   startDate,
//   endDate,
  createdBy,
  frontendUrl,
}) => {
  return {
    subject: `New Task Bucket Assigned • ${bucketId}`,

    html: `
      <div style="
        margin:0;
        padding:30px 0;
        background:#f1f5f9;
        font-family:Arial,sans-serif;
      ">

        <div style="
          max-width:720px;
          margin:0 auto;
          background:#ffffff;
          border-radius:18px;
          overflow:hidden;
          border:1px solid #e2e8f0;
        ">

          <!-- HEADER -->
          <div style="
            background:linear-gradient(135deg,#2563eb,#1d4ed8);
            padding:34px 38px;
          ">

            <div style="
              font-size:12px;
              color:#bfdbfe;
              letter-spacing:1px;
              font-weight:700;
              margin-bottom:10px;
            ">
              Dothis2
            </div>

            <h1 style="
              margin:0;
              color:#ffffff;
              font-size:28px;
              font-weight:700;
            ">
              New Task Bucket Assigned
            </h1>

            <p style="
              margin:12px 0 0;
              color:#dbeafe;
              font-size:14px;
              line-height:1.7;
            ">
              You have received a new task bucket assignment.
            </p>

          </div>

          <!-- BODY -->
          <div style="padding:36px;">

            <p style="
              margin-top:0;
              color:#0f172a;
              font-size:15px;
              line-height:1.7;
            ">
              Hello <strong>${userName || "User"}</strong>,
            </p>

            <p style="
              color:#475569;
              font-size:14px;
              line-height:1.8;
            ">
              A new task bucket has been assigned to you. Please review the details below and complete the assigned tasks within the timeline.
            </p>

            <!-- INFO CARD -->
            <div style="
              margin-top:24px;
              background:#f8fafc;
              border:1px solid #e2e8f0;
              border-radius:16px;
              overflow:hidden;
            ">

              <table
                width="100%"
                cellpadding="0"
                cellspacing="0"
                style="
                  border-collapse:collapse;
                  font-size:14px;
                "
              >

                <tr>
                  <td style="
                    width:180px;
                    padding:16px 20px;
                    background:#f8fafc;
                    color:#64748b;
                    font-weight:600;
                    border-bottom:1px solid #e2e8f0;
                  ">
                    Bucket ID
                  </td>

                  <td style="
                    padding:16px 20px;
                    color:#0f172a;
                    font-weight:700;
                    border-bottom:1px solid #e2e8f0;
                  ">
                    ${bucketId}
                  </td>
                </tr>

                <tr>
                  <td style="
                    padding:16px 20px;
                    color:#64748b;
                    font-weight:600;
                    border-bottom:1px solid #e2e8f0;
                  ">
                    Bucket Title
                  </td>

                  <td style="
                    padding:16px 20px;
                    color:#0f172a;
                    font-weight:600;
                    border-bottom:1px solid #e2e8f0;
                  ">
                    ${bucketTitle}
                  </td>
                </tr>

                <tr>
                  <td style="
                    padding:16px 20px;
                    color:#64748b;
                    font-weight:600;
                    border-bottom:1px solid #e2e8f0;
                  ">
                    Description
                  </td>

                  <td style="
                    padding:16px 20px;
                    color:#334155;
                    line-height:1.7;
                    border-bottom:1px solid #e2e8f0;
                  ">
                    ${description}
                  </td>
                </tr>

                <tr>
                  <td style="
                    padding:16px 20px;
                    color:#64748b;
                    font-weight:600;
                    border-bottom:1px solid #e2e8f0;
                  ">
                    Start Date
                  </td>

                  <td style="
                    padding:16px 20px;
                    color:#0f172a;
                    border-bottom:1px solid #e2e8f0;
                  ">
                    ${createdAt || "-"}
                  </td>
                </tr>


                <tr>
                  <td style="
                    padding:16px 20px;
                    color:#64748b;
                    font-weight:600;
                  ">
                    Assigned By
                  </td>

                  <td style="
                    padding:16px 20px;
                    color:#0f172a;
                  ">
                    ${createdBy || "-"}
                  </td>
                </tr>

              </table>

            </div>

            <!-- BUTTON -->
            ${
              frontendUrl
                ? `
              <div style="margin-top:32px;text-align:center;">
                <a
                  href="${frontendUrl}"
                  style="
                    display:inline-block;
                    background:#2563eb;
                    color:#ffffff;
                    text-decoration:none;
                    padding:14px 24px;
                    border-radius:10px;
                    font-size:14px;
                    font-weight:700;
                  "
                >
                  Open Task Bucket
                </a>
              </div>
            `
                : ""
            }

          </div>

          <!-- FOOTER -->
          <div style="
            padding:24px 36px;
            background:#f8fafc;
            border-top:1px solid #e2e8f0;
            color:#64748b;
            font-size:13px;
            line-height:1.8;
          ">

            This is an automated notification from the
            <strong>Dothis2</strong>.

            <br /><br />

            Regards,<br />
            <strong>Dothis2</strong>

          </div>

        </div>

      </div>
    `,
  };
};
