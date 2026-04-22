# DoThis2 Task Management System - COMPLETE API REFERENCE MANUAL

**Version 3.0** | **ALL APIs + Fields + Conditions Explained** | **Oct 2025**

## 🔥 LIVE API BASE: `/api/v1/`

**Auth**: JWT cookie (`userId`) required for ALL except login

---

## 1. AUTHENTICATION

### `POST /auth/login`
**Fields**:
```
email: string (required)
password: string (required)
```
**Response**:
```json
{ "success": true, "token": "jwt", "user": {id,name,email,role} }
```
**Sets**: `userId` cookie

### `POST /auth/logout`
**Fields**: None
**Effect**: Clears `userId` cookie

---

## 2. TASKS (`/tasks`) - FULL CRUD + ADVANCED

### `POST /tasks` - CREATE (Multi-Assignee + Shift-Aware)
**Form-Data** (multipart):
```
title: string (req) - Task name
description: string (req) - Details
assignedTo: string|array (req) - User ID(s) ["id1","id2"]
startDate: date (opt) - DD-MM-YYYY/ISO → next shift start
taskEndDays: number (opt) - Working days ahead (holidays skipped)
isDependent: boolean - Enable deps
parentTask: string - Parent TaskId (e.g. "25100001")
startTimeSetting: "planned-to-planned"|"actual-to-planned"
isDependentFrequency: "T+X in days"|"T-X in hours"
xValue: number - Lag value
isRecurrent: boolean - Recurring mode
frequency: "Daily|Weekly|Monthly|Quarterly|Half Yearly|Yearly"
weekDays: array - ["monday","tuesday"]
recurrenceEndDate: date
checklist: JSON string - '[{"text":"Step1","isCompleted":false}]'
attachmentFile[]: files (multi)
```
**Conditions**:
- **Per assignee**: Separate TaskId (YYMMNNNN), shift-aware dates
- **Dependent**: planned=parent.planned+X | actual=parent.complete+X
- **Recurring**: Validates start=working day + weekdays
- **Visibility**: `isVisible=false` → cron enables
**Response**:
```json
{ "data": [{TaskId:"25100045",startDate,dueDate,...}] }
```

### `GET /tasks` - LIST (Filtered)
**Query Params**:
```
userId: id, departmentId: id, status: string, search: string
page: number=1, limit: number=10, taskCategory: "today_backlog|upcoming"
creatorOrAssignorId: id (tasks by/to this user)
```
**Conditions**:
- Role hierarchy auto-applied
- `isVisible=true` (except Upcoming)
**Response**:
```json
{ data: [...], totalTasks: 50, currentPage: 1 }
```

### `POST /tasks/filter` - ADVANCED FILTER
**Body**:
```
filters: {stat:"overdue",taskCategory:"today_backlog",status:"Pending"}
userId,departmentId,createdBy,assignedBy,date range (startDate/endDate)
```
**Special**:
- `overdue`: dueDate<today && !Completed
- FMS tasks merged (`FmsInstanceTask.taskId`)

### `POST /tasks/role-based-tasks` - HIERARCHY VIEW
**Body**:
```
role: "Sr. Manager", userId: id
selectedDoer: id, selectedManager: id
```
**Logic**:
- Sr.Manager: self+managers+members (recursive)
- Pagination + FMS merged

### `POST /tasks/myTask-stats`
**Returns**: `{total:25,overdue:3,pending:15,completed:7}` (user + FMS)

### `GET /tasks/:id`
**Populates**: assignedTo,dependencyConfig.taskDependent

### `PUT /tasks/:id` - UPDATE
**Fields**: All create fields + `status`, `existingFiles[]`, `removedFiles[]`
**File handling**: Merge existing + new - removed (deletes files)

### `PATCH /tasks/:id/completion`
```
{completeStatus: true}  # Validates checklist 100%
```
**Triggers**: actual-to-planned children

### `PATCH /tasks/:id/checklist/:index`
```
{completed: true}
```

### `DELETE /tasks/:id` - Single
### `DELETE /tasks/:id/force` - Parent + Children

---

## 3. FMS (`/fms`) - Templates → Instances

### `POST /fms/templates` - CREATE TEMPLATE
```
templateName: string, fmsDuration: "Fixed Period"
manager/srManager: ids
tasks: array of FmsTask:
  taskId:"T01", description, assignedTo, frequency:"Once"
  checklist:[], createdForm:[{fieldName:"scope",isMandatory:true}]
```

### `POST /fms/instances/:templateId` - LAUNCH
```
launchDate: ISO (defaults now)
```
**Generates**: Sequential FmsInstanceTasks (deps resolved)

### `PATCH /fms/instances/:instId/tasks/:taskId`
```
checklist: [...], formData: {scope:"Full"}, status:"Completed"
```
**Validation**: Mandatory forms + checklist for complete

### Instance Controls:
```
PATCH /fms/instances/:id/hold  #{reason:"Vacation"}
PATCH /fms/instances/:id/resume
PATCH /fms/instances/:id/stop
```

### List: `POST /fms/instances`
```
search: "Audit", status:"ongoing", page/limit
```

---

## 4. USERS (`/users`)

### `POST /users` - CREATE
```
name,email,phone,password,department[],role,reportingManager,assignShift
employeeCode: unique, secondaryEmail, mainEmailType:"email|secondary"
```

### `POST /users/list` - FILTER
```
active:true, managerId: id (+recursive subs)
role,department[],assignShift,search: "john"
page/limit
```

### `PUT /users/:id` - UPDATE (partial)

### `DELETE /users/:id` - Soft delete (`isDeleted=true`)

---

## 5. QUERIES (`/queries`)

### `POST /queries/raise`
```
taskId: "25100001" (Task/FMS), message, assignedTo: id
```
**Auto**: Creates Conversation, socket emit, notification

### `POST /queries/reply`
```
queryId, conversationId, text
```
**Marks**: Query "Responded"

### `GET /queries/task/:taskId`
### `GET /queries/raised` - My raised
### `GET /queries/assigned-to-me`

---

## 6. NOTIFICATIONS (`/notifications` - from controller)

### `GET /notifications/unread-count`
### `PATCH /notifications/:id/read`
### `PATCH /notifications/all-read`

**Real-time**: Socket.IO "notification", "notification-read"

---

## 7. OTHER ROUTES

**From index.js**:
```
/setup - Initial data
/work-shifts - Shifts CRUD
/logs - Audit logs
/mis - Reports
/schedule-holiday-task
/thread - Messages
```

**Files**:
```
POST /tasks/upload-attachment → {filenames:[]}
GET /download?filePath=... 
GET /tasks/export → CSV/XLSX
POST /tasks/import (CSV/XLSX validation)
```

---

## 8. FIELD VALIDATIONS & CONDITIONS

| Field | Type | Req | Validation | Effect |
|-------|------|-----|------------|---------|
| assignedTo | id[] | Y | User exists+shift | Per-user TaskId/shift-dates |
| taskEndDays | number | N | >0 | due=start+workingDays (holidays skip) |
| startTimeSetting | enum | Dep | "planned\|actual" | Dep trigger mode |
| checklist | array | N | All complete→allow finish | Progress calc |
| frequency | enum | Rec | Working day start | Cron validation |
| isVisible | bool | Sys | Cron sets | Dashboard filter |

**Error Responses**:
```
400: Missing req field / Invalid date / Checklist incomplete
404: Task/User not found
422: Import header mismatch (exact: "Task Title")
```

**Success**: `{success:true, data:..., message:"Created X tasks"}`

---

**ALL APIs Documented** | **Production Ready** | Check `code docs/USER_MANUAL.md`

