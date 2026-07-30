const TOKEN_PATTERNS = [
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bgh[ousr]_[A-Za-z0-9]{20,}\b/g,
];

export function redactSensitive(value) {
  let text = String(value ?? "");
  text = text.replace(/\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^\s/@]+(?::[^\s/@]*)?)@/g, "$1[REDACTED]@");
  text = text.replace(/\b(Authorization\s*:\s*)(?:Bearer|Basic|token)\s+[^\s,;]+/gi, "$1[REDACTED]");
  for (const pattern of TOKEN_PATTERNS) text = text.replace(pattern, "[REDACTED]");
  return text;
}

export function safeError(error) {
  const detail = error?.stderr?.toString?.().trim()
    || error?.message
    || `${error}`;
  return redactSensitive(detail);
}

export function sanitizeErrorFields(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const copy = { ...value };
  if (copy.error != null) copy.error = redactSensitive(copy.error);
  if (copy.delivery && typeof copy.delivery === "object") {
    copy.delivery = { ...copy.delivery };
    if (copy.delivery.error != null) copy.delivery.error = redactSensitive(copy.delivery.error);
  }
  return copy;
}
