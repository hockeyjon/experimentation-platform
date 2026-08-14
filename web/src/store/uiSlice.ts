// Cross-cutting UI state — the bits that several components across both tabs read and write:
// which tab is active, how far along the guided tour is, and whether the Claude pane is open.
// Kept in Redux (rather than prop-drilled from the Dashboard) so each component can self-serve it.
import { createSlice, PayloadAction } from "@reduxjs/toolkit";

export type Tab = "frontend" | "backend";

type UIState = {
  tab: Tab;
  tourStep: number; // 0 = tour not running; each step drives one coach-tip (see tour.tsx)
  claudeOpen: boolean; // the right-hand "Ask Claude" pane
};

const initialState: UIState = {
  tab: "frontend",
  tourStep: 0,
  claudeOpen: false,
};

const uiSlice = createSlice({
  name: "ui",
  initialState,
  reducers: {
    setTab(state, action: PayloadAction<Tab>) {
      state.tab = action.payload;
    },
    setTourStep(state, action: PayloadAction<number>) {
      state.tourStep = action.payload;
    },
    setClaudeOpen(state, action: PayloadAction<boolean>) {
      state.claudeOpen = action.payload;
    },
    toggleClaudeOpen(state) {
      state.claudeOpen = !state.claudeOpen;
    },
  },
});

export const { setTab, setTourStep, setClaudeOpen, toggleClaudeOpen } = uiSlice.actions;
export default uiSlice.reducer;
