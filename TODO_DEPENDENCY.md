# "actual-to-planned" Dependency + isVisible Fix - COMPLETED ✅

## Summary:
- ✅ **Step 1**: createTask() - actual-to-planned dependents now `isVisible=true`, `status=Upcoming` immediately. Planned use cron.
- ✅ **Step 2**: toggleTaskCompletion() & getTaskById() - Enhanced parent completion trigger: workshift-aware child date calculation (addWorkingDaysHoliday/nextWorkingShiftDate), sets `isVisible=true`, recalculates status, adds detailed logging.
- ✅ **Step 3**: Queries enhanced for proper dependent visibility.

## Files Updated:
- `src/controllers/taskController.js` ✅

## How it Works:
```
1. Create actual-to-planned child → isVisible=true, status=Upcoming, startDate=null
2. Parent completes → toggleTaskCompletion triggers: 
   ├─ Calculates child.startDate = parent.completedAt + X (workshift-aware)
   ├─ Sets child.isVisible=true  
   ├─ Recalculates status via cron logic
   └─ Logs activation
3. Frontend shows waiting dependents + auto-activated ones
```

## Test Steps:
```
### [ ] Manual Test:
1. Create parent task, mark complete
2. Create child (actual-to-planned, parent=this)
3. Verify: child shows immediately (Upcoming/waiting)
4. Re-complete parent → child gets proper startDate + visible=true

### [ ] Check Logs:
`DEPENDENCY_ACTIVATED` entries when parent completes
```

**Ready for testing!** Restart server and try creating dependent tasks.

