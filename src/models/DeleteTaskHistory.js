import mongoose from 'mongoose';

const DeleteTaskHistorySchema = new mongoose.Schema({
    deleteParentTaskId: {
        type: String,
        // required: true,
        default: null,
    },
    deletedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
    },
    remark: {
        type: String,
        required: false,
    },
    // Count of tasks removed as part of this operation (including the parent)
    deletedTasksCount: {
        type: Number,
        default: 0,
    },
    // IDs of tasks deleted (references to Task collection)
    deletedTaskIds: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Task'
    }],
}, { timestamps: true });

export const DeleteTaskHistory = mongoose.model('DeleteTaskHistory', DeleteTaskHistorySchema);
export default DeleteTaskHistory;