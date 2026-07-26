// The Redux store — combines reducers and gives us typed hooks.
import { configureStore } from "@reduxjs/toolkit";
import { useDispatch, useSelector, TypedUseSelectorHook } from "react-redux";
import experiments, { AssignedUser } from "./experimentsSlice";

export const store = configureStore({
  reducer: { experiments },
});

// --- persist the enrolled-user board across reloads (localStorage) ---
const PERSIST_KEY = "exp_board_v1";

export function loadPersistedAssignments(): AssignedUser[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(PERSIST_KEY) || "[]");
  } catch {
    return [];
  }
}

if (typeof window !== "undefined") {
  store.subscribe(() => {
    try {
      localStorage.setItem(PERSIST_KEY, JSON.stringify(store.getState().experiments.assignments));
    } catch {
      /* storage full / disabled — ignore */
    }
  });
}

// Types inferred from the store itself — no manual maintenance.
export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;

// Pre-typed hooks so components get autocomplete + type-safety for free.
export const useAppDispatch = () => useDispatch<AppDispatch>();
export const useAppSelector: TypedUseSelectorHook<RootState> = useSelector;
