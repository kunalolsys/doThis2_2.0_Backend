import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { DelegationTask, Task } from '../src/models/Task.js';

dotenv.config();

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/dothis2';
const ASSIGNEE_ID = process.env.SIM_ASSIGNEE_ID; // must provide an existing user id

async function run() {
    if (!ASSIGNEE_ID) {
        console.error('Please set SIM_ASSIGNEE_ID env var to a valid User _id');
        process.exit(1);
    }

    await mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });
    console.log('Connected to DB');

    // Create parent task (delegation) with specified dueDate
    const parentDue = new Date();
    parentDue.setDate(parentDue.getDate() + 2); // parent due in 2 days

    const parent = await DelegationTask.create({
        title: 'Simulated Parent Task',
        description: 'Parent for dependent simulation',
        assignedTo: ASSIGNEE_ID,
        createdBy: ASSIGNEE_ID,
        updatedBy: ASSIGNEE_ID,
        startDate: new Date(),
        dueDate: parentDue,
        status: 'Pending'
    });

    console.log('Parent created:', { id: parent._id, TaskId: parent.TaskId, dueDate: parent.dueDate });

    // Dependent child params
    const startTimeSetting = 'planned-to-planned';
    const isDependentFrequency = 'T+X in days';
    const xValue = 2; // offset from parent end
    const taskEndDays = 3; // child's duration value

    // Compute child start based on parent.dueDate
    const baseDate = parent.dueDate || parent.endDate || parent.startDate;
    const childStart = new Date(baseDate);
    childStart.setDate(childStart.getDate() + xValue);

    // Off-by-one: taskEndDays=1 => same day
    const addDays = Math.max(0, taskEndDays - 1);
    const childDue = new Date(childStart);
    childDue.setDate(childDue.getDate() + addDays);

    const child = await DelegationTask.create({
        title: 'Simulated Child Task',
        description: 'Child created by simulate script',
        assignedTo: ASSIGNEE_ID,
        createdBy: ASSIGNEE_ID,
        updatedBy: ASSIGNEE_ID,
        isDependent: true,
        dependencyConfig: {
            taskDependent: parent._id,
            startTimeSetting,
            isDependentFrequency,
            xValue,
            taskEndDays
        },
        startDate: childStart,
        dueDate: childDue,
        status: 'Pending'
    });

    console.log('Child created:', { id: child._id, startDate: child.startDate, dueDate: child.dueDate });

    await mongoose.disconnect();
    console.log('Disconnected');
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
