const { createClient } = require("@supabase/supabase-js");
const {
  emailRegex,
  findBlockedEmailDomainReason,
  hasTrollContent,
  normalize,
} = require("./_shared/anti-abuse");

const COUNT_THRESHOLD = 10;
const CLOSED_CITY_MESSAGES = {
  "OKC, OK": "OKC voting is now closed.",
};

const json = (statusCode, body) => ({
  statusCode,
  headers: {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Cache-Control": "no-store",
  },
  body: JSON.stringify(body),
});

async function getCityRoster(supabase, city) {
  const { data, error } = await supabase
    .from("bands")
    .select("city,name")
    .eq("city", city)
    .order("name", { ascending: true });

  if (error) throw error;
  return data || [];
}

function buildRosterLookup(roster) {
  const approvedNames = new Set();
  const canonicalByNormalized = new Map();

  for (const band of roster || []) {
    const canonicalName = (band?.name || "").trim();
    if (!canonicalName) continue;
    approvedNames.add(canonicalName);
    canonicalByNormalized.set(normalize(canonicalName), canonicalName);
  }

  return { approvedNames, canonicalByNormalized };
}

function buildVoteRow({
  bandContactEmail,
  bandName,
  canonicalBandName,
  city,
  invalidReason,
  isValidVote,
  normalizedBandName,
  normalizedEmail,
  voterEmail,
  voterName,
  voterPhone,
  voterType,
}) {
  return {
    city,
    band_name: bandName,
    canonical_band_name: canonicalBandName || null,
    normalized_email: normalizedEmail || null,
    normalized_band_name: normalizedBandName || null,
    voter_name: voterName,
    voter_email: voterEmail,
    voter_phone: voterPhone || null,
    voter_type: voterType,
    band_contact_email: bandContactEmail || null,
    is_valid_vote: isValidVote,
    invalid_reason: invalidReason || null,
  };
}

async function insertRejectedAuditVote(supabase, voteRow, invalidReason) {
  const { error } = await supabase
    .from("votes")
    .insert([{ ...voteRow, is_valid_vote: false, invalid_reason: invalidReason }]);

  if (error) {
    console.error("Failed to audit rejected vote", invalidReason, error.message);
  }
}

async function getCityLeaderboardSnapshot(supabase, city) {
  const roster = await getCityRoster(supabase, city);
  const { approvedNames } = buildRosterLookup(roster);

  const totals = {};
  const pageSize = 1000;
  let from = 0;

  while (approvedNames.size > 0) {
    const to = from + pageSize - 1;

    const { data: votes, error: voteErr } = await supabase
      .from("votes")
      .select("canonical_band_name, band_name")
      .eq("city", city)
      .eq("is_valid_vote", true)
      .range(from, to);

    if (voteErr) throw voteErr;

    for (const vote of votes || []) {
      const name = (vote.canonical_band_name || vote.band_name || "").trim();
      if (!approvedNames.has(name)) continue;
      totals[name] = (totals[name] || 0) + 1;
    }

    if (!votes || votes.length < pageSize) break;
    from += pageSize;
  }

  return {
    city,
    seeds: roster,
    totals,
    threshold: COUNT_THRESHOLD,
  };
}

