"use client";
// The right-hand "Ask Claude" advisor pane: streams a Claude answer (Bedrock) about the SELECTED
// experiment. The shared, stateless agent gets everything it needs from `context` — no per-session
// backend access. Also drives the tour's auto-typed question + ask-input tip.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useChat } from "@ai-sdk/react";
import { useAppDispatch, useAppSelector } from "@/store";
import { setClaudeOpen, setTourStep } from "@/store/uiSlice";
import { agentChatUrl } from "@/lib/session";
import { AssignedUser, Experiment, Significance } from "@/store/experimentsSlice";
import { CoachTip } from "../tour";

// Compact context sent to the advisor: exactly the numbers shown in the results table (live stats
// when the Python service has pushed them, else the local enrolled-board counts). The LLM reasons
// over this and nothing else.
type AdvisorContext = {
  key: string;
  name: string;
  status: string;
  variants: {
    name: string;
    isControl: boolean;
    exposures: number;
    conversions: number;
    rate: number;
    lift: number | null;
    pValue: number | null;
    significant: boolean;
  }[];
};

function buildAdvisorContext(
  experiment: Experiment,
  users: AssignedUser[],
  pushed: Significance | undefined,
): AdvisorContext {
  const control = experiment.variants.find((v) => v.isControl) ?? experiment.variants[0];
  const byKey = new Map((pushed?.variants ?? []).map((v) => [v.variantKey, v]));
  return {
    key: experiment.key,
    name: experiment.name,
    status: experiment.status,
    variants: experiment.variants.map((v) => {
      const stat = byKey.get(v.key);
      const inV = users.filter((u) => u.variantKey === v.key);
      const exposures = stat ? stat.exposures : inV.length;
      const conversions = stat ? stat.conversions : inV.filter((u) => u.converted).length;
      return {
        name: v.name,
        isControl: v.key === control?.key,
        exposures,
        conversions,
        rate: exposures ? Number((conversions / exposures).toFixed(3)) : 0,
        lift: stat ? Number((stat.liftPct / 100).toFixed(3)) : null,
        pValue: stat ? stat.pValue : null,
        significant: stat ? stat.significant : false,
      };
    }),
  };
}

