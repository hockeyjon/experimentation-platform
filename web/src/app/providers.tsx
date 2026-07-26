"use client";
// Redux's <Provider> must run on the client. In the Next.js App Router, we isolate
// it in this small "use client" component and wrap the app with it in layout.tsx.
import { Provider } from "react-redux";
import { store } from "@/store";

export function Providers({ children }: { children: React.ReactNode }) {
  return <Provider store={store}>{children}</Provider>;
}
