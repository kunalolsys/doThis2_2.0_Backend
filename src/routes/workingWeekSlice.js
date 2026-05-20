import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import axios from 'axios';

const API_URL = `${import.meta.env.VITE_API_URL}/working-week`;

export const fetchWorkingWeek = createAsyncThunk(
  'workingWeek/fetchWorkingWeek',
  async (_, { rejectWithValue }) => {
    try {
      const response = await axios.get(API_URL);
      return response.data.data.workingWeek;
    } catch (error) {
      const message =
        (error.response && error.response.data && error.response.data.message) ||
        error.message ||
        error.toString();
      return rejectWithValue(message);
    }
  }
);

// Async thunk for updating (upserting) the working week configuration
export const updateWorkingWeek = createAsyncThunk(
  'workingWeek/updateWorkingWeek',
  async (workingWeekData, { rejectWithValue }) => {
    try {
      const response = await axios.patch(API_URL, workingWeekData);
      return response.data.data.workingWeek;
    } catch (error) {
      const message =
        (error.response && error.response.data && error.response.data.message) ||
        error.message ||
        error.toString();
      return rejectWithValue(message);
    }
  }
);

const initialState = {
  workingWeek: null,
  status: 'idle', // 'idle' | 'loading' | 'succeeded' | 'failed'
  error: null,
};

const workingWeekSlice = createSlice({
  name: 'workingWeek',
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(fetchWorkingWeek.pending, (state) => {
        state.status = 'loading';
      })
      .addCase(fetchWorkingWeek.fulfilled, (state, action) => {
        state.status = 'succeeded';
        state.workingWeek = action.payload;
      })
      .addCase(fetchWorkingWeek.rejected, (state, action) => {
        state.status = 'failed';
        state.error = action.payload;
      })
      .addCase(updateWorkingWeek.pending, (state) => {
        state.status = 'loading';
      })
      .addCase(updateWorkingWeek.fulfilled, (state, action) => {
        state.status = 'succeeded';
        state.workingWeek = action.payload;
      })
      .addCase(updateWorkingWeek.rejected, (state, action) => {
        state.status = 'failed';
        state.error = action.payload;
      });
  },
});

export default workingWeekSlice.reducer;