async function buildDuplicateVoteResponse(supabase, city, canonicalBandName) {
  try {
    const snapshot = await getCityLeaderboardSnapshot(supabase, city);
    const count = snapshot.totals[canonicalBandName] || 0;
    return {
      error: `Looks like this email already voted in ${city}.`,
      city,
      bandName: canonicalBandName,
      count,
      threshold: COUNT_THRESHOLD,
      snapshot,
    };
  } catch (error) {
    return {
      error: `Looks like this email already voted in ${city}.`,
      city,
      bandName: canonicalBandName,
      count: 0,
      threshold: COUNT_THRESHOLD,
    };
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, { ok: true });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return json(500, { error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  if (event.httpMethod === "GET") {
    const city = (event.queryStringParameters?.city || "").trim();
    if (!city) return json(400, { error: "Missing city" });

    try {
      const snapshot = await getCityLeaderboardSnapshot(supabase, city);
      return json(200, { ok: true, ...snapshot });
    } catch (error) {
      return json(500, { error: error.message || "Failed to load leaderboard" });
    }
  }

  if (event.httpMethod === "POST") {
    let payload;
    try {
      payload = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { error: "Invalid JSON" });
    }

    const city = (payload.city || "").trim();
    const voterName = (payload.voterName || "").trim();
    const voterEmail = (payload.voterEmail || "").trim().toLowerCase();
    const voterPhone = (payload.voterPhone || "").trim();
    const voterType = (payload.voterType || "").trim().toLowerCase();
    const bandContactEmail = (payload.bandContactEmail || "").trim().toLowerCase();
    const honeypotValue = (payload.companyWebsite || "").trim();
    const requestedBandName = (payload.bandName || "").trim();

    if (!city || !voterName || !voterEmail || !voterType || !requestedBandName) {
      return json(400, { error: "Missing required fields" });
    }

    if (!["individual", "band"].includes(voterType)) {
      return json(400, { error: "voterType must be individual or band" });
    }

    if (bandContactEmail && !emailRegex.test(bandContactEmail)) {
      return json(400, { error: "Please enter a valid band contact email." });
    }

    if (!emailRegex.test(voterEmail)) {
      return json(400, { error: "Please enter a valid email." });
    }

    const normalizedEmail = voterEmail;
    const normalizedBand = normalize(requestedBandName);
    const auditBaseVote = buildVoteRow({
      city,
      bandName: requestedBandName,
      canonicalBandName: null,
      normalizedEmail,
      normalizedBandName: normalizedBand,
      voterName,
      voterEmail: normalizedEmail,
      voterPhone,
      voterType,
      bandContactEmail,
      isValidVote: false,
      invalidReason: null,
    });

    if (honeypotValue) {
      await insertRejectedAuditVote(supabase, auditBaseVote, "honeypot_filled");
      return json(400, { error: "Unable to accept this submission." });
    }

    if (hasTrollContent(voterName) || hasTrollContent(requestedBandName)) {
      await insertRejectedAuditVote(supabase, auditBaseVote, "troll_submission");
      return json(400, { error: "That submission cannot be accepted." });
    }

    const blockedDomainReason = findBlockedEmailDomainReason(normalizedEmail);
    if (blockedDomainReason) {
      await insertRejectedAuditVote(supabase, auditBaseVote, blockedDomainReason);
      return json(400, { error: "Please use a real email address." });
    }

    if (CLOSED_CITY_MESSAGES[city]) {
      await insertRejectedAuditVote(supabase, auditBaseVote, "city_closed");
      return json(400, { error: CLOSED_CITY_MESSAGES[city] });
    }

    let roster;
    try {
      roster = await getCityRoster(supabase, city);
    } catch (error) {
      return json(500, { error: error.message || "Failed to load city roster." });
    }

    const { canonicalByNormalized } = buildRosterLookup(roster);
    const canonicalBandName = canonicalByNormalized.get(normalizedBand);

    if (!roster.length) {
      await insertRejectedAuditVote(supabase, auditBaseVote, "city_not_open");
      return json(400, { error: `Voting is not open for ${city}.` });
    }

    if (!canonicalBandName) {
      await insertRejectedAuditVote(supabase, auditBaseVote, "band_not_on_roster");
      return json(400, {
        error: `Please choose one of the approved bands for ${city}.`,
      });
    }

    const countedVoteRow = buildVoteRow({
      city,
      bandName: canonicalBandName,
      canonicalBandName,
      normalizedEmail,
      normalizedBandName: normalize(canonicalBandName),
      voterName,
      voterEmail: normalizedEmail,
      voterPhone,
      voterType,
      bandContactEmail,
      isValidVote: true,
      invalidReason: null,
    });

    const { data: existingVote, error: dupErr } = await supabase
      .from("votes")
      .select("id")
      .eq("city", city)
      .eq("normalized_email", normalizedEmail)
      .or("is_valid_vote.is.null,is_valid_vote.eq.true")
      .limit(1);

    if (dupErr) return json(500, { error: dupErr.message });

    if (existingVote && existingVote.length > 0) {
      await insertRejectedAuditVote(supabase, countedVoteRow, "duplicate_email_city");
      return json(400, await buildDuplicateVoteResponse(supabase, city, canonicalBandName));
    }

    const { error: insertErr } = await supabase
      .from("votes")
      .insert([countedVoteRow]);

    if (insertErr?.code === "23505") {
      await insertRejectedAuditVote(supabase, countedVoteRow, "duplicate_email_city");
      return json(400, await buildDuplicateVoteResponse(supabase, city, canonicalBandName));
    }

    if (insertErr) return json(500, { error: insertErr.message });

    try {
      const snapshot = await getCityLeaderboardSnapshot(supabase, city);
      const count = snapshot.totals[canonicalBandName] || 0;

      return json(200, {
        ok: true,
        message: `Thank you for voting! ${canonicalBandName} now has ${count} vote${count === 1 ? "" : "s"} in ${city}.`,
        city,
        bandName: canonicalBandName,
        count,
        threshold: COUNT_THRESHOLD,
        snapshot,
      });
    } catch (error) {
      return json(500, { error: error.message || "Vote saved, but failed to refresh totals." });
    }
  }

  return json(405, { error: "Method not allowed" });
};
