"use client";
// About → Claude: the project blurb + the Phase 0–3 story panels (the human/AI collaboration arc).
// Currently not wired to any button — kept for when we want to surface the collaboration story
// again. The About button shows AboutStack (the architecture diagram) instead.
import { useId } from "react";

export default function AboutClaude({ onDismiss }: { onDismiss: () => void }) {
  const titleId = useId();

  return (
    <div className="modal-backdrop">
      <div
        className="modal about-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <h3 id={titleId}>About this project</h3>
        <p>
          A working, full-stack A/B experimentation platform, built to mirror a production stack:
          Next.js + Redux on the frontend, a GraphQL/Prisma API over Postgres, MongoDB, and Redis, a
          Python significance service, all on Kubernetes (k3s) behind Caddy on AWS. It came together
          as a pair-programming exercise with Claude — the four phases below trace how it was built,
          and how my role evolved from observer to collaborator.
        </p>
        <PhasePanels />
        <div className="modal-actions">
          <button className="primary" onClick={onDismiss}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

// The Phase 0 → 3 story cards, shown in the About overlay — the human/AI collaboration arc, in
// the builder's own voice.
function PhasePanels() {
  return (
    <div className="phase-cards">
      <section className="phase-card done">
        <h4>Phase 0 — The Big Bang</h4>
        <div className="phase-status">✓ Complete</div>
        <p>
          The initial big bang: I handed Claude the spec and it stood up the entire stack and a
          minimalist frontend in one shot. That first UI was sparse and unintuitive — just the
          Simulate / Create&nbsp;Users card with no error checking, a slimmer variant-stats table,
          and only one button in the whole app: <strong>Create User</strong>.
        </p>
      </section>

      <section className="phase-card done">
        <h4>Phase 1 — The Micro-Manager</h4>
        <div className="phase-status">✓ Complete</div>
        <p>
          I shifted from learner and observer to micro-manager of our pair-programming exercise —
          owning the code and the UX, iterating in small steps, asking questions and making updates
          until I understood the whole stack, and steadily guiding Claude toward a far more intuitive
          user experience.
        </p>
        <div className="phase-stack">
          <code>Next.js · Redux</code>
          <code>GraphQL · Prisma</code>
          <code>Postgres</code>
          <code>MongoDB</code>
          <code>Redis</code>
          <code>Python/FastAPI</code>
          <code>k3s</code>
          <code>AWS</code>
          <code>EC2</code>
          <code>S3</code>
          <code>CloudFront</code>
        </div>
      </section>

      <section className="phase-card done">
        <h4>Phase 2 — Full Collaboration</h4>
        <div className="phase-status">✓ Complete</div>
        <p>
          A true collaboration between Claude and me: we worked together to get Kubernetes running
          quickly and smoothly, with a <strong>FIFO queue</strong> that lines up waiting visitors and
          hands each one an isolated namespace session the moment a slot frees. We developed the new
          Phase 2 stack on a parallel AWS dev environment, then cut production over by swapping the
          Elastic IP onto the Kubernetes box (same IP, zero DNS wait).
        </p>
        <div className="phase-stack">
          <code>Namespace per session</code>
          <code>FIFO queue + warm pool</code>
          <code>ResourceQuota</code>
          <code>NetworkPolicy</code>
          <code>Provisioner API</code>
          <code>k3s</code>
        </div>
      </section>

      <section className="phase-card done">
        <h4>Phase 3 — Claude in the Product</h4>
        <div className="phase-status">✓ Complete</div>
        <p>
          Having built the platform <strong>with</strong> Claude, this phase puts Claude{" "}
          <strong>inside</strong> it: an <strong>Ask Claude</strong> advisor that reasons over the
          selected experiment&apos;s variants, buckets, and live stats and gives an honest read on
          whether it&apos;s safe to launch — it never claims significance the numbers don&apos;t
          support. A shared, stateless FastAPI + LangGraph agent calls Amazon Bedrock (Claude Haiku)
          through the EC2 instance role via IMDS, and streams the answer to the browser with the
          Vercel AI SDK.
        </p>
        <div className="phase-stack">
          <code>LangChain</code>
          <code>LangGraph</code>
          <code>Amazon Bedrock</code>
          <code>Claude Haiku</code>
          <code>Vercel AI SDK</code>
          <code>FastAPI</code>
          <code>IAM instance role · IMDS</code>
        </div>
      </section>
    </div>
  );
}
