import fs from "fs";
import path from "path";
import XLSX from "xlsx";
import csv from "csv-parser";
import { Parser } from "json2csv";
import OpenForm from "../models/OpenForm.js";
import FormSubmission from "../models/FormSubmission.js";
import FmsInstance from "../models/FmsInstance.js";
import FmsInstanceTask from "../models/FmsInstanceTask.js";
import FmsTemplate from "../models/FmsTemplate.js";
import FmsTask from "../models/FmsTask.js";
import User from "../models/User.js";
import Counter from "../models/Counter.js";
import { handleAsync } from "../utils/handleAsync.js";
import AppError from "../utils/AppError.js";
import fmsDateCalculator from "../utils/fmsDateCalculator.js";
import {
  addWorkingDaysHoliday,
  nextWorkingShiftDate,
  snapToShiftTime,
} from "../utils/dateCalculator.js";
import { addDays } from "date-fns";
import { generateRecurringFmsTasks } from "../cron/assignRecurringFmsTask.js";
import axios from "axios";

const RECURRING_FREQUENCIES = ["Daily", "Weekly", "Monthly"];

// ── Helper: Calculate Task Status ──────────────────────────────────────────
const calculateTaskStatus = (startDate, dueDate) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  if (!startDate) return "Upcoming";
  const s = new Date(startDate);
  if (s > today) return "Upcoming";

  if (dueDate) {
    const d = new Date(dueDate);
    if (d < today) return "Overdue";
    if (d.toDateString() === today.toDateString()) return "Delayed";
  }
  return "Pending";
};

// ── Helper: Calculate FMS Instance Status ─────────────────────────────────
const calculateInstanceStatus = (startDate) => {
  const now = new Date();
  if (startDate && now < startDate) {
    return "Upcoming";
  }
  return "Ongoing";
};

