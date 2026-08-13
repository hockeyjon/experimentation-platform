"use client";
// About → Stack: an architecture diagram of the full stack and where it runs on AWS. Shown from
// the title-bar About button. Closes ONLY via the Close button — no backdrop-click or Escape, so
// it can't be dismissed accidentally. The diagram is pure CSS-styled boxes — top (the browser) to
// bottom (Bedrock) traces one request's path down the stack.
import { useId } from "react";

export default function AboutStack({ onDismiss }: { onDismiss: () => void }) {
  const titleId = useId();

  return (
    <div className="modal-backdrop">
      <div
        className="modal about-modal about-stack-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <h3 id={titleId}>The stack</h3>
        <p>
          A full-stack A/B experimentation platform on AWS. The diagram traces one request from the
          browser down through the CDN, the Caddy edge, a per-visitor Kubernetes session, and out to
          Amazon Bedrock — each visitor gets their own isolated namespace stack.
        </p>

        <StackDiagram />

        <div className="modal-actions">
          <button className="primary" onClick={onDismiss}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

// A tech pill row — reuses the .phase-stack code chip styling from the other overlays.
function Chips({ items }: { items: string[] }) {
  return (
    <div className="phase-stack">
      {items.map((t) => (
        <code key={t}>{t}</code>
      ))}
    </div>
  );
}

function StackDiagram() {
  return (
    <div className="stack-diagram">
      {/* Frontend boundary — mirrors the AWS boundary below, in blue. */}
      <div className="stack-frontend">
        <span className="stack-frontend-badge">Frontend</span>
        <div className="stack-node stack-client">
          <span className="stack-label">Client · Browser</span>
          <div className="stack-title">Static single-page app</div>
          <Chips items={["Next.js", "React", "Redux Toolkit", "TypeScript", "Vercel AI SDK"]} />
        </div>
      </div>

      <div className="stack-flow">HTTPS ▼</div>

      {/* AWS boundary */}
      <div className="stack-aws">
        <span className="stack-aws-badge">Backend - AWS</span>

        {/* Edge delivery */}
        <div className="stack-node stack-edge">
          <span className="stack-label">Delivery</span>
          <div className="stack-title">CloudFront CDN → S3 static site</div>
          <Chips items={["CloudFront", "S3", "ACM (TLS)", "Route 53"]} />
        </div>

        <div className="stack-flow">▼</div>

        {/* EC2 host */}
        <div className="stack-group stack-ec2">
          <span className="stack-group-label">EC2 · Elastic IP</span>

          <div className="stack-node stack-caddy">
            <span className="stack-label">Edge proxy</span>
            <div className="stack-title">Caddy — auto-TLS, path routing</div>
            <div className="stack-note">/s/&lt;id&gt;/… per session · /provision · /agent</div>
          </div>

          {/* k3s cluster */}
          <div className="stack-group stack-k3s">
            <span className="stack-group-label">k3s · Kubernetes</span>

            <div className="stack-node stack-provisioner">
              <span className="stack-label">Control plane</span>
              <div className="stack-title">Provisioner</div>
              <div className="stack-note">
                spins a namespace per visitor · FIFO queue · warm pool · idle reaper
              </div>
            </div>

            {/* Per-session namespace */}
            <div className="stack-group stack-session">
              <span className="stack-group-label">Per-session namespace (one per visitor)</span>
              <div className="stack-node stack-services">
                <span className="stack-label">Services</span>
                <Chips items={["GraphQL API — Node · Apollo · Prisma", "Stats — Python · FastAPI", "Logstream"]} />
              </div>
              <div className="stack-node stack-datastores">
                <span className="stack-label">Datastores</span>
                <Chips items={["PostgreSQL", "MongoDB", "Redis"]} />
              </div>
            </div>

            <div className="stack-node stack-agent">
              <span className="stack-label">Shared advisor</span>
              <div className="stack-title">Agent — “Ask Claude”</div>
              <Chips items={["Python", "FastAPI", "LangGraph", "LangChain"]} />
            </div>
          </div>
        </div>

        <div className="stack-flow">IAM instance role via IMDS ▼</div>

        {/* Bedrock */}
        <div className="stack-node stack-bedrock">
          <span className="stack-label">Managed AI</span>
          <div className="stack-title">Amazon Bedrock — Claude Haiku</div>
          <div className="stack-note">no API key · data stays in AWS</div>
        </div>
      </div>
    </div>
  );
}
