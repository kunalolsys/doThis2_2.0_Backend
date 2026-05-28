export const bucketCompletedTemplate = ({
  bucketId,
  bucketTitle,
  completedBy,
  completedAt,
  remark,
}) => {
  return {
    subject: `Bucket Completed • ${bucketId} ${bucketTitle}`,

    html: `
      <div style="
        margin:0;
        padding:0;
        background:#f1f5f9;
        font-family:Arial,sans-serif;
      ">

        <div style="
          max-width:700px;
          margin:30px auto;
          background:#ffffff;
          border-radius:16px;
          overflow:hidden;
          border:1px solid #e2e8f0;
        ">

          <!-- HEADER -->
          <div style="
            background:linear-gradient(135deg,#2563eb,#1d4ed8);
            padding:28px 32px;
          ">
            <div style="
              font-size:13px;
              letter-spacing:1px;
              color:#bfdbfe;
              font-weight:600;
              margin-bottom:8px;
            ">
              Dothis2
            </div>

            <h1 style="
              margin:0;
              color:#ffffff;
              font-size:24px;
              font-weight:700;
            ">
              Bucket Completed Successfully
            </h1>

            <p style="
              margin:10px 0 0;
              color:#dbeafe;
              font-size:14px;
              line-height:1.6;
            ">
              A task bucket has been marked as completed.
            </p>
          </div>

          <!-- BODY -->
          <div style="padding:32px;">

            <div style="
              background:#f8fafc;
              border:1px solid #e2e8f0;
              border-radius:14px;
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
                    padding:16px 20px;
                    background:#f8fafc;
                    color:#64748b;
                    width:180px;
                    font-weight:600;
                    border-bottom:1px solid #e2e8f0;
                  ">
                    Bucket ID
                  </td>

                  <td style="
                    padding:16px 20px;
                    color:#0f172a;
                    font-weight:600;
                    border-bottom:1px solid #e2e8f0;
                  ">
                    ${bucketId || "-"}
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
                    Completed By
                  </td>

                  <td style="
                    padding:16px 20px;
                    color:#0f172a;
                    border-bottom:1px solid #e2e8f0;
                  ">
                    ${completedBy || "-"}
                  </td>
                </tr>

                <tr>
                  <td style="
                    padding:16px 20px;
                    color:#64748b;
                    font-weight:600;
                    border-bottom:1px solid #e2e8f0;
                  ">
                    Completed At
                  </td>

                  <td style="
                    padding:16px 20px;
                    color:#0f172a;
                    border-bottom:1px solid #e2e8f0;
                  ">
                    ${completedAt}
                  </td>
                </tr>

                <tr>
                  <td style="
                    padding:16px 20px;
                    color:#64748b;
                    font-weight:600;
                    vertical-align:top;
                  ">
                    Remark
                  </td>

                  <td style="
                    padding:16px 20px;
                    color:#0f172a;
                    line-height:1.7;
                  ">
                    ${remark || "No remark added"}
                  </td>
                </tr>

              </table>
            </div>

            <!-- SUCCESS BADGE -->
            <div style="
              margin-top:24px;
              display:inline-flex;
              align-items:center;
              gap:8px;
              background:#ecfdf5;
              border:1px solid #a7f3d0;
              color:#059669;
              padding:10px 16px;
              border-radius:999px;
              font-size:13px;
              font-weight:700;
            ">
              ✅ Bucket Status: Completed
            </div>

          </div>

          <!-- FOOTER -->
          <div style="
            padding:22px 32px;
            background:#f8fafc;
            border-top:1px solid #e2e8f0;
            color:#64748b;
            font-size:13px;
            line-height:1.7;
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