// ── Internal Helper to Launch FMS Instance from Form/Import ───────────────
export const launchFmsInstanceInternal = async ({
  templateId,
  launchDate: launchDateInput,
  endDate: endDateInput,
  createdBy,
  triggerType = "OPEN_FORM",
  formId = null,
  submissionId = null,
  runtimeContext = {},
}) => {
  const template = await FmsTemplate.findById(templateId).populate([
    "manager",
    "srManager",
  ]);
  if (!template) throw new AppError("FMS Template not found", 404);

  const taskCount = await FmsTask.countDocuments({ fmsTemplateId: templateId });
  if (taskCount === 0) {
    throw new AppError("Cannot launch FMS: No tasks found in template", 400);
  }

  const launchDate = new Date(launchDateInput || Date.now());
  const instanceEnd =
    template.fmsDuration === "Fixed Period" ? template.endDate : null;
  const parsedEndDate =
    template.fmsDuration === "Fixed Period"
      ? endDateInput
        ? new Date(endDateInput)
        : template.endDate
      : launchDate;

  const status = calculateInstanceStatus(launchDate);

  const managerUser = await User.findById(template.manager._id).populate(
    "assignShift",
  );

  let instanceStartDate = launchDate;
  let instanceEndDate = endDateInput ? new Date(endDateInput) : instanceEnd;

  if (managerUser?.assignShift) {
    instanceStartDate = await nextWorkingShiftDate(
      launchDate,
      managerUser.assignShift._id,
      {},
      managerUser.department || managerUser._id,
    );

    if (instanceEndDate) {
      instanceEndDate = snapToShiftTime(
        instanceEndDate,
        managerUser.assignShift,
        false,
      );
    }
  }

  // Create Instance
  const instance = await FmsInstance.create({
    fmsTemplateId: template._id,
    instanceName: `${template.templateName}`,
    startDate: instanceStartDate,
    endDate: instanceEndDate,
    manager: template.manager._id,
    srManager: template.srManager?._id || null,
    createdBy: createdBy || null,
    fmsDuration: template.fmsDuration,
    status,
    triggerType,
    formId,
    submissionId,
    runtimeContext,
  });

  // Fetch Template Tasks in sequential order
  const templateTasks = await FmsTask.find({ fmsTemplateId: templateId }).sort(
    "taskId",
  );
  const instanceTasks = [];

  for (let i = 0; i < templateTasks.length; i++) {
    const tmplTask = templateTasks[i];

    if (RECURRING_FREQUENCIES.includes(tmplTask.frequency)) {
      continue;
    }

    const prevTasks = instanceTasks.slice(0, i);
    const doer = await User.findById(tmplTask.assignedTo).populate(
      "assignShift",
    );

    // 🟢 Priority given to task's direct department context
    const taskDeptContext =
      tmplTask.departmentOfAssignToUser || doer?.department || doer?._id;

    let dates = { startDate: null, dueDate: null };
    const freq = (tmplTask.frequency || "").trim().toLowerCase();

    const parentTemplate = tmplTask.dependentOn
      ? await FmsTask.findOne({ taskId: tmplTask.dependentOn })
      : null;

    const isRecurringParent =
      parentTemplate &&
      RECURRING_FREQUENCIES.includes(parentTemplate.frequency);

    if (tmplTask.isDependent && isRecurringParent) {
      continue;
    }

    if (freq === "anytime") {
      const shiftStart = doer?.assignShift
        ? await nextWorkingShiftDate(
            launchDate,
            doer.assignShift._id,
            {},
            taskDeptContext,
          )
        : launchDate;

      let dueDate = parsedEndDate;
      if (parsedEndDate && doer?.assignShift) {
        dueDate = snapToShiftTime(parsedEndDate, doer.assignShift, false);
      }

      dates = { startDate: shiftStart, dueDate };
    } else if (!tmplTask.isDependent && freq.startsWith("start")) {
      const shiftStart = doer?.assignShift
        ? await nextWorkingShiftDate(
            launchDate,
            doer.assignShift._id,
            {},
            taskDeptContext,
          )
        : launchDate;

      let dueDate = shiftStart;
      if (freq.includes("hour")) {
        dueDate = new Date(
          shiftStart.getTime() + (tmplTask.xValue || 0) * 60 * 60 * 1000,
        );
      } else {
        const targetDate = addDays(shiftStart, tmplTask.xValue || 0);
        dueDate = doer?.assignShift
          ? await nextWorkingShiftDate(
              targetDate,
              doer.assignShift._id,
              {},
              taskDeptContext,
            )
          : targetDate;
      }

      dates = { startDate: shiftStart, dueDate };
    } else if (!tmplTask.isDependent && freq.startsWith("event")) {
      if (!parsedEndDate) {
        throw new Error(
          `Event based task "${tmplTask.taskId}" requires FMS End Date`,
        );
      }

      const shiftStart = doer?.assignShift
        ? await nextWorkingShiftDate(
            launchDate,
            doer.assignShift._id,
            {},
            taskDeptContext,
          )
        : launchDate;

      let dueDate;
      const isNegative = freq.includes("event-x");
      const multiplier = isNegative ? -1 : 1;

      if (freq.includes("hour")) {
        dueDate = new Date(
          parsedEndDate.getTime() +
            (tmplTask.xValue || 0) * 60 * 60 * 1000 * multiplier,
        );
      } else {
        const targetDate = addDays(
          parsedEndDate,
          Math.abs(tmplTask.xValue || 0) * multiplier,
        );

        dueDate = doer?.assignShift
          ? snapToShiftTime(
              await nextWorkingShiftDate(
                targetDate,
                doer.assignShift._id,
                {},
                taskDeptContext,
              ),
              doer.assignShift,
              false,
            )
          : targetDate;
      }

      dates = { startDate: shiftStart, dueDate };
    } else if (
      tmplTask.startTimeSetting === "planned-to-planned" &&
      tmplTask.isDependent
    ) {
      let parent =
        prevTasks.find((t) => t.taskId === tmplTask.dependentOn) ||
        templateTasks.find((t) => t.taskId === tmplTask.dependentOn) ||
        (await FmsTask.findOne({ taskId: tmplTask.dependentOn }));

      if (!parent) continue;

      const assignedParentUser = await User.findById(
        parent.assignedTo,
      ).populate("assignShift");
      if (!assignedParentUser) {
        throw new AppError(`User ${parent.assignedTo} not found`, 404);
      }

      const parentWorkShift = assignedParentUser.assignShift;
      const parentStart = parent.plannedStartDate;
      const parentDue = parent.plannedDueDate;
      let startDate, dueDate;

      if (!parentStart || !parentDue) continue;

      const isSameShift =
        String(doer?.assignShift?._id) === String(parentWorkShift?._id);

      if (!isSameShift) {
        const baseDate = new Date(parentStart);
        const start = await nextWorkingShiftDate(
          baseDate,
          doer.assignShift._id,
          {},
          taskDeptContext,
        );
        startDate = snapToShiftTime(start, doer.assignShift, true);
        dueDate = snapToShiftTime(start, doer.assignShift, false);
      } else {
        const x = Number(tmplTask.xValue || 0);
        startDate = new Date(parentStart);
        dueDate = new Date(parentDue);

        if (freq.includes("hour")) {
          let calculatedDue = new Date(parentDue);
          calculatedDue.setHours(calculatedDue.getHours() + x);
          const shiftEnd = snapToShiftTime(parentDue, doer.assignShift, false);

          if (calculatedDue < shiftEnd) {
            dueDate = calculatedDue;
          } else {
            const overflowMs = calculatedDue.getTime() - shiftEnd.getTime();
            let nextDay = new Date(parentDue);
            nextDay.setDate(nextDay.getDate() + 1);

            const nextWorkingDay = await nextWorkingShiftDate(
              nextDay,
              doer.assignShift._id,
              {},
              taskDeptContext,
            );
            const nextShiftStart = snapToShiftTime(
              nextWorkingDay,
              doer.assignShift,
              true,
            );
            dueDate = new Date(nextShiftStart.getTime() + overflowMs);
          }
        } else {
          dueDate = await addWorkingDaysHoliday(
            parentDue,
            x,
            doer.assignShift._id,
            tmplTask.isDependent,
            {},
            taskDeptContext,
          );
          dueDate.setHours(
            parentDue.getHours(),
            parentDue.getMinutes(),
            parentDue.getSeconds(),
            parentDue.getMilliseconds(),
          );

          const shiftEnd = snapToShiftTime(dueDate, doer.assignShift, false);
          if (dueDate >= shiftEnd) {
            let nextDay = new Date(dueDate);
            nextDay.setDate(nextDay.getDate() + 1);
            const nextWorkingDay = await nextWorkingShiftDate(
              nextDay,
              doer.assignShift._id,
              {},
              taskDeptContext,
            );
            dueDate = snapToShiftTime(nextWorkingDay, doer.assignShift, false);
          }
        }
      }

      dates = { startDate, dueDate };
    } else if (!tmplTask.isDependent) {
      dates = await fmsDateCalculator.calculateFmsTaskDates(
        tmplTask.toObject(),
        launchDate,
        parsedEndDate,
        doer?.assignShift?._id,
        prevTasks.map((t) => ({
          taskId: t.taskId,
          plannedDueDate: t.plannedDueDate,
          plannedStartDate: t.plannedStartDate,
        })),
        taskDeptContext,
      );
    } else if (tmplTask.startTimeSetting === "actual-to-planned") {
      dates = { startDate: null, dueDate: null };
    }

    const isDecisionStep =
      tmplTask.decisionStep === true ||
      tmplTask.decisionStep === "yes" ||
      tmplTask.decisionStep === "true";

    const instanceTaskData = {
      fmsInstanceId: instance._id,
      fmsTaskId: tmplTask._id,
      taskId: tmplTask.taskId,
      description: tmplTask.description,
      departmentOfAssignToUser: tmplTask.departmentOfAssignToUser,
      assignedTo: tmplTask.assignedTo,
      assignedBy: tmplTask.assignedBy,
      frequency: tmplTask.frequency,
      xValue: tmplTask.xValue,
      isDependent: tmplTask.isDependent,
      dependentOn: tmplTask.dependentOn,
      startTimeSetting: tmplTask.startTimeSetting,
      taskEndDays: tmplTask.taskEndDays || 0,
      plannedStartDate: dates.startDate,
      plannedDueDate: dates.dueDate,
      status:
        tmplTask.startTimeSetting === "actual-to-planned"
          ? "Upcoming"
          : calculateTaskStatus(dates.startDate, dates.dueDate),
      isVisible: false,
      updatedBy: createdBy,
      decisionStep: isDecisionStep,
      decisionYesAction: isDecisionStep
        ? tmplTask.decisionYesAction || null
        : null,
      triggerFmsTemplate:
        isDecisionStep && tmplTask.decisionYesAction === "trigger_fms"
          ? tmplTask.triggerFmsTemplate || null
          : null,
      decisionAnswer: null,
      decisionRemark: null,
      decisionSubmissionId: null,
      triggeredInstanceId: null,
      checklist: tmplTask.checklist || [],
      createdForm: tmplTask.createdForm || [],
    };

    if (
      freq !== "anytime" &&
      tmplTask.isDependent &&
      tmplTask.startTimeSetting === "actual-to-planned"
    ) {
      instanceTaskData.waitingForParent = true;
    }

    const instanceTask = new FmsInstanceTask(instanceTaskData);
    await instanceTask.save();
    instanceTasks.push(instanceTask);
  }

  await generateRecurringFmsTasks(instance._id);

  return instance;
};

