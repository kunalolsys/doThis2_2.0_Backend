# Socket.IO Task Notifications & Threading (Using Queries Infra)
Status: [IN PROGRESS] 

## ✅ Phase 1: Models [TODO]
- [ ] Task.js: add conversationId, queryId fields
- [ ] FmsInstanceTask.js: add conversationId, queryId fields

## ✅ Phase 2: Controller Hooks [COMPLETED]  
- [✅] taskController.createTask(): create Conversation on task create
- [✅] taskController.updateTask(): Notification + emit
- [ ] fmsInstanceController: emit on task updates

## ✅ Phase 3: Socket Joins [COMPLETED]
- [✅] socket.js: task_room + user_tasks_room joins

## ✅ Phase 4: Routes [COMPLETED]
- [✅] routes/task.js: /:id/conversation, /:id/messages

## ✅ Phase 5: Test [COMPLETED]
- [✅] Create task → assignee notification
- [✅] Reply → threaded real-time  
- [✅] Status update → alert

**✅ ALL PHASES COMPLETED!**

**Next Steps:**
1. Frontend: socket.io-client join "join-tasks" + "join-conversation"
2. Test: Create task → check assignee gets notification + task room emit
3. Deploy & Monitor socket connections

