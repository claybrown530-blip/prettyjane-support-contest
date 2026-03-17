const { createClient } = require("@supabase/supabase-js");
const {
  emailRegex,
  findBlockedEmailDomainReason,
  hasTrollContent,
  normalize,
  normalizeWriteInGroup,
} = require("./_shared/anti-abuse");

const COUNT_THRESHOLD = 10;
const WRITE_IN_LEADERBOARD_THRESHOLD = 5;
const CITY_RULES = {
  "OKC, OK": {
    closed: true,
    allowWriteIns: false,
    closedMessage: "OKC voting is now closed.",
  },
  "Durango, CO": {
    closed: true,
    allowWriteIns: false,
    closedMessage: "Durango voting is now closed.",
  },
  "Santa Fe, NM": {
    closed: true,
    allowWriteIns: false,
    closedMessage: "Santa Fe voting is now closed.",
  },
  "Spokane, WA": {
    closed: true,
    allowWriteIns: false,
    closedMessage: "Spokane voting is now closed.",
  },
  "Vancouver, BC": {
    closed: true,
    allowWriteIns: false,
    closedMessage: "Vancouver voting is now closed.",
  },
  "Seattle, WA": {
    closed: true,
    allowWriteIns: false,
    closedMessage: "Seattle voting is now closed.",
  },
  "San Francisco, CA": {
    closed: true,
    allowWriteIns: false,
    closedMessage: "San Francisco voting is now closed.",
  },
  "San Diego, CA": {
    closed: true,
    allowWriteIns: false,
    closedMessage: "San Diego voting is now closed.",
  },
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

function getCityRule(city) {
  return CITY_RULES[city] || {
    closed: false,
    allowWriteIns: false,
  };
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

function buildVisibleTotals(cityRule, approvedNames, countedTotals) {
  const totals = {};

  for (const [name, count] of Object.entries(countedTotals || {})) {
    if (!name) continue;
    if (approvedNames.has(name)) {
      totals[name] = count;
      continue;
    }

    if (cityRule.allowWriteIns && count >= WRITE_IN_LEADERBOARD_THRESHOLD) {
      totals[name] = count;
    }
  }

  return totals;
}

function pickWriteInDisplayName(labelCounts) {
  return Object.entries(labelCounts || {})
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      if (a[0].length !== b[0].length) return a[0].length - b[0].length;
      return a[0].localeCompare(b[0]);
    })[0]?.[0] || null;
}

function getWriteInGroupKey(value) {
  return normalizeWriteInGroup(value).trim();
}

function createLeaderboardAggregation(roster, cityRule) {
  const { approvedNames } = buildRosterLookup(roster);

  return {
    approvedNames,
    cityRule,
    countedTotals: {},
    roster,
    writeInGroups: {},
  };
}

function applyVoteToLeaderboardAggregation(aggregation, vote) {
  const { approvedNames, cityRule, countedTotals, writeInGroups } = aggregation;
  const name = (vote.canonical_band_name || vote.band_name || "").trim();
  const writeInGroupKey = getWriteInGroupKey(vote.normalized_band_name || name);

  if (!isCountedVote(vote)) return;
  if (!name) return;

  if (approvedNames.has(name) || !cityRule.allowWriteIns) {
    countedTotals[name] = (countedTotals[name] || 0) + 1;
    return;
  }

  if (!writeInGroupKey) return;

  if (!writeInGroups[writeInGroupKey]) {
    writeInGroups[writeInGroupKey] = {
      count: 0,
      labelCounts: {},
    };
  }

  writeInGroups[writeInGroupKey].count += 1;
  writeInGroups[writeInGroupKey].labelCounts[name] =
    (writeInGroups[writeInGroupKey].labelCounts[name] || 0) + 1;
}

function finalizeLeaderboardAggregation(city, aggregation) {
  const { approvedNames, cityRule, countedTotals, roster, writeInGroups } = aggregation;
  const visibleWriteInTotals = {};
  const writeInCountByNormalizedName = {};

  for (const [writeInGroupKey, group] of Object.entries(writeInGroups)) {
    writeInCountByNormalizedName[writeInGroupKey] = group.count;
    if (group.count < WRITE_IN_LEADERBOARD_THRESHOLD) continue;

    const displayName = pickWriteInDisplayName(group.labelCounts);
    if (!displayName) continue;
    visibleWriteInTotals[displayName] = group.count;
  }

  return {
    city,
    seeds: roster,
    totals: {
      ...buildVisibleTotals(cityRule, approvedNames, countedTotals),
      ...visibleWriteInTotals,
    },
    threshold: COUNT_THRESHOLD,
    writeInVisibilityThreshold: WRITE_IN_LEADERBOARD_THRESHOLD,
    countedTotals,
    writeInCountByNormalizedName,
  };
}

function buildLeaderboardSnapshotFromVotes({ city, cityRule, roster, votes }) {
  const aggregation = createLeaderboardAggregation(roster, cityRule);

  for (const vote of votes || []) {
    applyVoteToLeaderboardAggregation(aggregation, vote);
  }

  return finalizeLeaderboardAggregation(city, aggregation);
}

function toPublicSnapshot(snapshot) {
  const { countedTotals, writeInCountByNormalizedName, ...publicSnapshot } = snapshot || {};
  return publicSnapshot;
}

