# MIS Report Implementation

## Previous Task
Department soft delete complete ✓

## New Task: MIS Report
**Goal:** POST /api/v1/mis-reports
Body: {period? ('weekly'|'quarterly'|'yearly'), startDate?, endDate?, srManagerId?, managerId?, memberIds:[] }
Response: array [ {userName, role, totalTasks, doneOnTime, notDoneOnTime, notDone, score} ]

**Steps:**
- [x] Step 1: Create src/utils/reportHelpers.js ✓
- [x] Step 2: Create src/controllers/misReportController.js ✓
- [x] Step 3: Create src/routes/misReport.js ✓
- [x] Step 4: Add route to src/routes/index.js ✓
- [ ] Step 5: Test & complete

**API Ready:** POST /api/v1/mis-reports
Auth required.

Example body:
```json
{
  "period": "weekly",
  "srManagerId": "sr_user_id",
  "managerId": "manager_id",
  "memberIds": ["member1_id", "member2_id"],
  "startDate": "2024-01-01",
  "endDate": "2024-12-31"
}
```

**Test:**
1. npm start (restart server)
2. POST with valid auth token, get report table.

Suggest indexes: db.tasks.createIndex({taskType:1, dueDate:1, assignedTo:1, status:1})

Logic:
- Users: union of self (logged?), subordinates under srManager/manager, memberIds
- Date: compute from period or custom
- Tasks: {taskType: 'DelegationTask', dueDate in range, assignedTo in users}
- Stats: group by assignedTo, count status Completed/Delayed+Overdue/Pending
- Score: (doneOnTime/total * 100).toFixed(2)+'%'

