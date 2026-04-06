# FMS Template Designer Backend Implementation
Current Working Directory: d:/Kunal/dothis2_2.0/dothis2_2.0/dothis2_2.0_Backend

## Overview
✅ **Plan Approved**: Separate FmsTemplate/FmsTask models, reuse Task.js fields (description=Task Description, assignedTo=Doer), use dateCalculator helpers.

## Steps (In Order):

### 1. **Models** [PENDING]
   - [ ] Create `src/models/FmsTemplate.js`
   - [ ] Create `src/models/FmsTask.js` 
   - [ ] Update `src/models/Counter.js` (add fms counters)

### 2. **Controllers** [PENDING]
   - [ ] Create `src/controllers/fmsTemplateController.js` (CRUD templates)
   - [ ] Create `src/controllers/fmsTaskController.js` (create/list tasks for template)

### 3. **Routes** [PENDING]
   - [ ] Create `src/routes/fms.js`
   - [ ] Update `src/app.js` (mount /api/fms)

### 4. **Testing** [PENDING]
   - [ ] Test POST /api/fms/templates
   - [ ] Test POST /api/fms/templates/:id/tasks (bulk)
   - [ ] Verify validations/dependencies

### 5. **Polish** [PENDING]
   - [ ] Bulk CSV upload (extend importTasks logic)
   - [ ] Decision logic validation (ifTrue/elseStep exist)
   - [ ] Export templates

**Next Step: Create models (Step 1)**

**Progress: 0/5 complete**

