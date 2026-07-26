// Seed script — creates the sample experiments only (no simulated traffic).
//
// Run with: npm run seed   (after `npm run prisma:push`)
//
// Experiments start in DRAFT with zero enrolled customers. Use the dashboard to
// enroll/seed customers and launch experiments to production.
import { prisma } from "../src/db/prisma.js";
import { connectMongo, events } from "../src/db/mongo.js";

// Sample experiments — company-agnostic.
const EXPERIMENTS = [
  {
    key: "plan_upgrade_banner",
    name: "Plan Upgrade Banner",
    description: "Test a promo banner encouraging customers to upgrade their plan.",
    variants: [
      { key: "control", name: "No banner", weight: 50, isControl: true },
      { key: "treatment", name: "Upgrade banner", weight: 50, isControl: false },
    ],
  },
  {
    key: "checkout_button_color",
    name: "Checkout Button Color",
    description: "Blue vs. green vs. orange primary call-to-action on the checkout page.",
    variants: [
      { key: "blue", name: "Blue button", weight: 34, isControl: true },
      { key: "green", name: "Green button", weight: 33, isControl: false },
      { key: "orange", name: "Orange button", weight: 33, isControl: false },
    ],
  },
  {
    key: "onboarding_checklist",
    name: "Onboarding Checklist",
    description: "Does a guided checklist improve new-customer activation vs. the current onboarding?",
    variants: [
      { key: "control", name: "Current onboarding", weight: 50, isControl: true },
      { key: "treatment", name: "Guided checklist", weight: 50, isControl: false },
    ],
  },
];

async function main() {
  await connectMongo();

  // Clean slate — remove any prior experiments, assignments, and events.
  await prisma.assignment.deleteMany();
  await prisma.variant.deleteMany();
  await prisma.experiment.deleteMany();
  await events().deleteMany({});

  for (const exp of EXPERIMENTS) {
    const created = await prisma.experiment.create({
      data: {
        key: exp.key,
        name: exp.name,
        description: exp.description,
        status: "DRAFT",
        variants: { create: exp.variants },
      },
    });
    console.log(`Created experiment: ${created.key} (DRAFT)`);
  }

  console.log("\nSeed complete — experiments created in DRAFT with no enrolled customers.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
