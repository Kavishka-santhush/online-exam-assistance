import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { request, endpoints, setActiveOrganization } from '@/lib/apiClient';

/**
 * Auth slice — the identity + organization-context mirror of `/api/auth` and
 * `/api/organizations/mine`.
 *
 * Clerk owns the session (login / MFA / OAuth); this slice only tracks the
 * local `User` row the server returns from `GET /auth/me` plus the list of
 * organizations the user belongs to and which one is *active*. Switching the
 * active organization also updates the axios interceptor so every subsequent
 * request carries the right `X-Organization-Id` header.
 */

export const fetchMe = createAsyncThunk('auth/fetchMe', async (_, { rejectWithValue }) => {
  try {
    return await request.get(endpoints.auth.me);
  } catch (error) {
    return rejectWithValue(error.message);
  }
});

export const fetchFlags = createAsyncThunk('auth/fetchFlags', async (_, { rejectWithValue }) => {
  try {
    return await request.get(endpoints.auth.flags);
  } catch (error) {
    return rejectWithValue(error.message);
  }
});

export const fetchMyOrganizations = createAsyncThunk('auth/fetchMyOrganizations', async (_, { rejectWithValue }) => {
  try {
    const data = await request.get(endpoints.organizations.mine);
    return Array.isArray(data) ? data : data?.organizations ?? data?.items ?? [];
  } catch (error) {
    return rejectWithValue(error.message);
  }
});

export const updateProfile = createAsyncThunk('auth/updateProfile', async (patch, { rejectWithValue }) => {
  try {
    return await request.patch(endpoints.auth.profile, patch);
  } catch (error) {
    return rejectWithValue({ message: error.message, details: error.details });
  }
});

export const acceptInvite = createAsyncThunk('auth/acceptInvite', async (token, { rejectWithValue }) => {
  try {
    return await request.post(endpoints.auth.acceptInvite, { token });
  } catch (error) {
    return rejectWithValue(error.message);
  }
});

const initialState = {
  user: null,
  organizations: [],
  activeOrganizationId: null,
  flags: {},
  status: 'idle', // idle | loading | ready
  error: null,
  hydrated: false,
};

/** Pick a sensible default active org (prefer admin/instructor contexts). */
function defaultActiveOrganization(organizations, previous) {
  if (previous && organizations.some((org) => org.id === previous)) return previous;
  const ranked = ['ORG_ADMIN', 'INSTRUCTOR', 'PROCTOR', 'CANDIDATE'];
  const sorted = [...organizations].sort(
    (a, b) => ranked.indexOf(a.role ?? 'CANDIDATE') - ranked.indexOf(b.role ?? 'CANDIDATE'),
  );
  return sorted[0]?.id ?? null;
}

const authSlice = createSlice({
  name: 'auth',
  initialState,
  reducers: {
    signOutCleared: (state) => {
      // Clerk owns sign-out; we just reset the mirrored local state.
      Object.assign(state, { ...initialState });
      setActiveOrganization(null);
    },
    switchOrganization: (state, action) => {
      const id = action.payload ?? null;
      state.activeOrganizationId = id;
      setActiveOrganization(id);
    },
    setFlags: (state, action) => {
      state.flags = action.payload ?? {};
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchMe.pending, (state) => {
        state.status = 'loading';
      })
      .addCase(fetchMe.fulfilled, (state, action) => {
        state.status = 'ready';
        state.user = action.payload;
        state.hydrated = true;
        // `/auth/me` embeds memberships; seed organizations if not yet loaded.
        if (action.payload?.memberships && state.organizations.length === 0) {
          state.organizations = action.payload.memberships.map((m) => ({
            id: m.organizationId,
            role: m.role,
            name: m.organization?.name,
            slug: m.organization?.slug,
            branding: m.organization?.branding,
          }));
          state.activeOrganizationId = defaultActiveOrganization(state.organizations, state.activeOrganizationId);
          setActiveOrganization(state.activeOrganizationId);
        }
      })
      .addCase(fetchMe.rejected, (state, action) => {
        state.status = 'ready';
        state.error = action.payload ?? 'Failed to load profile';
        state.hydrated = true;
      })
      .addCase(fetchFlags.fulfilled, (state, action) => {
        state.flags = action.payload ?? {};
      })
      .addCase(fetchMyOrganizations.fulfilled, (state, action) => {
        state.organizations = action.payload;
        state.activeOrganizationId = defaultActiveOrganization(action.payload, state.activeOrganizationId);
        setActiveOrganization(state.activeOrganizationId);
      })
      .addCase(updateProfile.fulfilled, (state, action) => {
        state.user = { ...state.user, ...action.payload };
      })
      .addCase(acceptInvite.fulfilled, (state, action) => {
        // Joining an org via invite refreshes the org list from the response.
        const org = action.payload?.organization;
        if (org && !state.organizations.some((entry) => entry.id === org.id)) {
          state.organizations.push(org);
        }
        if (org?.id) {
          state.activeOrganizationId = org.id;
          setActiveOrganization(org.id);
        }
      });
  },
});

export const { signOutCleared, switchOrganization, setFlags } = authSlice.actions;

export const selectUser = (state) => state.auth.user;
export const selectOrganizations = (state) => state.auth.organizations;
export const selectActiveOrganizationId = (state) => state.auth.activeOrganizationId;
export const selectActiveOrganization = (state) =>
  state.auth.organizations.find((org) => org.id === state.auth.activeOrganizationId) ?? null;
export const selectFlags = (state) => state.auth.flags;
export const selectAuthStatus = (state) => state.auth.status;
export const selectIsHydrated = (state) => state.auth.hydrated;

/** Role helpers — combine platform + active-org role into capability checks. */
export const selectPlatformRole = (state) => state.auth.user?.platformRole ?? null;
export const selectOrgRole = (state) => selectActiveOrganization(state)?.role ?? null;
export const selectIsStaff = (state) => {
  const orgRole = selectOrgRole(state);
  return ['ORG_ADMIN', 'INSTRUCTOR', 'PROCTOR'].includes(orgRole) || state.auth.user?.platformRole === 'SUPER_ADMIN';
};
export const selectIsAuthor = (state) => {
  const orgRole = selectOrgRole(state);
  return ['ORG_ADMIN', 'INSTRUCTOR'].includes(orgRole) || state.auth.user?.platformRole === 'SUPER_ADMIN';
};
export const selectIsProctor = (state) => {
  const orgRole = selectOrgRole(state);
  return ['ORG_ADMIN', 'PROCTOR'].includes(orgRole) || state.auth.user?.platformRole === 'SUPER_ADMIN';
};
export const selectIsSuperAdmin = (state) => state.auth.user?.platformRole === 'SUPER_ADMIN';

export default authSlice.reducer;
