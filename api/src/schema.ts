// GraphQL schema (SDL) — the contract between the Next.js frontend and this API.
//
// GraphQL is a required skill for this role. The key idea: the client asks for
// exactly the fields it needs in a single request, and this typed schema documents
// every operation. Compare to REST, where you'd hit /experiments, /assignments,
// /results as separate endpoints with fixed response shapes.
export const typeDefs = /* GraphQL */ `
  scalar DateTime
  scalar JSON

  enum ExperimentStatus {
    DRAFT
    RUNNING
    PAUSED
    COMPLETED
  }

  type Variant {
    id: ID!
    key: String!
    name: String!
    weight: Int!
    isControl: Boolean!
  }

  type Experiment {
    id: ID!
    key: String!
    name: String!
    description: String
    status: ExperimentStatus!
    variants: [Variant!]!
    createdAt: DateTime!
  }

  type Assignment {
    experimentKey: String!
    userId: String!
    variantKey: String!
    cached: Boolean! # true if this lookup was served from Redis
  }

  # Aggregated results, computed from the event log in MongoDB.
  type VariantResult {
    variantKey: String!
    exposures: Int!
    conversions: Int!
    conversionRate: Float! # conversions / exposures, 0 when no exposures
  }

  type ExperimentResults {
    experimentKey: String!
    variants: [VariantResult!]!
  }

  input VariantInput {
    key: String!
    name: String!
    weight: Int! = 50
    isControl: Boolean! = false
  }

  input CreateExperimentInput {
    key: String!
    name: String!
    description: String
    variants: [VariantInput!]!
  }

  type Query {
    experiments: [Experiment!]!
    experiment(key: String!): Experiment
    # Look up (or lazily create) a user's sticky assignment for an experiment.
    assignment(experimentKey: String!, userId: String!): Assignment
    # Aggregate exposures/conversions per variant from the event log.
    results(experimentKey: String!): ExperimentResults!
  }

  type Mutation {
    createExperiment(input: CreateExperimentInput!): Experiment!
    setExperimentStatus(key: String!, status: ExperimentStatus!): Experiment!
    # Bucket a user, persist the sticky assignment, log an exposure event.
    # If variantKey is provided, force the user into that variant (manual override)
    # instead of deterministic bucketing.
    assignUser(experimentKey: String!, userId: String!, variantKey: String): Assignment!
    # Record a conversion (or arbitrary) event for a user in an experiment.
    logEvent(
      experimentKey: String!
      userId: String!
      type: String! = "conversion"
      metadata: JSON
    ): Boolean!
    # Remove ALL enrollments for an experiment: sticky assignments (Postgres),
    # cached assignments (Redis), and exposure/conversion events (Mongo).
    clearEnrollments(experimentKey: String!): Boolean!
  }
`;
