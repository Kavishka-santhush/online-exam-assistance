import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { request, endpoints } from '@/lib/apiClient';

/**
 * Notification slice — the in-app inbox.
 *
 * The personal socket room (`user:<id>`) pushes `notification:new`, which the
 * `useNotificationSocket` hook prepends to `items` and folds into `unread`, so
 * the bell badge stays correct without polling. REST fills the initial window
 * and the read / preferences mutations.
 */

export const fetchNotifications = createAsyncThunk('notifications/fetch', async (params = {}, { rejectWithValue }) => {
  try {
    const { data, meta } = await request.paged(endpoints.notifications.list, { params: { limit: 20, ...params } });
    return { items: Array.isArray(data) ? data : data?.items ?? [], meta, unreadOnly: params.unreadOnly === true };
  } catch (error) {
    return rejectWithValue(error.message);
  }
});

export const markNotificationRead = createAsyncThunk('notifications/markRead', async ({ id, read = true }, { rejectWithValue }) => {
  try {
    return await request.patch(endpoints.notifications.byId(id), { read });
  } catch (error) {
    return rejectWithValue(error.message);
  }
});

export const markAllNotificationsRead = createAsyncThunk('notifications/markAllRead', async (_, { rejectWithValue }) => {
  try {
    return await request.post(endpoints.notifications.readAll, {});
  } catch (error) {
    return rejectWithValue(error.message);
  }
});

export const fetchPreferences = createAsyncThunk('notifications/fetchPreferences', async (_, { rejectWithValue }) => {
  try {
    return await request.get(endpoints.notifications.preferences);
  } catch (error) {
    return rejectWithValue(error.message);
  }
});

export const updatePreferences = createAsyncThunk('notifications/updatePreferences', async (patch, { rejectWithValue }) => {
  try {
    return await request.put(endpoints.notifications.preferences, patch);
  } catch (error) {
    return rejectWithValue({ message: error.message, details: error.details });
  }
});

const initialState = {
  items: [],
  meta: null,
  unread: 0,
  announcements: [],
  preferences: null,
  status: 'idle',
  error: null,
};

const notificationSlice = createSlice({
  name: 'notifications',
  initialState,
  reducers: {
    notificationReceived(state, action) {
      const incoming = action.payload;
      if (state.items.some((item) => item.id === incoming.id)) return;
      state.items.unshift(incoming);
      if (!incoming.readAt) state.unread += 1;
      if (state.items.length > 60) state.items.length = 60;
    },
    setUnread(state, action) {
      state.unread = Number(action.payload) || 0;
    },
    removeNotification(state, action) {
      state.items = state.items.filter((item) => item.id !== action.payload);
    },
    announcementReceived(state, action) {
      state.announcements.unshift(action.payload);
    },
    dismissAnnouncement(state, action) {
      state.announcements = state.announcements.filter((entry) => entry.id !== action.payload);
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchNotifications.pending, (state) => {
        state.status = 'loading';
      })
      .addCase(fetchNotifications.fulfilled, (state, action) => {
        state.status = 'ready';
        if (action.payload.unreadOnly) {
          // leave existing, just refresh meta
        } else {
          state.items = action.payload.items;
        }
        state.meta = action.payload.meta;
      })
      .addCase(fetchNotifications.rejected, (state, action) => {
        state.status = 'error';
        state.error = action.payload;
      })
      .addCase(markNotificationRead.fulfilled, (state, action) => {
        const item = state.items.find((entry) => entry.id === action.payload?.id);
        if (item) {
          const wasUnread = !item.readAt;
          item.readAt = action.payload.readAt ?? new Date().toISOString();
          if (wasUnread && action.payload.read !== false) state.unread = Math.max(0, state.unread - 1);
        }
      })
      .addCase(markAllNotificationsRead.fulfilled, (state) => {
        for (const item of state.items) item.readAt = item.readAt ?? new Date().toISOString();
        state.unread = 0;
      })
      .addCase(fetchPreferences.fulfilled, (state, action) => {
        state.preferences = action.payload;
      });
  },
});

export const { notificationReceived, setUnread, removeNotification, announcementReceived, dismissAnnouncement } =
  notificationSlice.actions;

export const selectNotifications = (state) => state.notifications.items;
export const selectUnreadCount = (state) => state.notifications.unread;
export const selectNotificationMeta = (state) => state.notifications.meta;
export const selectAnnouncements = (state) => state.notifications.announcements;
export const selectNotificationPreferences = (state) => state.notifications.preferences;

export default notificationSlice.reducer;
