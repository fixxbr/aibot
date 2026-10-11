// Deterministic safety enforcement. The model may propose; this module decides.

import {
  ALLOWED_ACTIONS_BY_RISK,
  ALLOWED_OVERRIDES,
  CATEGORY_MIN_RISK,
  HAZARD_RULES,
  MODEL_HAZARD_TO_RULE,
  POLICY_VERSION,
  PROHIBITED_ACTIONS,
  RISK_ORDER,
  SAFETY_GUIDANCE,
} from './policy.js';

export { POLICY_VERSION };

export const maxRisk = (...levels) =>
  levels.filter(Boolean).reduce((a, b) => (RISK_ORDER.indexOf(b) > RISK_ORDER.indexOf(a) ? b : a), 'LOW');

const atLeast = (level, min) => RISK_ORDER.indexOf(level) >= RISK_ORDER.indexOf(min);

const NEGATORS = /\b(no|not|don'?t|doesn'?t|didn'?t|never|without|isn'?t|aren'?t|wasn'?t|no sign of|no longer)\b/i;
const NEGATION_BREAKERS = /\b(but|however|though|sure|think|maybe|might|unsure|if|whether)\b/i;

// "I don't smell gas" is negated; "not sure, but I smell gas" is not. Only the three words
// directly before the match count, so a distant "no" never cancels a hazard.
function isNegated(text, index) {
  const words = text.slice(0, index).split(/\s+/).filter(Boolean).slice(-3).join(' ');
  if (NEGATION_BREAKERS.test(words)) return false;
  return NEGATORS.test(words);
}