// ── Field Type Hints ───────────────────────────────────────────────────────
const FIELD_HINTS = {
  text: "Any text",
  textarea: "Any text (multi-line)",
  number: "Numbers only",
  email: "Valid email address",
  date: "YYYY-MM-DD",
  phone: "10-digit number",
  url: "https://...",
  select: "One of the allowed values",
  radio: "One of the allowed values",
  checkbox: "true or false",
  file: "Not supported in bulk import",
};

// ── Validate Field Values ──────────────────────────────────────────────────
export const validateField = (field, rawValue, masterOptionsMap = {}) => {
  const val =
    rawValue !== undefined && rawValue !== null ? String(rawValue).trim() : "";

  if (field.isRequired && val === "") {
    return { ok: false, reason: `"${field.label}" is required` };
  }

  if (val === "") return { ok: true, value: null };

  switch (field.fieldType) {
    case "number":
      if (isNaN(Number(val))) {
        return { ok: false, reason: `"${field.label}" must be a number` };
      }
      return { ok: true, value: Number(val) };

    case "email":
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) {
        return { ok: false, reason: `"${field.label}" must be a valid email` };
      }
      return { ok: true, value: val };

    case "date": {
      let parsedDate = null;

      // 1. Handle Excel Serial Numbers
      if (
        typeof rawValue === "number" ||
        (!isNaN(Number(val)) &&
          !String(val).includes("-") &&
          !String(val).includes("/"))
      ) {
        const excelNum = Number(val);
        if (excelNum > 0 && excelNum < 2958465) {
          const parsedObj = XLSX.SSF.parse_date_code(excelNum);
          if (parsedObj) {
            const { y, m, d } = parsedObj;
            parsedDate = new Date(Date.UTC(y, m - 1, d));
          }
        }
      }

      // 2. Handle String Date Formats
      if (!parsedDate && typeof val === "string") {
        const cleanVal = val.trim();

        const ddmmyyyyMatch = cleanVal.match(
          /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/,
        );
        if (ddmmyyyyMatch) {
          const day = parseInt(ddmmyyyyMatch[1], 10);
          const month = parseInt(ddmmyyyyMatch[2], 10) - 1;
          const year = parseInt(ddmmyyyyMatch[3], 10);
          parsedDate = new Date(Date.UTC(year, month, day));
        } else {
          const timestamp = Date.parse(cleanVal);
          if (!isNaN(timestamp)) {
            parsedDate = new Date(timestamp);
          }
        }
      }

      // 3. Validate parsed date
      if (!parsedDate || isNaN(parsedDate.getTime())) {
        return {
          ok: false,
          reason: `"${field.label}" must be a valid date (YYYY-MM-DD or DD-MM-YYYY)`,
        };
      }

      const fullYear = parsedDate.getUTCFullYear();
      if (fullYear < 1900 || fullYear > 2100) {
        return {
          ok: false,
          reason: `"${field.label}" has an invalid year: ${fullYear}`,
        };
      }

      return { ok: true, value: parsedDate.toISOString().slice(0, 10) };
    }

    case "phone":
      if (!/^[6-9]\d{9}$/.test(val.replace(/\D/g, ""))) {
        return {
          ok: false,
          reason: `"${field.label}" must be a valid 10-digit phone number`,
        };
      }
      return { ok: true, value: val };

    case "url":
      try {
        new URL(val);
        return { ok: true, value: val };
      } catch {
        return { ok: false, reason: `"${field.label}" must be a valid URL` };
      }

    case "select":
    case "dropdown":
    case "radio": {
      let allowedOptions = [];

      if (field.optionType === "MASTER") {
        allowedOptions = masterOptionsMap[field.masterSource] || [];

        // Reject if Master List failed to load or is empty
        if (allowedOptions.length === 0) {
          return {
            ok: false,
            reason: `Cannot validate "${field.label}": Vendor list (${field.masterSource}) could not be retrieved from API.`,
          };
        }
      } else if (Array.isArray(field.options)) {
        allowedOptions = field.options.filter(
          (opt) =>
            opt !== null && opt !== undefined && String(opt).trim() !== "",
        );
      }

      // Strict match check against API Vendor List
      if (allowedOptions.length > 0) {
        const matchedOption = allowedOptions.find(
          (opt) => String(opt).toLowerCase().trim() === val.toLowerCase(),
        );

        if (!matchedOption) {
          return {
            ok: false,
            reason: `Vendor "${val}" does not exist in Vendor Master list. Row rejected.`,
          };
        }

        // Return exact casing from master vendor list
        return { ok: true, value: matchedOption };
      }

      return { ok: true, value: val };
    }

    case "checkbox": {
      const lower = val.toLowerCase();
      if (!["true", "false", "yes", "no", "1", "0"].includes(lower)) {
        return { ok: false, reason: `"${field.label}" must be true or false` };
      }
      return { ok: true, value: ["true", "yes", "1"].includes(lower) };
    }

    case "file":
      return {
        ok: false,
        reason: `"${field.label}" (file) is not supported in bulk import`,
      };

    default:
      return { ok: true, value: val };
  }
};

