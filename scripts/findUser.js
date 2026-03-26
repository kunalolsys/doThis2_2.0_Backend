import mongoose from 'mongoose';
import dotenv from 'dotenv';
import User from '../src/models/User.js';

dotenv.config();

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/dothis2';

async function run() {
    await mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });
    console.log('Connected to DB');

    const user = await User.findOne({ isActive: true });
    if (user) {
        console.log('Found user:', { id: user._id, name: user.name, email: user.email });
        console.log('Set SIM_ASSIGNEE_ID in .env to:', user._id);
    } else {
        console.log('No users found');
    }

    await mongoose.disconnect();
    console.log('Disconnected');
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
