// Fixera safety policy. Deterministic, versioned, and reviewed like code.
//
// Changing anything here changes what homeowners are told to do in their homes.
// Bump POLICY_VERSION, record the reason in CHANGELOG below, and add a regression test in
// test/safety.test.js for every new or modified rule.
//
// CHANGELOG
//   2026.10.1  Initial policy: hazard screening, risk levels, prohibited DIY actions.

export const POLICY_VERSION = '2026.10.1';

export const RISK_ORDER = ['LOW', 'MODERATE', 'HIGH', 'EMERGENCY'];

/**
 * Hazard rules screen homeowner text, model-reported hazards and visible observations.
 * `level` is the minimum risk level the case is raised to when the rule matches.
 */
export const HAZARD_RULES = [
  {
    id: 'GAS_LEAK',
    level: 'EMERGENCY',
    patterns: [/\b(smell(s|ing)? (of |like )?(natural )?gas|gas smell|gas odou?r|rotten[- ]eggs?|gas leak(ing)?|leaking gas|hiss(ing)? (from|near|at) (the )?gas)/i],
    guidance: 'gas',
  },
  {
    id: 'CARBON_MONOXIDE',
    level: 'EMERGENCY',
    patterns: [/\b(carbon monoxide|co (alarm|detector)s? (is |are )?(going off|sounding|beeping|alarming|went off)|co alarm)/i],
    guidance: 'co',
  },
  {
    id: 'FIRE_OR_SMOKE',
    level: 'EMERGENCY',
    patterns: [/\b(on fire|flames?|caught fire|smoke (is )?(coming|pouring)|smoking (outlet|panel|breaker|wire|appliance)|electrical fire)/i],
    guidance: 'fire',
  },
  {
    id: 'ELECTRICAL_SHOCK_INJURY',
    level: 'EMERGENCY',
    patterns: [/\b(got (electrically )?shocked|electrocut(ed|ion)|someone (was|got) shocked|shock(ed)? (me|him|her|them) (badly|hard))/i],
    guidance: 'injury',
  },
  {
    id: 'WATER_NEAR_ELECTRICAL',
    level: 'EMERGENCY',
    patterns: [
      /\b(water|flood(ing|ed)?|leak(ing)?)\b[^.]{0,60}\b(electrical panel|breaker (box|panel)|outlets?|power strip|wiring|fuse box)\b/i,
      /\b(electrical panel|breaker (box|panel)|outlets?|fuse box)\b[^.]{0,60}\b(wet|under water|flooded|submerged|dripping)\b/i,
    ],
    guidance: 'water_electric',
  },
  {
    id: 'STRUCTURAL_COLLAPSE_RISK',
    level: 'EMERGENCY',
    patterns: [/\b(ceiling (is )?(collapsing|caving|about to (fall|collapse))|(roof|floor|wall|ceiling) (collapsed|is collapsing|caved in)|bulging ceiling)/i],
    guidance: 'structural',
  },
  {
    id: 'SPARKING_OR_ARCING',
    level: 'HIGH',
    patterns: [/\b(spark(s|ing|ed)?|arcing|buzzing (outlet|panel|breaker)|burning smell|smell(s)? (like )?burning|scorch(ed|ing)|melted (outlet|plug|wire|cord))/i],
    guidance: 'electrical',
  },
  {
    id: 'EXPOSED_WIRING',
    level: 'HIGH',
    patterns: [/\b(exposed|bare|live|loose|hanging|frayed|stripped) (electrical )?(wires?|wiring|conductors?)\b/i, /\bwires? (are |is )?(exposed|hanging out|sticking out)/i],
    guidance: 'electrical',
  },
  {
    id: 'MAJOR_WATER_INTRUSION',
    level: 'HIGH',
    patterns: [/\b(burst pipe|pipe burst|water (is )?(pouring|gushing|spraying)|flood(ed|ing) (basement|room|house|kitchen|bathroom)|sewage (backup|backing up))/i],
    guidance: 'water_major',
  },
  {
    id: 'STRUCTURAL_DAMAGE',
    level: 'HIGH',
    patterns: [/\b(sagging (ceiling|roof|floor|beam)|crack(ed|ing|s)? in (the )?(foundation|beam|joist|load[- ]bearing)|foundation crack|wall (is )?(bowing|buckling|leaning)|roof (is )?sagging)/i],
    guidance: 'structural',
  },
  {
    id: 'MOLD_EXTENSIVE',
    level: 'MODERATE',
    patterns: [/\b(black mold|mold (everywhere|spreading|covering)|large area of mold)/i],
    guidance: null,
  },
  {
    id: 'ASBESTOS_OR_LEAD',
    level: 'HIGH',
    patterns: [/\b(asbestos|vermiculite insulation|popcorn ceiling.*(sand|scrape|remove)|lead paint)/i],
    guidance: null,
  },
];

