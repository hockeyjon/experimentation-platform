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

// One variant as computed by the Python stats service and pushed over SSE. Same counts as
// VariantResult plus the analysis the z-test adds — lift measured against the control the
// API supplied, and whether the difference clears alpha = 0.05.
export interface VariantSignificance extends VariantResult {
  isControl: boolean;
  liftPct: number;
  zScore?: number;
  pValue: number | null;
  significant: boolean;
}
export interface Significance {
  experimentKey: string;
  controlVariant?: string;
  variants: VariantSignificance[];
  note?: string;
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
  // Backend-derived stats, pushed from the Python service over SSE. Not persisted — it is
  // a live view of the server's numbers, re-pushed on reconnect.
  significanceByKey: Record<string, Significance>;
  statsConnected: boolean;
  // True between the Backend tab's Restart wiping local state and the api coming back.
  // Distinct from `loading`: there is no request in flight, the services are simply down.
  restarting: boolean;
  lastAssignment: { experimentKey: string; userId: string; variantKey: string; cached: boolean } | null;
  assignments: AssignedUser[];
  loading: boolean;
  error: string | null;
}

const initialState: ExperimentsState = {
  items: [],
  selectedKey: null,
  resultsByKey: {},
  significanceByKey: {},
  statsConnected: false,
  restarting: false,
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
    // Back to a blank slate. Paired with the Backend tab's Restart, which wipes the
    // backend's enrollments and recreates the services — so the browser shouldn't keep
    // holding a board, a selection or cached stats that no longer exist server-side.
    // The persistence subscriber writes the now-empty board through to localStorage.
    resetState: () => initialState,
    // Dispatched right after resetState (which would otherwise clear this flag), and
    // cleared by the fetchExperiments that fires once the api reports ready.
    backendRestartStarted(state) {
      state.restarting = true;
    },
    // A frame arrived on the stats SSE stream — the Python service recomputed.
    significancePushed(state, action: PayloadAction<Significance>) {
      state.significanceByKey[action.payload.experimentKey] = action.payload;
      state.statsConnected = true;
    },
    statsStreamClosed(state) {
      state.statsConnected = false;
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
        state.restarting = false;
        state.items = action.payload;
        if (!state.selectedKey && action.payload.length) state.selectedKey = action.payload[0].key;
      })
      .addCase(fetchExperiments.rejected, (state, action) => {
        state.loading = false;
        state.restarting = false; // the api never came back — show the error, not a spinner
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

export const {
  selectExperiment,
  hydrateAssignments,
  significancePushed,
  statsStreamClosed,
  resetState,
  backendRestartStarted,
} = slice.actions;
export default slice.reducer;