// ─────────────────────────────────────────────────────────────────────────
// GET /api/open-forms/:slug/import-template
// ─────────────────────────────────────────────────────────────────────────
export const downloadImportTemplate = handleAsync(async (req, res, next) => {
  const form = await OpenForm.findOne({
    slug: req.params.slug,
    isActive: true,
    isDeleted: false,
  }).lean();

  if (!form) return next(new AppError("Form not found", 404));

  const fields = form.fields.filter((f) => f.fieldType !== "file");
  const wb = XLSX.utils.book_new();

  const headerRow = fields.map((f) => f.label);
  const exampleRow = fields.map((f) => {
    if (f.fieldType === "select" || f.fieldType === "radio")
      return f.options?.[0] || "ExampleValue";
    if (f.fieldType === "number") return 123;
    if (f.fieldType === "email") return "example@domain.com";
    if (f.fieldType === "date") return new Date().toISOString().slice(0, 10);
    if (f.fieldType === "phone") return "9876543210";
    if (f.fieldType === "url") return "https://example.com";
    if (f.fieldType === "checkbox") return "true";
    return "Sample text";
  });

  const dataAOA = [headerRow, exampleRow];
  const dataWS = XLSX.utils.aoa_to_sheet(dataAOA);

  dataWS["!cols"] = fields.map((f) => ({
    wch: Math.max(f.label.length + 4, 20),
  }));

  fields.forEach((_, c) => {
    const cell = XLSX.utils.encode_cell({ r: 0, c });
    if (dataWS[cell]) {
      dataWS[cell].s = {
        font: { bold: true, color: { rgb: "FFFFFF" } },
        fill: { fgColor: { rgb: "2563EB" } },
        alignment: { horizontal: "center" },
      };
    }
  });

  dataWS["!freeze"] = { xSplit: 0, ySplit: 1 };
  XLSX.utils.book_append_sheet(wb, dataWS, "Import Data");

  // Field Guide
  const guideHeaders = [
    "Label",
    "Field ID",
    "Type",
    "Required",
    "Allowed Values / Hint",
  ];
  const guideRows = fields.map((f) => [
    f.label,
    f.fieldId,
    f.fieldType,
    f.isRequired ? "YES" : "no",
    (f.options?.length ? f.options.join(" | ") : FIELD_HINTS[f.fieldType]) ||
      "",
  ]);

  const guideWS = XLSX.utils.aoa_to_sheet([guideHeaders, ...guideRows]);
  guideWS["!cols"] = [24, 20, 14, 10, 40].map((w) => ({ wch: w }));

  guideHeaders.forEach((_, c) => {
    const cell = XLSX.utils.encode_cell({ r: 0, c });
    if (guideWS[cell]) {
      guideWS[cell].s = {
        font: { bold: true, color: { rgb: "FFFFFF" } },
        fill: { fgColor: { rgb: "059669" } },
      };
    }
  });

  XLSX.utils.book_append_sheet(wb, guideWS, "Field Guide");

  // Instructions
  const instrWS = XLSX.utils.aoa_to_sheet([
    [`Bulk Import Template — ${form.formName}`],
    [`Generated: ${new Date().toLocaleString("en-IN")}`],
    [],
    ["INSTRUCTIONS"],
    [
      "1. Fill your data in the 'Import Data' sheet starting from row 2 (row 1 is the header, do not change it).",
    ],
    ["2. Each row = one form submission."],
    ["3. Check the 'Field Guide' sheet for allowed values and formats."],
    ["4. Required fields must not be left empty."],
    ["5. Date format: YYYY-MM-DD  (e.g. 2026-06-15)."],
    [
      "6. For select/radio fields, use only the allowed values listed in Field Guide.",
    ],
    ["7. File upload fields are not supported in bulk import — skip them."],
    [
      "8. Upload this file at the import endpoint. Invalid rows are skipped and reported.",
    ],
  ]);
  instrWS["!cols"] = [{ wch: 90 }];
  XLSX.utils.book_append_sheet(wb, instrWS, "Instructions");

  const buffer = XLSX.write(wb, {
    type: "buffer",
    bookType: "xlsx",
    cellStyles: true,
  });

  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${form.slug}-import-template.xlsx"`,
  );
  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  return res.send(buffer);
});