// Hazard types the model may report. Mapped onto rule IDs above.
export const MODEL_HAZARD_TYPES = [
  'gas_leak',
  'carbon_monoxide',
  'fire_or_smoke',
  'electrical_shock_injury',
  'water_near_electrical',
  'structural_collapse_risk',
  'sparking_or_arcing',
  'exposed_wiring',
  'major_water_intrusion',
  'structural_damage',
  'mold',
  'hazardous_material',
  'fall_risk',
  'other',
];

export const MODEL_HAZARD_TO_RULE = {
  gas_leak: 'GAS_LEAK',
  carbon_monoxide: 'CARBON_MONOXIDE',
  fire_or_smoke: 'FIRE_OR_SMOKE',
  electrical_shock_injury: 'ELECTRICAL_SHOCK_INJURY',
  water_near_electrical: 'WATER_NEAR_ELECTRICAL',
  structural_collapse_risk: 'STRUCTURAL_COLLAPSE_RISK',
  sparking_or_arcing: 'SPARKING_OR_ARCING',
  exposed_wiring: 'EXPOSED_WIRING',
  major_water_intrusion: 'MAJOR_WATER_INTRUSION',
  structural_damage: 'STRUCTURAL_DAMAGE',
  mold: 'MOLD_EXTENSIVE',
  hazardous_material: 'ASBESTOS_OR_LEAD',
};

// Lower bound on risk per category: some trades are never below MODERATE.
export const CATEGORY_MIN_RISK = {
  electrical: 'MODERATE',
  roofing: 'MODERATE',
};

/**
 * Prohibited DIY actions. A proposed step whose text matches is removed before the
 * assessment is stored or returned. These are trade-qualified tasks or tasks with a
 * serious injury risk. A user acknowledgement or disclaimer never unlocks them.
 */
export const PROHIBITED_ACTIONS = [
  { id: 'ELEC_PANEL_OPEN', pattern: /\b(remove|open|take off|unscrew)\b[^.]{0,40}\b(panel cover|dead ?front|breaker panel|electrical panel|service panel|fuse box)/i },
  { id: 'ELEC_WIRING_WORK', pattern: /\b(rewire|re-wire|splice|strip|connect|disconnect|reconnect|cap|wire nut|pigtail)\b[^.]{0,40}\b(wires?|wiring|conductors?|hot|neutral|ground wire)/i },
  { id: 'ELEC_DEVICE_REPLACE', pattern: /\b(replace|install|swap|remove)\b[^.]{0,30}\b(outlets?|receptacles?|light switch(es)?|switch(es)?|breakers?|gfci (outlet|receptacle)|light fixture|ceiling fan)\b/i },
  { id: 'ELEC_LIVE_TEST', pattern: /\b(multimeter|voltage tester|non-contact tester|test(ing)? (for )?voltage|live circuit|while (the )?(power|circuit|breaker) is (on|live|energi[sz]ed))/i },
  { id: 'ELEC_CAPACITOR', pattern: /\bcapacitor/i },
  { id: 'GAS_LINE_WORK', pattern: /\b(gas (line|pipe|valve|fitting|connector|supply)|flex(ible)? gas)\b[^.]{0,40}\b(tighten|loosen|disconnect|reconnect|replace|repair|tape|seal|remove)|\b(tighten|loosen|disconnect|reconnect|replace|repair|seal|remove)\b[^.]{0,40}\bgas (line|pipe|valve|fitting|connector)/i },
  { id: 'GAS_PILOT_BURNER', pattern: /\b(relight|light)\b[^.]{0,20}\bpilot|\b(burner assembly|gas valve|thermocouple|flame sensor)\b[^.]{0,30}\b(remove|replace|adjust|clean)|\b(remove|replace|adjust)\b[^.]{0,30}\b(burner assembly|gas valve|thermocouple)/i },
  { id: 'REFRIGERANT', pattern: /\b(refrigerant|freon|r-?410a|r-?22|recharge|sealed system|compressor terminals?)\b/i },
  { id: 'WATER_HEATER_TPR', pattern: /\b(remove|replace|plug|cap|block|tamper)\b[^.]{0,40}\b(t ?& ?p|temperature (and|&) pressure|relief) valve/i },
  { id: 'ROOF_ACCESS', pattern: /\b(climb|get|go|walk|step|stand)\b[^.]{0,20}\b(on(to)?|up (on|to)) (the )?roof\b|\bladder\b[^.]{0,30}\broof\b/i },
  { id: 'STRUCTURAL_MOD', pattern: /\b(remove|cut|notch|drill through)\b[^.]{0,30}\b(load[- ]bearing|joist|beam|stud|truss|rafter)/i },
  { id: 'GARAGE_SPRING', pattern: /\b(torsion spring|garage door spring|extension spring)/i },
  { id: 'CHEMICAL_MIXING', pattern: /\bmix\b[^.]{0,40}\b(bleach|ammonia|drain cleaner|vinegar and bleach)|\bbleach\b[^.]{0,30}\b(ammonia|vinegar|drain cleaner)/i },
  { id: 'HAZMAT_DISTURB', pattern: /\b(sand|scrape|cut|remove|disturb)\b[^.]{0,30}\b(asbestos|popcorn ceiling|vermiculite|lead paint)/i },
  { id: 'BYPASS_SAFETY_DEVICE', pattern: /\b(bypass|jump(er)?|disable|override)\b[^.]{0,30}\b(safety|limit switch|pressure switch|interlock|float switch|rollout|breaker|gfci|fuse)/i },
];

