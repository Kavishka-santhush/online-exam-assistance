import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { request, endpoints } from '@/lib/apiClient';

/**
 * Exam slice — instructor-facing exam list, the currently-open exam (with its
 * sections + questions) and the builder working copy.
 *
 * The `draft` object is the unsaved working copy the Exam Builder edits; saving
 * posts it to the server which is the source of truth (sections, question
 * ordering, pool draws, recomputed totals all live server-side).
 */

export const fetchExams = createAsyncThunk(
  'exams/fetchList',
  async (params = {}, { rejectWithValue }) => {
    try {
      const { data, meta } = await request.paged(endpoints.exams.list, { params });
      return { items: data, meta };
    } catch (error) {
      return rejectWithValue(error.message);
    }
  },
);

export const fetchMyExams = createAsyncThunk('exams/fetchMine', async (params = {}, { rejectWithValue }) => {
  try {
    const { data, meta } = await request.paged(endpoints.exams.mine, { params });
    return { items: data, meta };
  } catch (error) {
    return rejectWithValue(error.message);
  }
});

export const fetchExam = createAsyncThunk('exams/fetchOne', async (id, { rejectWithValue }) => {
  try {
    return await request.get(endpoints.exams.byId(id));
  } catch (error) {
    return rejectWithValue(error.message);
  }
});

export const createExam = createAsyncThunk('exams/create', async (payload, { rejectWithValue }) => {
  try {
    return await request.post(endpoints.exams.root, payload);
  } catch (error) {
    return rejectWithValue({ message: error.message, details: error.details });
  }
});

export const updateExam = createAsyncThunk('exams/update', async ({ id, patch }, { rejectWithValue }) => {
  try {
    return await request.patch(endpoints.exams.byId(id), patch);
  } catch (error) {
    return rejectWithValue({ message: error.message, details: error.details });
  }
});

export const publishExam = createAsyncThunk('exams/publish', async ({ id, notify = true }, { rejectWithValue }) => {
  try {
    return await request.post(endpoints.exams.publish(id), { notify });
  } catch (error) {
    return rejectWithValue({ message: error.message, details: error.details });
  }
});

export const cloneExam = createAsyncThunk('exams/clone', async (id, { rejectWithValue }) => {
  try {
    return await request.post(endpoints.exams.clone(id), {});
  } catch (error) {
    return rejectWithValue(error.message);
  }
});

export const deleteExam = createAsyncThunk('exams/delete', async (id, { rejectWithValue }) => {
  try {
    await request.delete(endpoints.exams.byId(id));
    return id;
  } catch (error) {
    return rejectWithValue(error.message);
  }
});

export const addQuestionsToExam = createAsyncThunk(
  'exams/addQuestions',
  async ({ id, questionIds, sectionId = null }, { rejectWithValue }) => {
    try {
      return await request.post(endpoints.exams.questions(id), { questionIds, sectionId });
    } catch (error) {
      return rejectWithValue({ message: error.message, details: error.details });
    }
  },
);

export const recomputeExam = createAsyncThunk('exams/recompute', async (id, { rejectWithValue }) => {
  try {
    return await request.post(endpoints.exams.recompute(id), {});
  } catch (error) {
    return rejectWithValue(error.message);
  }
});

const initialState = {
  list: { items: [], meta: null, status: 'idle', error: null },
  current: { data: null, status: 'idle', error: null },
  draft: null, // builder working copy: { ...exam, sections: [], questions: [] }
  saving: false,
  lastSavedAt: null,
};

const examSlice = createSlice({
  name: 'exams',
  initialState,
  reducers: {
    clearCurrent: (state) => {
      state.current = { data: null, status: 'idle', error: null };
    },
    startDraft(state, action) {
      // action.payload is a fully-loaded exam (or a blank template for "new").
      state.draft = structuredCloneSafe(action.payload ?? blankExam());
    },
    patchDraft(state, action) {
      if (!state.draft) state.draft = blankExam();
      Object.assign(state.draft, action.payload);
    },
    patchDraftSection(state, { payload }) {
      if (!state.draft) return;
      const index = state.draft.sections?.findIndex((section) => section.id === payload.id || section.tempId === payload.id);
      if (index != null && index >= 0) Object.assign(state.draft.sections[index], payload.patch);
    },
    resetDraft: (state) => {
      state.draft = null;
    },
    setSaving(state, action) {
      state.saving = Boolean(action.payload);
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchExams.pending, (state) => {
        state.list.status = 'loading';
      })
      .addCase(fetchExams.fulfilled, (state, action) => {
        state.list = { items: action.payload.items, meta: action.payload.meta, status: 'ready', error: null };
      })
      .addCase(fetchExams.rejected, (state, action) => {
        state.list.status = 'error';
        state.list.error = action.payload;
      })
      .addCase(fetchMyExams.fulfilled, (state, action) => {
        state.list = { items: action.payload.items, meta: action.payload.meta, status: 'ready', error: null };
      })
      .addCase(fetchExam.pending, (state) => {
        state.current.status = 'loading';
      })
      .addCase(fetchExam.fulfilled, (state, action) => {
        state.current = { data: action.payload, status: 'ready', error: null };
      })
      .addCase(fetchExam.rejected, (state, action) => {
        state.current.status = 'error';
        state.current.error = action.payload;
      })
      .addCase(createExam.fulfilled, (state, action) => {
        state.list.items.unshift(action.payload);
        state.current = { data: action.payload, status: 'ready', error: null };
      })
      .addCase(updateExam.fulfilled, (state, action) => {
        const idx = state.list.items.findIndex((exam) => exam.id === action.payload.id);
        if (idx >= 0) state.list.items[idx] = { ...state.list.items[idx], ...action.payload };
        if (state.current.data?.id === action.payload.id) state.current.data = { ...state.current.data, ...action.payload };
      })
      .addCase(publishExam.fulfilled, (state, action) => {
        if (state.current.data?.id === action.payload.id) state.current.data = { ...state.current.data, ...action.payload };
        const idx = state.list.items.findIndex((exam) => exam.id === action.payload.id);
        if (idx >= 0) state.list.items[idx].status = action.payload.status ?? 'PUBLISHED';
      })
      .addCase(cloneExam.fulfilled, (state, action) => {
        state.list.items.unshift(action.payload);
      })
      .addCase(deleteExam.fulfilled, (state, action) => {
        state.list.items = state.list.items.filter((exam) => exam.id !== action.payload);
        if (state.current.data?.id === action.payload) state.current.data = null;
      })
      .addCase(addQuestionsToExam.fulfilled, (state, action) => {
        if (state.current.data && action.payload?.exam) state.current.data = action.payload.exam;
      })
      .addCase(recomputeExam.fulfilled, (state, action) => {
        if (state.current.data?.id === action.payload?.examId) state.current.data = { ...state.current.data, ...action.payload };
      });
  },
});

function blankExam() {
  return {
    id: null,
    title: '',
    description: '',
    instructions: '',
    type: 'TEST',
    status: 'DRAFT',
    language: 'en',
    durationMinutes: 60,
    passingPercent: 50,
    sections: [],
    questions: [],
    settings: {},
  };
}

function structuredCloneSafe(value) {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value));
  }
}

export const { clearCurrent, startDraft, patchDraft, patchDraftSection, resetDraft, setSaving } = examSlice.actions;

export const selectExamList = (state) => state.exams.list;
export const selectCurrentExam = (state) => state.exams.current.data;
export const selectCurrentExamStatus = (state) => state.exams.current.status;
export const selectExamDraft = (state) => state.exams.draft;

export default examSlice.reducer;
