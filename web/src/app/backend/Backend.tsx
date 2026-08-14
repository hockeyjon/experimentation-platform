"use client";
// The Backend tab: a sub-tab bar over two panels — Logging (the live log stream) and Micro-services
// (the running containers). Both panels stay mounted (hidden, not unmounted) so the log WebSocket
// in StreamLogs survives sub-tab switches. Owns which sub-tab is showing.
import { useEffect, useState } from "react";
import { useAppSelector } from "@/store";
import StreamLogs from "./StreamLogs";
import Microservices from "./Microservices";

type SubTab = "logging" | "services";

export default function Backend() {
  const active = useAppSelector((s) => s.ui.tab === "backend");
  const tourStep = useAppSelector((s) => s.ui.tourStep);
  const [subTab, setSubTab] = useState<SubTab>("logging");

  // Tour finale: land on the Logging sub-tab so the completion modal reveals the live stream.
  useEffect(() => {
    if (tourStep === 15) setSubTab("logging");
  }, [tourStep]);

  return (
    <div className="backend-logs" style={{ display: active ? "flex" : "none" }}>
      <div className="subtabbar">
        <button
          className={`subtab ${subTab === "logging" ? "active" : ""}`}
          onClick={() => setSubTab("logging")}
        >
          Logging
        </button>
        <button
          className={`subtab ${subTab === "services" ? "active" : ""}`}
          onClick={() => setSubTab("services")}
        >
          Micro-services
        </button>
      </div>

      {/* Both panels stay mounted — hiding rather than unmounting keeps the log
          WebSocket alive while you look at the micro-services panel. */}
      <StreamLogs active={active} subTab={subTab} setSubTab={setSubTab} />
      <Microservices subTab={subTab} />
    </div>
  );
}
