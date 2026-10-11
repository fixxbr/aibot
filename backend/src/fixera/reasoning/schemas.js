// Typed contract between Fixera and any model provider.
// The model returns ModelAssessment; Fixera validates it, enforces safety, prices it and
// stores a FixeraAssessment. Every field is required (nullable where optional) so the same
// schema works with strict structured-output modes on Anthropic, OpenAI and Gemini.

import * as z from 'zod/v4';
import { MODEL_HAZARD_TYPES } from '../safety/policy.js';

export const PROMPT_VERSION = 'fixera-diagnose-2026.10.1';

const RiskLevel = z.enum(['LOW', 'MODERATE', 'HIGH', 'EMERGENCY']);

export const ModelAssessment = z.strictObject({
  reply_to_homeowner: z.string().describe('Plain-language message to the homeowner for this turn. Conversational, no markdown headings.'),
  problem_summary: z.string().describe('One-line summary of the reported problem.'),
  equipment: z.string().nullable().describe('Equipment or system involved, e.g. "Sink drain assembly".'),
  equipment_id: z.string().nullable().describe('ID of the matching Property Passport equipment record, or null if none matches.'),
  image_findings: z
    .array(
      z.strictObject({
        photo: z.string().describe('Photo label exactly as given, e.g. "photo_1".'),
        quality: z.enum(['good', 'poor', 'unusable']),
        quality_issue: z.string().nullable().describe('What is wrong with the photo if not good: dark, blurry, too far, wrong area.'),
        shows: z.string().describe('What the photo actually shows, literally.'),
        relevant: z.boolean(),
      }),
    )
    .describe('One entry per photo provided. Empty if no photos were provided.'),
  observations: z
    .array(
      z.strictObject({
        description: z.string().describe('A fact, not a conclusion.'),
        source: z.enum(['photo', 'homeowner', 'property_history']),
        photo: z.string().nullable().describe('Photo label when source is photo.'),
      }),
    )
    .describe('What is actually visible or reported. Never include inferences here.'),
  possible_causes: z
    .array(
      z.strictObject({
        name: z.string(),
        certainty: z.enum(['likely', 'possible', 'unlikely']),
        rationale: z.string().describe('Which observations support or weaken this cause.'),
      }),
    )
    .describe('Ranked most to least plausible. Never certain.'),
  history_considered: z
    .array(z.strictObject({ record_id: z.string(), relevance: z.string() }))
    .describe('Property Passport records that influenced the assessment, by ID.'),
  knowledge_used: z.array(z.string()).describe('IDs of knowledge passages used.'),
  missing_information: z.array(z.string()),
  photo_requests: z
    .array(z.strictObject({ what: z.string(), why: z.string(), how_to_capture_safely: z.string() }))
    .describe('Specific additional photos needed. Empty if none.'),
  next_question: z.string().nullable().describe('The single most useful question to ask next, or null.'),
  hazards_detected: z.array(z.strictObject({ type: z.enum(MODEL_HAZARD_TYPES), description: z.string() })),
  proposed_risk_level: RiskLevel,
  diy_feasible: z.boolean(),
  difficulty: z.enum(['easy', 'easy_moderate', 'moderate', 'hard']).nullable(),
  estimated_minutes: z.strictObject({ min: z.number(), max: z.number() }).nullable(),
  tools: z.array(z.strictObject({ name: z.string(), spec: z.string().nullable() })),
  parts: z.array(
    z.strictObject({
      name: z.string(),
      spec: z.string().nullable().describe('Size, rating or model compatibility, only if verified from evidence.'),
      compatibility_verified: z.boolean(),
    }),
  ),
  preparation: z.array(z.string()),
  steps: z
    .array(
      z.strictObject({
        action_type: z.enum(['observe', 'safe_check', 'repair', 'verify']),
        title: z.string(),
        instruction: z.string(),
        caution: z.string().nullable(),
        stop_condition: z.string().nullable().describe('When the homeowner must stop and get help.'),
        verification: z.string().nullable().describe('How the homeowner knows this step worked.'),
      }),
    )
    .describe('Ordered, one action per step, written for a non-expert.'),
  escalation_signs: z.array(z.string()),
  pricing_key: z.string().nullable().describe('Best matching pricing catalog key, or null.'),
  professional_recommended: z.boolean(),
});

export const modelAssessmentJsonSchema = () => z.toJSONSchema(ModelAssessment, { target: 'draft-7' });
