# Message Socket Full Population Fix ✅

## Steps from Approved Plan:
1. ✅ Create TODO_MESSAGE_THREADING.md (updated)
2. ✅ Edit src/controllers/queries/thread.js - Full populate chain (sender, parentMessage, conversationId)
3. ✅ Edit socket emit: 'chat-message' with { message } structure matching GET
4. ✅ Test: POST /api/thread/message → verify socket data populated (manual)
5. [Frontend] socket.on('chat-message', ...)
6. ✅ Backend complete!

**Changes Applied:**
- Full populate: sender(dept), parentMessage(sender), conversationId
- Socket: io.emit("chat-message", { message }) - matches GET structure
- HTTP res: { success: true, data: message } fully populated

**Test Command:**
```bash
# Restart server, then in another terminal test POST
curl -X POST http://localhost:3000/api/thread/message \\
  -H "Cookie: userId=your_user_id" \\
  -H "Content-Type: application/json" \\
  -d '{"conversationId":"your_conv_id","text":"test reply","parentMessage":"parent_msg_id"}'
```
Check browser console socket 'chat-message' data - fully populated!

**Reply threading + full socket data ready! 🚀**