/**
 * Narrow allow-list that takes precedence over PROHIBITED_ACTIONS for common, safe
 * homeowner checks (resetting a tripped GFCI or breaker once, turning a device off at its
 * switch). Only applied when no HIGH/EMERGENCY hazard is present on the case.
 */
export const ALLOWED_OVERRIDES = [
  /\bpress (the )?(reset|test) button on (the )?gfci\b/i,
  /\breset (a |the )?tripped (breaker|gfci)\b/i,
  /\bturn (it |the unit |the system |the thermostat )?off at the (thermostat|switch|wall switch)\b/i,
];

// Step action types allowed at each risk level.
export const ALLOWED_ACTIONS_BY_RISK = {
  LOW: ['observe', 'safe_check', 'repair', 'verify'],
  MODERATE: ['observe', 'safe_check', 'verify'],
  HIGH: [],
  EMERGENCY: [],
};

// Deterministic guidance shown instead of model output for HIGH and EMERGENCY.
export const SAFETY_GUIDANCE = {
  gas: [
    'Leave the building now with everyone, including pets. Do not stop to look for the leak.',
    'Do not switch lights or appliances on or off, use phones, or create any spark or flame inside.',
    'Once you are outside and at a safe distance, call your gas utility emergency line or 911.',
    'Do not go back inside until the utility or fire department says it is safe.',
  ],
  co: [
    'Get everyone, including pets, outside into fresh air immediately.',
    'Call 911 or your local emergency number from outside. Seek medical help if anyone has a headache, dizziness, nausea or confusion.',
    'Do not go back inside until emergency responders say it is safe.',
  ],
  fire: [
    'Leave the building and call 911.',
    'Do not try to put out an electrical fire with water.',
  ],
  injury: [
    'If someone was shocked and is hurt, unresponsive or has a burn, call 911 now.',
    'Do not touch a person who is still in contact with an electrical source.',
  ],
  water_electric: [
    'Stay out of standing water near outlets, cords, appliances or the electrical panel.',
    'Do not touch the electrical panel if you are standing in water or it is wet.',
    'If you can reach the main water shutoff without going near water and electricity, turn it off.',
    'Call your electric utility or 911 if water is in contact with electrical equipment.',
  ],
  structural: [
    'Keep everyone out of the area below or near the damaged ceiling, roof, floor or wall.',
    'If there is active water above a sagging ceiling, move belongings and people away; do not puncture it.',
    'Contact a licensed contractor or structural engineer. Call 911 if collapse appears imminent.',
  ],
  electrical: [
    'Do not touch exposed wires, damaged outlets or the affected device.',
    'If it is safe to reach the electrical panel without touching the affected area, switch off the circuit for that area.',
    'Keep children and pets away. A licensed electrician should inspect and repair this.',
  ],
  water_major: [
    'If you can do so safely, turn off the main water shutoff valve.',
    'Keep away from water that may be in contact with electrical outlets, cords or appliances.',
    'Move valuables out of the affected area and photograph the damage for your records.',
  ],
  default_high: [
    'Stop troubleshooting this issue yourself.',
    'Keep people and pets away from the affected area.',
    'Book a qualified professional to inspect and repair it.',
  ],
};