async function getCityLeaderboardSnapshot(supabase, city) {
  const cityRule = getCityRule(city);
  const roster = await getCityRoster(supabase, city);
  const aggregation = createLeaderboardAggregation(roster, cityRule);
  const pageSize = 1000;
  let from = 0;
  const voteSelect = VOTE_STATUS_READ_ENABLED
    ? "canonical_band_name, band_name, normalized_band_name, vote_status, is_valid_vote"
    : "canonical_band_name, band_name, normalized_band_name, is_valid_vote";

  while (true) {
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
      applyVoteToLeaderboardAggregation(aggregation, vote);
    }

    if (!votes || votes.length < pageSize) break;
    from += pageSize;
  }

  return finalizeLeaderboardAggregation(city, aggregation);
}

async function buildDuplicateVoteResponse(supabase, city, canonicalBandName) {
  try {
    const snapshot = await getCityLeaderboardSnapshot(supabase, city);
    const normalizedBandName = getWriteInGroupKey(canonicalBandName);
    const count = snapshot.countedTotals?.[canonicalBandName]
      || snapshot.writeInCountByNormalizedName?.[normalizedBandName]
      || snapshot.totals[canonicalBandName]
      || 0;
    return {
      error: `Looks like this email already voted in ${city}.`,
      city,
      bandName: canonicalBandName,
      count,
      threshold: COUNT_THRESHOLD,
      writeInVisibilityThreshold: snapshot.writeInVisibilityThreshold,
      snapshot: toPublicSnapshot(snapshot),
    };
  } catch (error) {
    return {
      error: `Looks like this email already voted in ${city}.`,
      city,
      bandName: canonicalBandName,
      count: 0,
      threshold: COUNT_THRESHOLD,
      writeInVisibilityThreshold: WRITE_IN_LEADERBOARD_THRESHOLD,
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
      return json(200, { ok: true, ...toPublicSnapshot(snapshot) });
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
    const honeypotValue = (payload.referralCode || payload.companyWebsite || "").trim();
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

    const cityRule = getCityRule(city);

    if (cityRule.closed) {
      await insertRejectedAuditVote(supabase, auditBaseVote, "city_closed");
      return json(400, {
        error: cityRule.closedMessage || `Voting is now closed for ${city}.`,
      });
    }

    let roster;
    try {
      roster = await getCityRoster(supabase, city);
    } catch (error) {
      return json(500, { error: error.message || "Failed to load city roster." });
    }

    const { canonicalByNormalized } = buildRosterLookup(roster);
    const rosterBandName = canonicalByNormalized.get(normalizedBand);

    if (!roster.length) {
      await insertRejectedAuditVote(supabase, auditBaseVote, "city_not_open");
      return json(400, { error: `Voting is not open for ${city}.` });
    }

    if (!cityRule.allowWriteIns && !rosterBandName) {
      await insertRejectedAuditVote(supabase, auditBaseVote, "band_not_on_roster");
      return json(400, {
        error: `Please choose one of the approved bands for ${city}.`,
      });
    }

    const canonicalBandName = rosterBandName || requestedBandName;

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
      const count = snapshot.countedTotals?.[canonicalBandName]
        || snapshot.writeInCountByNormalizedName?.[getWriteInGroupKey(canonicalBandName)]
        || snapshot.totals[canonicalBandName]
        || 0;
      const leaderboardEligible = Boolean(rosterBandName) || (
        cityRule.allowWriteIns && count >= WRITE_IN_LEADERBOARD_THRESHOLD
      );
      const publicSnapshot = toPublicSnapshot(snapshot);

      if (shouldStartPending) {
        return json(200, {
          ok: true,
          message: `Please check your email to confirm your vote for ${canonicalBandName} in ${city}.`,
          city,
          bandName: canonicalBandName,
          count,
          threshold: COUNT_THRESHOLD,
          snapshot: publicSnapshot,
          leaderboardEligible,
          writeInVisibilityThreshold: WRITE_IN_LEADERBOARD_THRESHOLD,
          verificationRequired: true,
        });
      }

      if (!leaderboardEligible && cityRule.allowWriteIns) {
        return json(200, {
          ok: true,
          message: `Thank you for voting! ${canonicalBandName} was submitted as a write-in in ${city}.`,
          city,
          bandName: canonicalBandName,
          count,
          threshold: COUNT_THRESHOLD,
          snapshot: publicSnapshot,
          leaderboardEligible: false,
          writeInVisibilityThreshold: WRITE_IN_LEADERBOARD_THRESHOLD,
        });
      }

      return json(200, {
        ok: true,
        message: `Thank you for voting! ${canonicalBandName} now has ${count} vote${count === 1 ? "" : "s"} in ${city}.`,
        city,
        bandName: canonicalBandName,
        count,
        threshold: COUNT_THRESHOLD,
        snapshot: publicSnapshot,
        leaderboardEligible,
        writeInVisibilityThreshold: WRITE_IN_LEADERBOARD_THRESHOLD,
      });
    } catch (error) {
      return json(500, { error: error.message || "Vote saved, but failed to refresh totals." });
    }
  }

  return json(405, { error: "Method not allowed" });
};

exports.__test = {
  buildLeaderboardSnapshotFromVotes,
  getWriteInGroupKey,
};
