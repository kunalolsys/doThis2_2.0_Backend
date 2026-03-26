import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Delegation from '../src/models/Delegation.js';

dotenv.config({ path: '.env' });

const MONGO_URI = process.env.MONGO_URI || process.env.DATABASE || 'mongodb://localhost:27017/dothis2_2';

async function run() {
  await mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });
  console.log('Connected to MongoDB');

  const collection = mongoose.connection.collection('delegations');
  try {
    // Drop the old index if it exists
    const indexes = await collection.indexes();
    const taskIdIndex = indexes.find(idx => idx.name && idx.name.toLowerCase().includes('taskid'));
    if (taskIdIndex) {
      console.log('Found existing TaskId index:', taskIdIndex.name);
      await collection.dropIndex(taskIdIndex.name);
      console.log('Dropped index', taskIdIndex.name);
    }
  } catch (err) {
    console.warn('No existing TaskId index to drop or error dropping it:', err.message);
  }

  try {
    await collection.createIndex({ TaskId: 1 }, { unique: true, sparse: true });
    console.log('Created sparse unique index on TaskId');
  } catch (err) {
    console.error('Failed to create sparse unique index:', err.message);
  }

  await mongoose.disconnect();
  console.log('Disconnected');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});

// run().catch(err => {
//   console.error('Script error:', err);
//   process.exit(1);
// });
