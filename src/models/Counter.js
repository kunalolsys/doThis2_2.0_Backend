import mongoose from 'mongoose';

const CounterSchema = new mongoose.Schema({
  _id: { type: String, required: true }, // Name of the counter, e.g., 'taskId'
  seq: { type: Number, default: 0 }    // Current sequence value
});

const Counter = mongoose.model('Counter', CounterSchema);

export default Counter;