// "Do not remove the panel cover" is a warning, not an instruction. Only the same clause
// counts: "Do not panic; remove the panel cover" is still an instruction.
function isWarningNotInstruction(text, index) {
  const clause = text.slice(0, index).split(/[.;!?\n]|\b(then|and then|next)\b/i).pop() || '';
  return /\b(do not|don'?t|never|avoid|without)\b/i.test(clause);
}

function guidanceFor(keys, level) {
  const out = [];
  for (const k of keys) for (const line of SAFETY_GUIDANCE[k] || []) if (!out.includes(line)) out.push(line);
  if (!out.length && atLeast(level, 'HIGH')) out.push(...SAFETY_GUIDANCE.default_high);
  return out;
}

function scanHazards(text, source) {
  const hits = [];
  if (!text) return hits;
  for (const rule of HAZARD_RULES) {
    for (const pattern of rule.patterns) {
      const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
      let m;
      let matched = false;
      while ((m = re.exec(text)) && !matched) {
        if (!isNegated(text, m.index)) matched = true;
        if (m[0].length === 0) re.lastIndex++;
      }
      if (matched) {
        hits.push({ rule_id: rule.id, level: rule.level, source, guidance: rule.guidance });
        break;
      }
    }
  }
  return hits;
}

/**
 * Stage 2 of the pipeline: screen homeowner input before any model call.
 * `texts` is every homeowner-authored string relevant to this turn (description + messages).
 */
export function prescreen({ texts, category }) {
  const hazards = texts.flatMap((t) => scanHazards(t, 'homeowner_text'));
  const level = maxRisk(...hazards.map((h) => h.level), CATEGORY_MIN_RISK[category]);
  return {
    level,
    hazards: dedupeHazards(hazards),
    emergency: level === 'EMERGENCY',
    guidance: guidanceFor(hazards.map((h) => h.guidance).filter(Boolean), level),
    policy_version: POLICY_VERSION,
  };
}

function dedupeHazards(hazards) {
  const seen = new Map();
  for (const h of hazards) if (!seen.has(h.rule_id)) seen.set(h.rule_id, h);
  return [...seen.values()];
}

/** Returns the prohibited-action rule IDs matched by `text`, ignoring "do not X" warnings. */
export function prohibitedMatches(text, { allowOverrides = true } = {}) {
  if (!text) return [];
  if (allowOverrides && ALLOWED_OVERRIDES.some((re) => re.test(text))) return [];
  const ids = [];
  for (const rule of PROHIBITED_ACTIONS) {
    const re = new RegExp(rule.pattern.source, rule.pattern.flags.includes('g') ? rule.pattern.flags : rule.pattern.flags + 'g');
    let m;
    while ((m = re.exec(text))) {
      if (!isWarningNotInstruction(text, m.index)) {
        ids.push(rule.id);
        break;
      }
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  return ids;
}

/**
 * Stage 8: enforce the policy on a model proposal. Returns the sanitized proposal plus the
 * safety decision. Removed content is never returned or stored, only rule IDs and counts.
 */
export function enforce({ screen, proposal, category }) {
  const modelHazards = (proposal.hazards_detected || [])
    .map((h) => {
      const ruleId = MODEL_HAZARD_TO_RULE[h.type];
      const rule = HAZARD_RULES.find((r) => r.id === ruleId);
      return rule ? { rule_id: rule.id, level: rule.level, source: 'model', guidance: rule.guidance } : null;
    })
    .filter(Boolean);
  const observationHazards = (proposal.observations || []).flatMap((o) => scanHazards(o.description, 'observation'));
  const hazards = dedupeHazards([...screen.hazards, ...modelHazards, ...observationHazards]);

  // The model can raise the risk level but never lower it below the deterministic floor.
  const level = maxRisk(screen.level, proposal.proposed_risk_level, CATEGORY_MIN_RISK[category], ...hazards.map((h) => h.level));
  const allowedActions = ALLOWED_ACTIONS_BY_RISK[level];
  const allowOverrides = !atLeast(level, 'HIGH');

  const removed = new Map();
  const note = (id) => removed.set(id, (removed.get(id) || 0) + 1);

  const keptSteps = [];
  let blockedRepair = false;
  for (const step of proposal.steps || []) {
    const text = [step.title, step.instruction, step.caution].filter(Boolean).join('. ');
    if (!allowedActions.includes(step.action_type)) {
      note(`ACTION_${step.action_type.toUpperCase()}_NOT_PERMITTED_AT_${level}`);
      continue;
    }
    // Once a repair step is blocked, later repair steps depend on it and are dropped too.
    if (blockedRepair && step.action_type === 'repair') {
      note('DEPENDS_ON_PROHIBITED_STEP');
      continue;
    }
    const hits = prohibitedMatches(text, { allowOverrides });
    if (hits.length) {
      hits.forEach(note);
      if (step.action_type === 'repair') blockedRepair = true;
      continue;
    }
    keptSteps.push(step);
  }

  const filterItems = (items) =>
    (items || []).filter((it) => {
      const hits = prohibitedMatches([it.name, it.spec].filter(Boolean).join(' '), { allowOverrides });
      hits.forEach(note);
      return hits.length === 0;
    });
  const tools = keptSteps.length ? filterItems(proposal.tools) : [];
  const parts = keptSteps.some((s) => s.action_type === 'repair') ? filterItems(proposal.parts) : [];
  const preparation = keptSteps.length ? (proposal.preparation || []).filter((p) => prohibitedMatches(p, { allowOverrides }).length === 0) : [];

  let reply = proposal.reply_to_homeowner || '';
  let replyReplaced = false;
  if (atLeast(level, 'HIGH') || prohibitedMatches(reply, { allowOverrides }).length) {
    replyReplaced = true;
  }

  const guidance = guidanceFor(hazards.map((h) => h.guidance).filter(Boolean), level);
  const hasRepair = keptSteps.some((s) => s.action_type === 'repair');
  const diyScope = atLeast(level, 'HIGH') || keptSteps.length === 0 ? 'none' : hasRepair && level === 'LOW' ? 'full' : 'checks_only';
  const professionalRequired = atLeast(level, 'HIGH') || blockedRepair;

  return {
    proposal: { ...proposal, steps: keptSteps, tools, parts, preparation, reply_to_homeowner: replyReplaced ? null : reply },
    safety: {
      level,
      diy_permitted: diyScope !== 'none',
      diy_scope: diyScope,
      professional_required: professionalRequired,
      hazards: hazards.map(({ rule_id, level: l, source }) => ({ rule_id, level: l, source })),
      guidance,
      removed_actions: [...removed.entries()].map(([rule_id, count]) => ({ rule_id, count })),
      reply_replaced: replyReplaced,
      policy_version: POLICY_VERSION,
    },
  };
}

/** Deterministic message used when the model reply is withheld or no model ran. */
export function safetyMessage(safety) {
  if (safety.level === 'EMERGENCY') {
    return ['This may be an emergency. Stop troubleshooting and follow these steps now:', ...safety.guidance.map((g, i) => `${i + 1}. ${g}`)].join('\n');
  }
  if (safety.level === 'HIGH' || safety.professional_required) {
    const lines = safety.guidance.length ? safety.guidance : SAFETY_GUIDANCE.default_high;
    return ['This issue needs a qualified professional. For your safety, Fixera will not provide repair steps for it.', ...lines.map((g, i) => `${i + 1}. ${g}`)].join('\n');
  }
  return 'I have updated your assessment. Review the details below.';
}
