import cron from 'node-cron';
import moment from 'moment';
import { Task } from '../models/Task.js'; // Aapka model path
import { calculateActivationDate } from '../utils/dateCalculator.js';

export const runDependencyCron = async () => {
  console.log('⏰ Running Cron: Checking Planned Dependencies...');
  
  try {
    // 1. Aise Tasks dhoondo jo Dependent hain, Planned setting hai, aur Active nahi hain
    const p2pTasks = await Task.find({
      isDependent: true,
      'dependencyConfig.startTimeSetting': 'planned-to-planned',
      status: 'Pending', // Ya ek 'Dormant' status agar aap use karte ho
      startDate: null // Matlab abhi start nahi hua hai
    }).populate('dependencyConfig.taskDependent');

    const now = moment();

    for (const childTask of p2pTasks) {
      const parentTask = childTask.dependencyConfig.taskDependent;
      
      if (!parentTask) continue;

      // 2. Calculate Target Date (Parent ki PLANNED Start Date se)
      const targetDate = calculateActivationDate(
        parentTask.startDate, // Parent ka start date base hai
        childTask.dependencyConfig.isDependentFrequency,
        childTask.dependencyConfig.xValue
      );

      // 3. Agar Time ho gaya hai -> Activate Child
      if (now.isSameOrAfter(targetDate)) {
        console.log(`🚀 Activating P2P Task: ${childTask.title}`);
        
        childTask.startDate = new Date(); // Aaj se start
        childTask.isDependent = false;    // Dependency khatam
        // Optional: Due date set karna hai toh yahan kar sakte ho
        if (childTask.taskEndDays) {
           childTask.dueDate = moment().add(childTask.taskEndDays, 'days');
        }
        
        await childTask.save();
      }
    }
  } catch (error) {
    console.error("Cron Error:", error);
  }
};

// ... existing code ...
// export async function runDependencyCron() { // Ensure it's exported
// //   `/ ... existing function content ...`
// }

// Schedule: Har ghante (Every Hour)
cron.schedule('0 * * * *', runDependencyCron);