// Minimal markdown: render **bold** spans. Newlines are preserved via white-space: pre-wrap.
function renderMd(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") ? (
      <strong key={i}>{part.slice(2, -2)}</strong>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

export default function Claude({ selectedKey }: { selectedKey: string | null }) {
  const dispatch = useAppDispatch();
  const tourStep = useAppSelector((s) => s.ui.tourStep);
  const experiment = useAppSelector(
    (s) => s.experiments.items.find((e) => e.key === selectedKey) ?? null,
  );
  const users = useAppSelector((s) =>
    s.experiments.assignments.filter((a) => a.experimentKey === selectedKey),
  );
  const pushed = useAppSelector((s) =>
    selectedKey ? s.experiments.significanceByKey[selectedKey] : undefined,
  );

  const { messages, input, setInput, handleInputChange, handleSubmit, status } = useChat({
    api: agentChatUrl(),
    streamProtocol: "text",
  });
  const logRef = useRef<HTMLDivElement>(null);
  // Keep the newest exchange in view: the log is bottom-anchored, so the input sits right under
  // the last answer and older messages spill off the top. Always jump to the bottom on a freshly
  // asked question; while an answer streams, only follow if the reader is already near the bottom
  // (so scrolling up to read history isn't yanked back down).
  useEffect(() => {
    const log = logRef.current;
    if (!log) return;
    const last = messages[messages.length - 1];
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    if (last?.role === "user" || nearBottom) log.scrollTop = log.scrollHeight;
  }, [messages]);

  // Auto-grow the textarea to its content so the whole question is always visible.
  const taRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const ta = taRef.current;
    if (ta) {
      ta.style.height = "auto";
      ta.style.height = `${ta.scrollHeight}px`;
    }
  }, [input]);

  // Tour step 10 (the ask-input tip): after a short beat, type a sample question one character at
  // a time, as if the visitor were typing it — then they click Ask themselves. setInput is read
  // through a ref so a new identity each render can't restart the typewriter mid-word.
  const setInputRef = useRef(setInput);
  setInputRef.current = setInput;
  const autoTypedRef = useRef(false);
  useEffect(() => {
    if (tourStep !== 12 || autoTypedRef.current) return;
    autoTypedRef.current = true;
    const text = "Is this experiment ready for production?";
    let i = 0;
    let typer: ReturnType<typeof setInterval> | undefined;
    const start = setTimeout(() => {
      typer = setInterval(() => {
        i += 1;
        setInputRef.current(text.slice(0, i));
        if (i >= text.length && typer) clearInterval(typer);
      }, 45);
    }, 500);
    return () => {
      clearTimeout(start);
      if (typer) clearInterval(typer);
    };
  }, [tourStep]);

  // Tour: once the visitor sends the question and Claude finishes answering (an assistant message
  // exists and the stream has settled), wait 3s so they can read the reply, then reveal the final
  // Launch tip.
  useEffect(() => {
    if (
      tourStep === 12 &&
      status === "ready" &&
      messages.some((m) => m.role === "assistant")
    ) {
      const t = setTimeout(() => dispatch(setTourStep(13)), 3000);
      return () => clearTimeout(t);
    }
  }, [tourStep, status, messages, dispatch]);

  // Tour: dismiss the ask-input tip the instant they click Ask (don't wait for Claude to finish).
  const [asked, setAsked] = useState(false);

  // Tour: pin the ask-input tip to the textarea's upper-left corner. The pane is a draggable width
  // and clips its overflow, so the tip is position:fixed (escaping the clip) and its bottom-right
  // is anchored just off the input's top-left via measured viewport offsets. Re-measure as the
  // textarea grows (auto-type) or the window resizes.
  const [tipPos, setTipPos] = useState<{ right: number; bottom: number } | null>(null);
  useEffect(() => {
    if (tourStep !== 12) {
      setTipPos(null);
      return;
    }
    const measure = () => {
      const ta = taRef.current;
      if (!ta) return;
      const r = ta.getBoundingClientRect();
      setTipPos({ right: window.innerWidth - r.left + 8, bottom: window.innerHeight - r.top + 8 });
    };
    measure();
    const t = setTimeout(measure, 220); // after the pane's open/width transition settles
    window.addEventListener("resize", measure);
    return () => {
      clearTimeout(t);
      window.removeEventListener("resize", measure);
    };
  }, [tourStep, input, messages]);

  if (!experiment) return null;
  const busy = status === "submitted" || status === "streaming";
  const context = buildAdvisorContext(experiment, users, pushed);
  const last = messages[messages.length - 1];

  return (
    <div className="advisor">
      <div className="advisor-head">
        <h2>Ask Claude…</h2>
        <button
          type="button"
          className="advisor-collapse"
          onClick={() => dispatch(setClaudeOpen(false))}
          title="Collapse"
          aria-label="Collapse Claude"
        >
          ›
        </button>
      </div>
      <div className="advisor-log" ref={logRef} aria-live="polite">
        {messages.length === 0 ? (
          <p className="muted small">
            Ask about the variants, buckets, or stats — or whether it&apos;s safe to launch.
          </p>
        ) : (
          messages.map((m) => (
            <div key={m.id} className={`advisor-msg ${m.role}`}>
              {m.role === "assistant" ? renderMd(m.content) : m.content}
            </div>
          ))
        )}
        {busy && last?.role !== "assistant" && (
          <div className="advisor-msg assistant">
            <span className="spinner" aria-hidden="true" /> thinking…
          </div>
        )}
      </div>
      <div className="tour-anchor advisor-form-anchor">
        <form
          className="advisor-form"
          onSubmit={(e) => {
            if (tourStep === 12) setAsked(true); // tour: drop the tip the moment they send
            handleSubmit(e, { body: { context } });
          }}
        >
          <textarea
            value={input}
            onChange={handleInputChange}
            onKeyDown={(e) => {
              // Enter sends; Shift+Enter inserts a newline.
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (input.trim() && !busy) {
                  if (tourStep === 12) setAsked(true);
                  handleSubmit(e, { body: { context } });
                }
              }
            }}
            ref={taRef}
            placeholder="Should I launch to production?"
            rows={1}
            disabled={busy}
          />
          <button type="submit" className="primary" disabled={busy || !input.trim()}>
            Ask
          </button>
        </form>
        {tourStep === 12 && !asked && (
          <CoachTip
            n={11}
            placement="input-fixed"
            onClose={() => dispatch(setTourStep(0))}
            style={
              tipPos
                ? { right: tipPos.right, bottom: tipPos.bottom, left: "auto", top: "auto" }
                : undefined
            }
          >
            Ask any question you want, then click <strong>Ask</strong>.
          </CoachTip>
        )}
      </div>
    </div>
  );
}
