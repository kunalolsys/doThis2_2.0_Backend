import cron from "node-cron";
import moment from "moment-timezone";
import { Holiday } from "../models/Holiday.js"; // Adjust path to your Holiday model

/**
 * FIXED ANNUAL HOLIDAYS LIST
 * Standard holidays that occur on the exact same Month & Day every year.
 */
const FIXED_HOLIDAYS = [
  { month: 1, day: 1, name: "New Year's Day", description: "New Year Celebration" },
  { month: 1, day: 26, name: "Republic Day", description: "National Holiday" },
  { month: 5, day: 1, name: "May Day / Labour Day", description: "International Workers' Day" },
  { month: 8, day: 15, name: "Independence Day", description: "National Holiday" },
  { month: 10, day: 2, name: "Gandhi Jayanti", description: "Mahatma Gandhi's Birthday" },
  { month: 12, day: 25, name: "Christmas Day", description: "Christmas Celebration" },
];

/**
 * Seeds fixed holidays for a target year into MongoDB.
 * Uses atomic bulkWrite / upsert to avoid duplicate records.
 */
export const seedHolidaysForYear = async (targetYear = null) => {
  const year = targetYear || moment().tz("Asia/Kolkata").year();
  console.log(`\n🎉 [ANNUAL HOLIDAY SEEDER] Seeding fixed holidays for Year: ${year}...`);

  try {
    const bulkOps = FIXED_HOLIDAYS.map((holiday) => {
      // Create exact date string for midnight UTC/IST (e.g., "2026-01-26 00:00:00")
      const holidayDate = moment
        .tz(`${year}-${String(holiday.month).padStart(2, "0")}-${String(holiday.day).padStart(2, "0")}`, "YYYY-MM-DD", "Asia/Kolkata")
        .startOf("day")
        .toDate();

      return {
        updateOne: {
          filter: {
            date: holidayDate,
            name: holiday.name,
          },
          update: {
            $setOnInsert: {
              date: holidayDate,
              name: holiday.name,
              description: holiday.description,
              isGlobal: true,
              applicableDepartments: [], // Global applies to all
            },
          },
          upsert: true,
        },
      };
    });

    const result = await Holiday.bulkWrite(bulkOps);

    console.log(
      `✅ [ANNUAL HOLIDAY SEEDER] Completed for ${year}! Upserted: ${result.upsertedCount}, Matched Existing: ${result.matchedCount}`
    );
  } catch (error) {
    console.error(`❌ [ANNUAL HOLIDAY SEEDER ERROR] Failed to seed holidays for ${year}:`, error);
  }
};

/**
 * Initializes Cron Job to run every year on Jan 1st at 00:01 AM IST.
 * Also runs once on application boot for the current year if missing.
 */
export const startAnnualHolidayCron = () => {
  // 1. Run on server startup to ensure current year's holidays exist
  seedHolidaysForYear();

  // 2. Schedule cron: Runs at 00:01 AM on 1st January every year ("1 0 1 1 *")
  cron.schedule(
    "1 0 1 1 *",
    () => {
      const newYear = moment().tz("Asia/Kolkata").year();
      console.log(`⏰ Cron Triggered: New Year ${newYear} Holiday Generation`);
      seedHolidaysForYear(newYear);
    },
    {
      timezone: "Asia/Kolkata",
    }
  );

  console.log("📅 Annual Holiday Seeder Cron Initialized (Runs Jan 1st at 00:01 AM IST) ✅");
};

export default startAnnualHolidayCron;