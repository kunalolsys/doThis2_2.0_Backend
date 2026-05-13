# TODO
- [ ] Patch `src/controllers/taskController.js` recurring “virtual upcoming” generation for DO_THIS2 enabled.
  - [ ] Replace current `futureRecurring` / `isTaskValidForToday`+break logic with workshift/holiday-aware generation using `nextWorkingShiftDate`, `isWorkingDay`, `isHoliday` from `src/utils/dateCalculator.js`.
  - [ ] Generate all valid occurrences within the requested window (use `startDate/endDate` if provided; otherwise use next 30 days).
  - [ ] Ensure occurrences respect frequency: Weekly/Monthly/Yearly + weekly weekdays (existing fields `frequency`, `weekDays`, `startDate`, `endDate`).
  - [ ] Filter virtual recurring list by `stat`, `status`, `taskType`, `search` exactly like existing pipeline.
- [ ] Run a quick node lint/test command or start server and manually validate upcoming list for weekly/monthly/yearly tasks.