// ─────────────────────────────────────────────────────────────────────────
// POST /api/open-forms/:slug/import
// ─────────────────────────────────────────────────────────────────────────
export const bulkImportFormSubmissions = handleAsync(async (req, res, next) => {
  if (!req.file) return next(new AppError("No file uploaded", 400));

  const filePath = req.file.path;
  const triggerFms =
    req.body.triggerFms === "true" ||
    req.body.triggerFms === true ||
    req.body.triggerFms === "1" ||
    req.body.triggerFms === 1;
  const remark = req.body.remark || "Bulk import";
  const userId = req.cookies?.userId || req.user?._id || null;

  const importLog = [];
  let rows = [];

  try {
    const form = await OpenForm.findOne({
      slug: req.params.slug,
      isActive: true,
      isDeleted: false,
    })
      .populate("linkedTemplate")
      .lean();

    if (!form) {
      fs.unlinkSync(filePath);
      return next(new AppError("Form not found", 404));
    }

    const validFields = form.fields.filter((f) => f.fieldType !== "file");
    const isCSV = req.file.originalname.toLowerCase().endsWith(".csv");

    // 1. READ FILE
    if (isCSV) {
      rows = await new Promise((resolve, reject) => {
        const acc = [];
        fs.createReadStream(filePath)
          .pipe(csv())
          .on("data", (d) => acc.push(d))
          .on("end", () => resolve(acc))
          .on("error", (e) => reject(e));
      });
    } else {
      const wb = XLSX.readFile(filePath);
      const sheet = wb.Sheets[wb.SheetNames[0]];
      rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
    }

    if (!rows || !rows.length) {
      fs.unlinkSync(filePath);
      return next(new AppError("File is empty or unreadable", 400));
    }

    // ── 2. HEADER & FIELD MAPPING ──────────────────────────────────────────
    const labelToField = new Map(
      validFields.map((f) => [f.label.toLowerCase().trim(), f]),
    );
    const idToField = new Map(
      validFields.map((f) => [f.fieldId.toLowerCase().trim(), f]),
    );

    const resolveField = (headerKey) => {
      if (!headerKey) return null;
      const k = String(headerKey).toLowerCase().trim();
      return labelToField.get(k) || idToField.get(k) || null;
    };

    const sheetHeaders = Object.keys(rows[0] || {});

    // Guard Checks
    const isErrorLogFile =
      sheetHeaders.includes("row") &&
      sheetHeaders.includes("status") &&
      sheetHeaders.includes("reason") &&
      sheetHeaders.includes("data");

    if (isErrorLogFile) {
      fs.unlinkSync(filePath);
      return next(
        new AppError(
          "Invalid file! You are uploading an Error Log file instead of an import template.",
          400,
        ),
      );
    }

    const matchedFieldsInSheet = sheetHeaders
      .map((h) => resolveField(h))
      .filter(Boolean);

    if (matchedFieldsInSheet.length === 0) {
      fs.unlinkSync(filePath);
      return next(
        new AppError(
          "No valid columns found matching this form. Please use the official import template.",
          400,
        ),
      );
    }

    const missingRequiredFields = validFields.filter((field) => {
      if (!field.isRequired) return false;
      return !sheetHeaders.some((header) => {
        const matched = resolveField(header);
        return matched && String(matched.fieldId) === String(field.fieldId);
      });
    });

    if (missingRequiredFields.length > 0) {
      const missingLabels = missingRequiredFields
        .map((f) => `"${f.label}"`)
        .join(", ");
      fs.unlinkSync(filePath);
      return next(
        new AppError(
          `Import aborted! Required column(s) missing from sheet: ${missingLabels}`,
          400,
        ),
      );
    }

    // ── 3. FETCH DYNAMIC MASTER OPTIONS IN PARALLEL ────────────────────────
    const masterOptionsMap = {};
    const masterFields = validFields.filter(
      (f) => f.optionType === "MASTER" && f.masterSource,
    );

    await Promise.all(
      masterFields.map(async (field) => {
        const source = field.masterSource;
        if (!masterOptionsMap[source]) {
          // Call directly without passing user request headers
          masterOptionsMap[source] = await fetchMasterOptions(source);
        }
      }),
    );

    // ── 4. IN-MEMORY VALIDATION & BATCH PREPARATION ───────────────────────
    const seenInBatch = new Set();
    const candidateRows = []; // Valid rows ready for DB checks
    const requiredFields = validFields.filter((f) => f.isRequired);

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNum = i + 2;
      const rowErrors = [];
      const responsesMap = {};
      let hasAnyValueInRow = false;

      for (const header of sheetHeaders) {
        const field = resolveField(header);
        if (!field) continue;

        const rawVal = row[header];
        if (
          rawVal !== undefined &&
          rawVal !== null &&
          String(rawVal).trim() !== ""
        ) {
          hasAnyValueInRow = true;
        }

        const { ok, value, reason } = validateField(
          field,
          rawVal,
          masterOptionsMap,
        );
        if (!ok) {
          rowErrors.push(reason);
        } else if (value !== null) {
          responsesMap[field.fieldId] = value;
        }
      }

      if (!hasAnyValueInRow) continue; // Skip completely blank lines

      if (rowErrors.length > 0) {
        importLog.push({
          row: rowNum,
          status: "error",
          reason: rowErrors.join("; "),
          data: JSON.stringify(row),
        });
        continue;
      }

      // Check for duplicates inside the uploaded file itself
      const batchKey = JSON.stringify(responsesMap);
      if (seenInBatch.has(batchKey)) {
        importLog.push({
          row: rowNum,
          status: "skipped",
          reason: "Duplicate row — same values already present in this batch",
          data: JSON.stringify(row),
        });
        continue;
      }
      seenInBatch.add(batchKey);

      // Build Enriched Submission Data Structure
      const enrichedSubmissionData = {};
      for (const field of form.fields) {
        enrichedSubmissionData[field.fieldId] = {
          value: responsesMap[field.fieldId] ?? null,
          isTableColumn: field.isTableColumn || false,
          label: field.label,
          fieldType: field.fieldType,
        };
      }

      // Construct a DB query matcher for existing record lookup
      const duplicateMatchQuery = {};
      for (const reqField of requiredFields) {
        if (responsesMap[reqField.fieldId] !== undefined) {
          duplicateMatchQuery[`submissionData.${reqField.fieldId}.value`] =
            responsesMap[reqField.fieldId];
        }
      }

      candidateRows.push({
        rowNum,
        rawRow: row,
        responsesMap,
        enrichedSubmissionData,
        duplicateMatchQuery,
      });
    }

    // ── 5. OPTIMIZED BATCH DUPLICATE CHECK (1 DB QUERY) ───────────────────
    const existingSet = new Set();
    const queryConditions = candidateRows
      .map((c) => c.duplicateMatchQuery)
      .filter((q) => Object.keys(q).length > 0);

    if (queryConditions.length > 0) {
      const existingSubmissions = await FormSubmission.find({
        formId: form._id,
        $or: queryConditions,
      })
        .select("submissionData")
        .lean();

      for (const existing of existingSubmissions) {
        const subData = existing.submissionData || {};
        const key = requiredFields
          .map((f) => String(subData[f.fieldId]?.value ?? ""))
          .join("||");
        existingSet.add(key);
      }
    }

    // Filter out existing DB records
    const rowsToInsert = [];
    for (const item of candidateRows) {
      const key = requiredFields
        .map((f) => String(item.responsesMap[f.fieldId] ?? ""))
        .join("||");

      if (existingSet.has(key)) {
        importLog.push({
          row: item.rowNum,
          status: "skipped",
          reason: "Duplicate record — already submitted in a previous import",
          data: JSON.stringify(item.rawRow),
        });
      } else {
        rowsToInsert.push(item);
      }
    }

    // ── 6. BULK INSERT TO DB (BULK WRITE) ─────────────────────────────────
    if (rowsToInsert.length > 0) {
      const docsToCreate = rowsToInsert.map((item) => ({
        formId: form._id,
        submissionData: item.enrichedSubmissionData,
        submittedBy: userId,
        status: "Submitted",
      }));

      // Insert all valid documents in a single operation
      const createdDocs = await FormSubmission.insertMany(docsToCreate, {
        ordered: false,
      });

      // ── 7. OPTIONAL FMS TRIGGER (PARALLEL EXECUTION) ────────────────────
      const templateId = form.linkedTemplate?._id || form.linkedTemplate;

      if (triggerFms && templateId) {
        await Promise.all(
          createdDocs.map(async (doc, idx) => {
            try {
              const newInstance = await launchFmsInstanceInternal({
                templateId,
                launchDate: new Date(),
                createdBy: userId,
                triggerType: "FORM_SUBMISSION",
                formId: form._id,
                submissionId: doc._id,
                runtimeContext: doc.submissionData,
              });

              if (newInstance) {
                await FormSubmission.updateOne(
                  { _id: doc._id },
                  {
                    $set: {
                      triggeredInstance: newInstance._id,
                      status: "Triggered",
                    },
                  },
                );
              }

              importLog.push({
                row: rowsToInsert[idx].rowNum,
                status: "imported",
                reason: "OK",
                submissionId: doc._id,
                triggeredInstanceId: newInstance?._id || null,
              });
            } catch (fmsErr) {
              importLog.push({
                row: rowsToInsert[idx].rowNum,
                status: "imported",
                reason: `Imported, but FMS trigger failed: ${fmsErr.message}`,
                submissionId: doc._id,
              });
            }
          }),
        );
      } else {
        // Log successful import when FMS trigger is disabled
        createdDocs.forEach((doc, idx) => {
          importLog.push({
            row: rowsToInsert[idx].rowNum,
            status: "imported",
            reason: "OK",
            submissionId: doc._id,
          });
        });
      }
    }

    // ── 8. BUILD RESPONSE LOGS & CSV SUMMARY ──────────────────────────────
    const importedRows = importLog.filter((l) => l.status === "imported");
    const skippedRows = importLog.filter((l) => l.status === "skipped");
    const errorRows = importLog.filter((l) => l.status === "error");

    let errorFileUrl = null;
    const failedRows = [...skippedRows, ...errorRows];
    if (failedRows.length > 0) {
      const parser = new Parser({
        fields: ["row", "status", "reason", "data"],
      });
      const csvContent = parser.parse(failedRows);
      const errorFName = `${Date.now()}-form-import-errors.csv`;
      const errorFPath = path.join(process.cwd(), "uploads", errorFName);
      fs.writeFileSync(errorFPath, csvContent);
      errorFileUrl = `/uploads/${errorFName}`;
    }

    return res.json({
      success: importedRows.length > 0,
      message:
        importedRows.length > 0
          ? `${importedRows.length} submission(s) imported successfully.`
          : "No submissions were imported. All rows had errors or were duplicates.",
      summary: {
        total: rows.length,
        imported: importedRows.length,
        skipped: skippedRows.length,
        errors: errorRows.length,
      },
      log: importLog,
      errorFile: errorFileUrl,
    });
  } finally {
    try {
      fs.unlinkSync(filePath);
    } catch {}
  }
});

