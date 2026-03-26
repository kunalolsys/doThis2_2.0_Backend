import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Delegation from '../src/models/Delegation.js';

dotenv.config({ path: '.env' });

const MONGO_URI = process.env.MONGO_URI || process.env.DATABASE || 'mongodb://localhost:27017/dothis2_2';

async function checkDatabase() {
  try {
    await mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });
    console.log('✓ Connected to MongoDB\n');

    // Check delegations collection
    const collectionExists = await mongoose.connection.db.listCollections().toArray();
    const delegationCollExists = collectionExists.some(c => c.name === 'delegations');
    
    if (!delegationCollExists) {
      console.log('⚠ Delegations collection does NOT exist yet');
      console.log('  (It will be created on first insert)\n');
    } else {
      console.log('✓ Delegations collection EXISTS\n');
    }

    // Count documents
    const count = await Delegation.countDocuments({});
    console.log(`Total tasks in delegations collection: ${count}\n`);

    if (count > 0) {
      console.log('Recent tasks:');
      const tasks = await Delegation.find({})
        .sort({ createdAt: -1 })
        .limit(5)
        .select('title status startDate dueDate TaskId createdAt');
      
      tasks.forEach((task, i) => {
        console.log(`\n${i + 1}. Title: ${task.title}`);
        console.log(`   Status: ${task.status}`);
        console.log(`   TaskId: ${task.TaskId}`);
        console.log(`   Created: ${task.createdAt}`);
        console.log(`   Start: ${task.startDate} → Due: ${task.dueDate}`);
      });
    } else {
      console.log('❌ NO tasks found in delegations collection');
      console.log('   This means tasks are not being saved to the database!\n');
    }

    // Check indexes
    console.log('\n\nIndexes on delegations collection:');
    const indexes = await Delegation.collection.getIndexes();
    Object.entries(indexes).forEach(([name, spec]) => {
      console.log(`  - ${name}: ${JSON.stringify(spec)}`);
    });

    // Check MongoDB stats
    const stats = await Delegation.collection.stats();
    console.log(`\n\nCollection Stats:`);
    console.log(`  Document count: ${stats.count}`);
    console.log(`  Size: ${stats.size} bytes`);
    console.log(`  Storage size: ${stats.storageSize} bytes`);

  } catch (error) {
    console.error('✗ Error:', error.message);
  } finally {
    await mongoose.disconnect();
    console.log('\n\nDisconnected from MongoDB');
  }
}

checkDatabase();
