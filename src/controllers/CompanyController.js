import Company from "../models/CompanyProfile.js";
import path from "path";
import fs from "fs";
// GET COMPANY DETAILS
export const getCompany = async (req, res) => {
  try {
    let company = await Company.findOne();

    // create default automatically first time
    if (!company) {
      company = await Company.create({
        softwareName: "Dothis2_2.0",
      });
    }

    return res.status(200).json({
      success: true,
      data: company,
    });
  } catch (error) {
    console.log(error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch company details",
    });
  }
};
const deleteFile = (filePath) => {
  if (!filePath) return;

  const fullPath = `.${filePath}`;

  if (fs.existsSync(fullPath)) {
    fs.unlinkSync(fullPath);
  }
};

// UPDATE COMPANY DETAILS
export const updateCompany = async (req, res) => {
  try {
    const {
      softwareName,
      tagline,
      website,
      email,
      phone,
      address,
      city,
      state,
      country,
      postalCode,
      gstNumber,
      panNumber,
      cinNumber,
      tanNumber,

      // company details
      industry,
      companySize,
      foundedYear,

      // social
      linkedinUrl,
    } = req.body;

    // get existing company
    let company = await Company.findOne();

    // create if not exists
    if (!company) {
      company = new Company({
        softwareName: softwareName || "Dothis2_2.0",
      });
    }

    // ── uploads ─────────────────────────────
    if (req.files?.logo?.[0]) {
      // delete old logo
      deleteFile(company.logo);

      company.logo = `/${req.files.logo[0].path.replace(/\\/g, "/")}`;
    }

    /* ───────────────── FAVICON ───────────────── */

    if (req.files?.favicon?.[0]) {
      // delete old favicon
      deleteFile(company.favicon);

      company.favicon = `/${req.files.favicon[0].path.replace(/\\/g, "/")}`;
    }
    // ── update only provided fields ─────────
    const updates = {
      softwareName,
      tagline,
      website,
      email,
      phone,
      address,
      city,
      state,
      country,
      postalCode,
      gstNumber,
      panNumber,
      cinNumber,
      tanNumber,

      // company details
      industry,
      companySize,
      foundedYear,

      // social
      linkedinUrl,
    };

    Object.entries(updates).forEach(([key, value]) => {
      if (value !== undefined) {
        company[key] = value;
      }
    });

    // audit
    company.updatedBy = req.user?._id;

    await company.save();

    return res.status(200).json({
      success: true,
      message: "Company updated successfully",
      data: company,
    });
  } catch (error) {
    console.log("UPDATE_COMPANY_ERROR:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to update company",
      error: error.message,
    });
  }
};
