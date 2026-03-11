const emailRegex = /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/;

const BLOCKED_EMAIL_DOMAINS = new Set([
  "10minutemail.com",
  "a.com",
  "b.com",
  "blah.com",
  "bwmyga.com",
  "c.com",
  "e-hps.com",
  "example.com",
  "fakeband.scamqqqqq",
  "g.com",
  "gmail.con",
  "guerrillamail.com",
  "hotjew.com",
  "jfdofd.comcdccccd",
  "lnic.com",
  "lnovic.com",
  "mailinator.com",
  "ozsaip.com",
  "ruutukf.com",
  "scam.coma",
  "tempmail.com",
  "trashmail.com",
  "yalo.com",
  "yopmail.com",
  "yzcalo.com",
  "xkwhud.com",
]);

const BLOCKED_DOMAIN_PATTERNS = [
  /\.con$/i,
  /(mailinator|guerrillamail|tempmail|trashmail|10minutemail|yopmail)/i,
];

const TROLL_PATTERNS = [
  /\b(?:asshole|bitch|butthole|cum|dick|fuck|penis|shit)\b/i,
];

const normalize = (value) =>
  (value || "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[\u2019]/g, "'")
    .toLowerCase();

const getEmailDomain = (email) => {
  const normalizedEmail = (email || "").trim().toLowerCase();
  const parts = normalizedEmail.split("@");
  return parts.length === 2 ? parts[1] : "";
};

const findBlockedEmailDomainReason = (email) => {
  const domain = getEmailDomain(email);
  if (!domain) return null;
  if (BLOCKED_EMAIL_DOMAINS.has(domain)) return "blocked_email_domain";
  if (BLOCKED_DOMAIN_PATTERNS.some((pattern) => pattern.test(domain))) {
    return "blocked_email_domain";
  }
  return null;
};

const hasTrollContent = (value) =>
  TROLL_PATTERNS.some((pattern) => pattern.test(value || ""));

module.exports = {
  BLOCKED_EMAIL_DOMAINS,
  emailRegex,
  findBlockedEmailDomainReason,
  getEmailDomain,
  hasTrollContent,
  normalize,
};
