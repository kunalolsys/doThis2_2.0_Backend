import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import express from 'express';
import bodyParser from 'body-parser';
import scheduleHolidayTaskRoutes from '../routes/scheduleHolidayTask.js';
import ScheduleHolidayTask from '../models/ScheduleHolidayTask.js';

let mongoServer;
const app = express();

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  const mongoUri = mongoServer.getUri();
  await mongoose.connect(mongoUri, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  });

  app.use(bodyParser.json());
  app.use('/schedule-holiday-task', scheduleHolidayTaskRoutes);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe('Schedule Holiday Task API', () => {
  it('should create a new schedule holiday task with action BEFORE', async () => {
    const res = await request(app)
      .post('/schedule-holiday-task')
      .send({ holidayAction: 'BEFORE' });
    expect(res.statusCode).toEqual(201);
    expect(res.body.data.task.holidayAction).toBe('BEFORE');
  });

  it('should update the schedule holiday task with action AFTER', async () => {
    await request(app)
      .post('/schedule-holiday-task')
      .send({ holidayAction: 'BEFORE' });
    
    const res = await request(app)
      .post('/schedule-holiday-task')
      .send({ holidayAction: 'AFTER' });
    
    expect(res.statusCode).toEqual(201);
    expect(res.body.data.task.holidayAction).toBe('AFTER');

    const tasks = await ScheduleHolidayTask.find({});
    expect(tasks.length).toBe(1);
  });

  it('should get the latest schedule holiday task', async () => {
    await request(app)
      .post('/schedule-holiday-task')
      .send({ holidayAction: 'AFTER' });

    const res = await request(app).get('/schedule-holiday-task');
    expect(res.statusCode).toEqual(200);
    expect(res.body.data.holidayAction).toBe('AFTER');
  });
});
