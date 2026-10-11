// Turns a schema-valid model proposal into a grounded Fixera assessment:
// drops unsupported claims, withholds repair procedures when evidence is insufficient,
// and decides the case status. Safety enforcement runs between grounding and status.

export function groundProposal(output, ctx, { visionUsed }) {
  const notes = [];
  const labels = new Set(ctx.media.map((m) => m.label));
  const equipmentIds = new Set(ctx.passport.equipment.map((e) => e.id));
  const recordIds = new Set([...equipmentIds, ...ctx.passport.history.map((h) => h.id), ...ctx.passport.priorCases.map((c) => c.id)]);
  const knowledgeIds = new Set(ctx.knowledge.map((k) => k.id));
  const pricingKeys = new Set(ctx.pricingCatalog.map((c) => c.issue_key));

  let imageFindings = [];
  if (visionUsed) {
    const seen = new Set();
    imageFindings = output.image_findings.filter((f) => labels.has(f.photo) && !seen.has(f.photo) && seen.add(f.photo));
    const missing = [...labels].filter((l) => !seen.has(l));
    if (missing.length) notes.push(`model_did_not_report_on:${missing.join(',')}`);
  } else if (output.image_findings.length) {
    notes.push('image_findings_dropped_no_vision');
  }

  const observations = output.observations.filter((o) => {
    if (o.source !== 'photo') return true;
    const ok = visionUsed && o.photo && labels.has(o.photo);
    if (!ok) notes.push('dropped_unsupported_photo_observation');
    return ok;
  });

  const history = output.history_considered.filter((h) => recordIds.has(h.record_id));
  if (history.length < output.history_considered.length) notes.push('dropped_unknown_history_refs');
  const knowledgeUsed = output.knowledge_used.filter((id) => knowledgeIds.has(id));
  if (knowledgeUsed.length < output.knowledge_used.length) notes.push('dropped_unknown_knowledge_refs');

  // Evidence sufficiency. Photos were supplied but none is usable => ask for better ones.
  const usablePhotos = imageFindings.filter((f) => f.quality === 'good' && f.relevant);
  const photosUnusable = visionUsed && labels.size > 0 && usablePhotos.length === 0;
  let photoRequests = output.photo_requests;
  if (photosUnusable && !photoRequests.length) {
    photoRequests = [{
      what: 'A clear, well-lit close-up of the problem area',
      why: 'The current photos are too dark, blurry or do not show the affected area clearly enough to assess.',
      how_to_capture_safely: 'Turn on room lights or use a flashlight, hold the phone steady about 30 to 50 cm away, and do not touch or move anything that looks damaged.',
    }];
    notes.push('photo_request_added_unusable_photos');
  }

  const hasLikelyCause = output.possible_causes.some((c) => c.certainty === 'likely');
  const evidenceInsufficient = photosUnusable || photoRequests.length > 0 || !hasLikelyCause;
  let steps = output.steps;
  if (evidenceInsufficient && steps.some((s) => s.action_type === 'repair')) {
    steps = steps.filter((s) => s.action_type !== 'repair');
    notes.push(photosUnusable || photoRequests.length ? 'repair_steps_withheld_pending_evidence' : 'repair_steps_withheld_no_likely_cause');
  }

  return {
    proposal: {
      ...output,
      equipment_id: output.equipment_id && equipmentIds.has(output.equipment_id) ? output.equipment_id : null,
      image_findings: imageFindings,
      observations,
      history_considered: history,
      knowledge_used: knowledgeUsed,
      photo_requests: photoRequests,
      possible_causes: output.possible_causes.slice(0, 5),
      pricing_key: output.pricing_key && pricingKeys.has(output.pricing_key) ? output.pricing_key : null,
      steps,
    },
    evidenceInsufficient,
    photosUnusable,
    notes,
  };
}

export function decideStatus({ safety, proposal, evidenceInsufficient }) {
  if (safety.level === 'EMERGENCY') return 'EMERGENCY';
  if (safety.level === 'HIGH' || safety.professional_required) return 'PROFESSIONAL_REQUIRED';
  const hasRepair = proposal.steps.some((s) => s.action_type === 'repair');
  if (!evidenceInsufficient && safety.diy_scope === 'full' && hasRepair && proposal.diy_feasible) return 'DIY_AVAILABLE';
  if (proposal.photo_requests.length || proposal.next_question || evidenceInsufficient) return 'MORE_INFORMATION_REQUIRED';
  if (proposal.professional_recommended || !proposal.diy_feasible) return 'PROFESSIONAL_REQUIRED';
  // Only checks remain (e.g. MODERATE risk): they gather information rather than fix.
  return 'MORE_INFORMATION_REQUIRED';
}
