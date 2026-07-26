// Redux Toolkit slice — all experiment state + the async thunks that talk to GraphQL.
//
// This is where "Redux" lives in the stack. Redux Toolkit (RTK) is the modern,
// boilerplate-free way to write Redux: `createSlice` generates action creators and
// reducers, and `createAsyncThunk` wraps async calls (our GraphQL fetches) into
// pending/fulfilled/rejected actions we handle in `extraReducers`.
import { createAsyncThunk, createSlice, PayloadAction } from "@reduxjs/toolkit";
import { gql } from "@/lib/graphql";

export interface Variant {
  id: string;
  key: string;
  name: string;
  weight: number;
  isControl: boolean;
}
export interface Experiment {
  id: string;
  key: string;
  name: string;
  description?: string | null;
  status: "DRAFT" | "RUNNING" | "PAUSED" | "COMPLETED";
  variants: Variant[];
}
export interface VariantResult {
  variantKey: string;
  exposures: number;
  conversions: number;
  conversionRate: number;
}

// One user the operator has created this session, plus whether we've recorded a success.
export interface AssignedUser {
  experimentKey: string;
  userId: string;
  variantKey: string;
  converted: boolean;
}

interface ExperimentsState {
  items: Experiment[];
  selectedKey: string | null;
  resultsByKey: Record<string, VariantResult[]>;
  lastAssignment: { experimentKey: string; userId: string; variantKey: string; cached: boolean } | null;
  assignments: AssignedUser[];
  loading: boolean;
  error: string | null;
}

const initialState: ExperimentsState = {
  items: [],
  selectedKey: null,
  resultsByKey: {},
  lastAssignment: null,
  assignments: [],
  loading: false,
  error: null,
};

// --- async thunks (each is one GraphQL operation) ---

export const fetchExperiments = createAsyncThunk("experiments/fetchAll", async () => {
  const data = await gql<{ experiments: Experiment[] }>(`
    { experiments { id key name description status variants { id key name weight isControl } } }
  `);
  return data.experiments;
});

export const fetchResults = createAsyncThunk("experiments/fetchResults", async (key: string) => {
  const data = await gql<{ results: { experimentKey: string; variants: VariantResult[] } }>(
    `query($key:String!){ results(experimentKey:$key){ experimentKey variants { variantKey exposures conversions conversionRate } } }`,
    { key },
  );
  return { key, variants: data.results.variants };
});

export const assignUser = createAsyncThunk(
  "experiments/assignUser",
  async (args: { key: string; userId: string; variantKey?: string }) => {
    const data = await gql<{ assignUser: { variantKey: string; cached: boolean } }>(
      `mutation($key:String!,$u:String!,$v:String){ assignUser(experimentKey:$key,userId:$u,variantKey:$v){ variantKey cached } }`,
      { key: args.key, u: args.userId, v: args.variantKey ?? null },
    );
    return { experimentKey: args.key, userId: args.userId, ...data.assignUser };
  },
);

export const logConversion = createAsyncThunk(
  "experiments/logConversion",
  async (args: { key: string; userId: string }) => {
    await gql(`mutation($key:String!,$u:String!){ logEvent(experimentKey:$key,userId:$u,type:"conversion") }`, {
      key: args.key,
      u: args.userId,
    });
    return { experimentKey: args.key, userId: args.userId };
  },
);

export const setStatus = createAsyncThunk(
  "experiments/setStatus",
  async (args: { key: string; status: Experiment["status"] }) => {
    const data = await gql<{ setExperimentStatus: { key: string; status: Experiment["status"] } }>(
      `mutation($k:String!,$s:ExperimentStatus!){ setExperimentStatus(key:$k,status:$s){ key status } }`,
      { k: args.key, s: args.status },
    );
    return data.setExperimentStatus;
  },
);

// Clear an experiment's enrollments in the BACKEND (Postgres + Redis + Mongo),
// then drop them from the local board. Replaces the old front-end-only reducer,
// which left stale backend assignments — so re-enrolling a user hit "already exists".
export const clearBucket = createAsyncThunk("experiments/clearBucket", async (key: string) => {
  await gql(`mutation($k:String!){ clearEnrollments(experimentKey:$k) }`, { k: key });
  return key;
});

const slice = createSlice({
  name: "experiments",
  initialState,
  reducers: {
    selectExperiment(state, action: PayloadAction<string>) {
      state.selectedKey = action.payload;
    },
    // Restore the persisted board (from localStorage) on app mount.
    hydrateAssignments(state, action: PayloadAction<AssignedUser[]>) {
      state.assignments = action.payload;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchExperiments.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(fetchExperiments.fulfilled, (state, action) => {
        state.loading = false;
        state.items = action.payload;
        if (!state.selectedKey && action.payload.length) state.selectedKey = action.payload[0].key;
      })
      .addCase(fetchExperiments.rejected, (state, action) => {
        state.loading = false;
        state.error = action.error.message ?? "Failed to load experiments";
      })
      .addCase(fetchResults.fulfilled, (state, action) => {
        state.resultsByKey[action.payload.key] = action.payload.variants;
      })
      // Clear any prior error when a new attempt starts, so stale errors don't linger.
      .addCase(assignUser.pending, (state) => {
        state.error = null;
      })
      .addCase(assignUser.fulfilled, (state, action) => {
        state.lastAssignment = action.payload;
        state.error = null;
        // Upsert into the per-variant board. On a manual override a user's variant
        // can change, so update it in place (keeping their recorded-success status).
        const { experimentKey, userId, variantKey } = action.payload;
        const found = state.assignments.find(
          (a) => a.experimentKey === experimentKey && a.userId === userId,
        );
        if (found) {
          found.variantKey = variantKey;
        } else {
          state.assignments.push({ experimentKey, userId, variantKey, converted: false });
        }
      })
      .addCase(assignUser.rejected, (state, action) => {
        state.error = action.error.message ?? "Failed to assign user";
      })
      .addCase(logConversion.pending, (state) => {
        state.error = null;
      })
      // The important fix: surface the API's "User has no assignment" guardrail
      // instead of silently swallowing it.
      .addCase(logConversion.rejected, (state, action) => {
        state.error = action.error.message ?? "Failed to log conversion";
      })
      // Mark the user's success so the board disables their button.
      .addCase(logConversion.fulfilled, (state, action) => {
        const { experimentKey, userId } = action.payload;
        const u = state.assignments.find(
          (a) => a.experimentKey === experimentKey && a.userId === userId,
        );
        if (u) u.converted = true;
      })
      // Reflect a launch / roll-back on the experiment's status badge.
      .addCase(setStatus.fulfilled, (state, action) => {
        const it = state.items.find((e) => e.key === action.payload.key);
        if (it) it.status = action.payload.status;
      })
      .addCase(setStatus.rejected, (state, action) => {
        state.error = action.error.message ?? "Failed to change status";
      })
      .addCase(clearBucket.pending, (state) => {
        state.error = null;
      })
      .addCase(clearBucket.fulfilled, (state, action) => {
        // Backend cleared — now drop this experiment's users from the local board.
        state.assignments = state.assignments.filter((a) => a.experimentKey !== action.payload);
      })
      .addCase(clearBucket.rejected, (state, action) => {
        state.error = action.error.message ?? "Failed to clear buckets";
      });
  },
});

export const { selectExperiment, hydrateAssignments } = slice.actions;
export default slice.reducer;