// ── FAST MASTER OPTION FETCHING ───────────────────────────────────────────
const fetchMasterOptions = async (masterSource) => {
  if (masterSource === "VENDOR") {
    // 1. Use the exact working token from your curl command
    const suvidhaToken =
      "Bearer eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiIsImp0aSI6IjkyNWQzYThhMzQ4NzE0OTkxZTY4NjdmYzY3YjYxNmIyOTQ0ZDE3OGU3YTM0OGQxODcyNTU0NWRiMDVhYzIwZTIzNmZkNGY4YTliMGVlNjJhIn0.eyJhdWQiOiIxIiwianRpIjoiOTI1ZDNhOGEzNDg3MTQ5OTFlNjg2N2ZjNjdiNjE2YjI5NDRkMTc4ZTdhMzQ4ZDE4NzI1NTQ1ZGIwNWFjMjBlMjM2ZmQ0ZjhhOWIwZWU2MmEiLCJpYXQiOjE2ODM4ODc3ODYsIm5iZiI6MTY4Mzg4Nzc4NiwiZXhwIjo3OTk1MjM0OTg2LCJzdWIiOiI0Iiwic2NvcGVzIjpbXX0.TpQxHxAKMHe5jmvCD7Q3bIZjDvH1Ib6l14B3EUIV1sdrqxzS0cP6VBmAwfbY9Reg6eR1Fb555QlaAUZZy_VVf_5qr0j41nq9WNAWTyum4jQuY8qOBwS1W0SRsvnpqEgnOtQxGGbCHpv4EX6DwH9Yi1wWeB1Z45Nr-RvDdl8tip8UZts7bYDq2wpbbpBR8B_OS8R1RuF1UvXR0VEO-ooRgwiXODXO-QCD0uBfXF3J7gIrhcBlYhfQ-dMPFZe5SVHKaOlW7NGiEOulVDJwRemMRp6y5wG-75171Yp6WyCmpT-eFwkm8jjXWzWq__U2FtbG60Y7Gwnjaxl6hok5_P_PhpaAchtZIKqJji1QQ3TWy9wIBACjw-BRY5_i9hWnUAnHLSQ_8a_oo7j3aXhXVLIxVnV9l2wuwSqr-HcgShMCxWeQE3PWjtz5A_npR9m4puhmZJ1QAuOXpluLZfbHch5eKESlxmwijQ7vH0YzlD2Ork131YVvNnPO959faeEoE5r4W2D_wtRLv7JrBqoBDwbAzt_NFYZ8RFjjwUXFdelR-7sRkRCCzjPZ1LwOk2NgBOh_1offoGpdoUyGj76mLaka1m86iaDqJZDJeFuj_vxbp_E0nZYoAQgb3lOLw4GZZRzuE4OI0p6pF7m169Xy5onmBTJplhDP5953RTkElVfXohg";

    try {
      const response = await axios({
        method: "get",
        url: "https://mis.suvidhastores.com/api/load-dtenData",
        headers: {
          Accept: "application/json, text/plain, */*",
          "Accept-Language": "en-US,en;q=0.9",
          Authorization: suvidhaToken.trim(), // Ensure no trailing newlines/spaces
          Origin: "http://localhost:5173",
          Referer: "http://localhost:5173/",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
        },
        timeout: 15000,
      });

      const list = Array.isArray(response.data)
        ? response.data
        : response.data?.data || [];

      // Extract vendor names safely
      const vendorNames = list
        .map((item) => item?.vendor_name || item?.vendorName)
        .filter((name) => Boolean(name) && String(name).trim() !== "");

      console.log(
        `✅ [Vendor API Success] Loaded ${vendorNames.length} vendors.`,
      );
      return [...new Set(vendorNames)];
    } catch (err) {
      console.error("❌ [Vendor API Error Status]:", err?.response?.status);
      console.error(
        "❌ [Vendor API Error Data]:",
        err?.response?.data || err.message,
      );
      return [];
    }
  }

  return [];
};
