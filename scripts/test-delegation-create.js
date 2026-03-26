import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Delegation from '../src/models/Delegation.js';

dotenv.config({ path: '.env' });

const MONGO_URI = process.env.MONGO_URI || process.env.DATABASE || 'mongodb://localhost:27017/dothis2_2';

async function testDelegationCreation() {
  try {
    await mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });
    console.log('✓ Connected to MongoDB');

    // Test data - simulating what the frontend would send
    const testTask = {
      asignTo: new mongoose.Types.ObjectId(), // Random user ID
      title: 'Test Delegation Task',
      description: 'This is a test task to verify the E11000 fix',
      status: 'Pending',
      startDate: new Date(),
      dueDate: new Date(new Date().setDate(new Date().getDate() + 1)),
      // TaskId will default to null
    };

    console.log('\n[TEST] Creating first delegation task...');
    const task1 = new Delegation(testTask);
    await task1.save();
    console.log('✓ Task 1 saved:', task1._id);

    console.log('\n[TEST] Creating second delegation task (both have null TaskId)...');
    const task2 = new Delegation(testTask);
    await task2.save();
    console.log('✓ Task 2 saved:', task2._id);

    console.log('\n[TEST] Creating third delegation task with null TaskId...');
    const task3 = new Delegation(testTask);
    await task3.save();
    console.log('✓ Task 3 saved:', task3._id);

    // Count null TaskIds
    const nullCount = await Delegation.countDocuments({ TaskId: null });
    console.log(`\n✓ Total tasks with null TaskId: ${nullCount}`);

    // Verify they're all in the database
    const allTasks = await Delegation.find({ _id: { $in: [task1._id, task2._id, task3._id] } });
    console.log(`✓ Retrieved ${allTasks.length} tasks from database`);

    console.log('\n✓✓✓ All tests passed! The E11000 fix is working correctly. ✓✓✓');
    console.log('\nYou can now create delegation tasks without E11000 errors.');

  } catch (error) {
    console.error('\n✗ Test failed:', error.message);
    if (error.code === 11000) {
      console.error('\n⚠ E11000 Error detected - The sparse unique index may not be properly applied.');
      console.error('   Run: node scripts/fix-delegation-index.js');
    }
  } finally {
    await mongoose.disconnect();
    console.log('\nDisconnected from MongoDB');
  }
}

testDelegationCreation().catch(err => {
  console.error('Script error:', err);
  process.exit(1);
});
