import mongoose from "mongoose";

const companySchema = new mongoose.Schema(
  {
    softwareName: {
      type: String,
      required: true,
      default: "Dothis2_2.0",
    },

    logo: {
      type: String,
      default: "",
    },

    favicon: {
      type: String,
      default: "",
    },
    tagline: {
      type: String,
      default: null,
    },

    website: {
      type: String,
      default: null,
    },

    email: {
      type: String,
      default: null,
    },

    phone: {
      type: String,
      default: null,
    },

    address: {
      type: String,
      default: null,
    },

    city: {
      type: String,
      default: null,
    },

    state: {
      type: String,
      default: null,
    },

    country: {
      type: String,
      default: null,
    },

    postalCode: {
      type: String,
      default: null,
    },

    // business fields
    gstNumber: {
      type: String,
      default: null,
    },

    panNumber: {
      type: String,
      default: null,
    },

    cinNumber: {
      type: String,
      default: null,
    },

    tanNumber: {
      type: String,
      default: null,
    },

    // company details
    industry: {
      type: String,
      default: null,
    },

    companySize: {
      type: String,
      default: null,
    },

    foundedYear: {
      type: String,
      default: null,
    },

    // social
    linkedinUrl: {
      type: String,
      default: null,
    },

    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  },
  {
    timestamps: true,
  },
);

export default mongoose.model("Company", companySchema);
