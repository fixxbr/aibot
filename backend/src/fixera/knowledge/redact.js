// Removes customer-identifying details before a reviewed case becomes global knowledge.
export function redactPII(text) {
  if (!text) return text;
  return String(text)
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .replace(/(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, '[phone]')
    .replace(/\b\d{1,6}\s+([A-Z][a-z]+\s){1,3}(St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Ct|Court|Way|Pl|Place|Ter|Terrace|Cir|Circle)\b\.?/g, '[address]')
    .replace(/\b\d{5}(-\d{4})?\b/g, '[zip]')
    .replace(/\bFX-[A-Z0-9]+\b/g, '[case]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[id]')
    .replace(/\b(serial( number)?|s\/n)[:#\s]*[A-Z0-9-]{4,}\b/gi, '$1 [serial]');
}
