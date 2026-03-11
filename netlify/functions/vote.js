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
// Phase 2 rollout stays inert until these env flags are enabled after the migration.
const VOTE_VERIFICATION_ENABLED = process.env.VOTE_VERIFICATION_ENABLED === "1";
const VOTE_STATUS_WRITE_ENABLED =
  process.env.VOTE_STATUS_WRITE_ENABLED === "1" || VOTE_VERIFICATION_ENABLED;
const VOTE_STATUS_READ_ENABLED =
  process.env.VOTE_STATUS_READ_ENABLED === "1" || VOTE_STATUS_WRITE_ENABLED;
const STATUS_CHANGED_BY = "system:netlify_vote_function";

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

function getEffectiveVoteStatus(vote) {
  if (vote?.vote_status) return vote.vote_status;
  if (vote?.is_valid_vote === true) return "counted";
  if (vote?.is_valid_vote === false) return "rejected";
  return "pending";
}

function isCountedVote(vote) {
  return getEffectiveVoteStatus(vote) === "counted";
}

function isActiveVote(vote) {
  const status = getEffectiveVoteStatus(vote);
  return status === "counted" || status === "pending";
}

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
  honeypotValue,
  invalidReason,
  isValidVote,
  normalizedBandName,
  normalizedEmail,
  statusReasonCode,
  statusReasonDetail,
  submittedFrom,
  verificationState,
  voteStatus,
  voterEmail,
  voterName,
  voterPhone,
  voterType,
}) {
  const voteRow = {
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

  if (VOTE_STATUS_WRITE_ENABLED) {
    const resolvedVoteStatus = voteStatus || (isValidVote ? "counted" : "rejected");

    voteRow.vote_status = resolvedVoteStatus;
    voteRow.status_reason_code = statusReasonCode || null;
    voteRow.status_reason_detail = statusReasonDetail || null;
    voteRow.status_changed_at = new Date().toISOString();
    voteRow.status_changed_by = STATUS_CHANGED_BY;
    voteRow.honeypot_value = honeypotValue || null;
    voteRow.verification_state =
      verificationState || (resolvedVoteStatus === "pending" ? "pending" : "not_requested");
    voteRow.submitted_from = submittedFrom || "web_form";
  }

  return voteRow;
}

async function insertRejectedAuditVote(supabase, voteRow, invalidReason) {
  const rejectedVoteRow = {
    ...voteRow,
    is_valid_vote: false,
    invalid_reason: invalidReason,
  };

  if (VOTE_STATUS_WRITE_ENABLED) {
    rejectedVoteRow.vote_status = "rejected";
    rejectedVoteRow.status_reason_code = invalidReason;
    rejectedVoteRow.status_reason_detail = null;
    rejectedVoteRow.status_changed_at = new Date().toISOString();
    rejectedVoteRow.status_changed_by = STATUS_CHANGED_BY;
    rejectedVoteRow.verification_state = rejectedVoteRow.verification_state || "not_requested";
    rejectedVoteRow.submitted_from = rejectedVoteRow.submitted_from || "web_form";
  }

  const { error } = await supabase
    .from("votes")
    .insert([rejectedVoteRow]);

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
  const voteSelect = VOTE_STATUS_READ_ENABLED
    ? "canonical_band_name, band_name, vote_status, is_valid_vote"
    : "canonical_band_name, band_name, is_valid_vote";

  while (approvedNames.size > 0) {
    const to = from + pageSize - 1;

    let voteQuery = supabase
      .from("votes")
      .select(voteSelect)
      .eq("city", city)
      .range(from, to);

    if (!VOTE_STATUS_READ_ENABLED) {
      voteQuery = voteQuery.eq("is_valid_vote", true);
    }

    const { data: votes, error: voteErr } = await voteQuery;

    if (voteErr) throw voteErr;

    for (const vote of votes || []) {
      const name = (vote.canonical_band_name || vote.band_name || "").trim();
      if (!isCountedVote(vote)) continue;
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
      honeypotValue,
      normalizedEmail,
      normalizedBandName: normalizedBand,
      voterName,
      voterEmail: normalizedEmail,
      voterPhone,
      voterType,
      bandContactEmail,
      isValidVote: false,
      invalidReason: null,
      submittedFrom: "web_form",
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

    const shouldStartPending = VOTE_VERIFICATION_ENABLED;
    const submittedVoteRow = buildVoteRow({
      city,
      bandName: canonicalBandName,
      canonicalBandName,
      honeypotValue,
      normalizedEmail,
      normalizedBandName: normalize(canonicalBandName),
      statusReasonCode: shouldStartPending ? "verification_pending" : null,
      statusReasonDetail: null,
      submittedFrom: "web_form",
      verificationState: shouldStartPending ? "pending" : "not_requested",
      voteStatus: shouldStartPending ? "pending" : "counted",
      voterName,
      voterEmail: normalizedEmail,
      voterPhone,
      voterType,
      bandContactEmail,
      isValidVote: !shouldStartPending,
      invalidReason: null,
    });

    let duplicateQuery = supabase
      .from("votes")
      .select(
        VOTE_STATUS_READ_ENABLED
          ? "id, vote_status, is_valid_vote"
          : "id, is_valid_vote"
      )
      .eq("city", city)
      .eq("normalized_email", normalizedEmail)
      .limit(VOTE_STATUS_READ_ENABLED ? 5 : 1);

    if (!VOTE_STATUS_READ_ENABLED) {
      duplicateQuery = duplicateQuery.or("is_valid_vote.is.null,is_valid_vote.eq.true");
    }

    const { data: existingVote, error: dupErr } = await duplicateQuery;

    if (dupErr) return json(500, { error: dupErr.message });

    const hasActiveDuplicate = (existingVote || []).some((vote) => isActiveVote(vote));

    if (hasActiveDuplicate) {
      await insertRejectedAuditVote(supabase, submittedVoteRow, "duplicate_email_city");
      return json(400, await buildDuplicateVoteResponse(supabase, city, canonicalBandName));
    }

    const { error: insertErr } = await supabase
      .from("votes")
      .insert([submittedVoteRow]);

    if (insertErr?.code === "23505") {
      await insertRejectedAuditVote(supabase, submittedVoteRow, "duplicate_email_city");
      return json(400, await buildDuplicateVoteResponse(supabase, city, canonicalBandName));
    }

    if (insertErr) return json(500, { error: insertErr.message });

    try {
      const snapshot = await getCityLeaderboardSnapshot(supabase, city);
      const count = snapshot.totals[canonicalBandName] || 0;

      if (shouldStartPending) {
        return json(200, {
          ok: true,
          message: `Please check your email to confirm your vote for ${canonicalBandName} in ${city}.`,
          city,
          bandName: canonicalBandName,
          count,
          threshold: COUNT_THRESHOLD,
          snapshot,
          verificationRequired: true,
        });
      }

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
