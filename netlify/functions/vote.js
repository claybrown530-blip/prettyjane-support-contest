const { createClient } = require("@supabase/supabase-js");

const json = (statusCode, body) => ({
  statusCode,
  headers: {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  },
  body: JSON.stringify(body),
});

const normalizeBandName = (s) =>
  (s || "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[\u2019]/g, "'");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, { ok: true });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return json(500, { error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // GET: leaderboard for a city
  if (event.httpMethod === "GET") {
    const city = (event.queryStringParameters?.city || "").trim();
    if (!city) return json(400, { error: "Missing city" });

    const { data: seeds, error: seedErr } = await supabase
      .from("bands")
      .select("city,name")
      .eq("city", city)
      .order("name", { ascending: true });

    if (seedErr) return json(500, { error: seedErr.message });

    // IMPORTANT: only valid votes count
    const { data: votes, error: voteErr } = await supabase
      .from("votes")
      .select("band_name, canonical_band_name, is_valid_vote")
      .eq("city", city)
      .or("is_valid_vote.is.null,is_valid_vote.eq.true");

    if (voteErr) return json(500, { error: voteErr.message });

    const totals = {};
    for (const v of votes || []) {
      const countedName = normalizeBandName(v.canonical_band_name || v.band_name);
      if (!countedName) continue;
      totals[countedName] = (totals[countedName] || 0) + 1;
    }

    return json(200, {
      ok: true,
      city,
      seeds: seeds || [],
      totals,
      threshold: 10,
    });
  }

  // POST: submit a vote
  if (event.httpMethod === "POST") {
    let payload;
    try {
      payload = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { error: "Invalid JSON" });
    }

    const city = (payload.city || "").trim();
    let bandName = normalizeBandName(payload.bandName);
    const normalizedInput = bandName.toLowerCase();

    const voterName = (payload.voterName || "").trim();
    const voterEmail = (payload.voterEmail || "").trim().toLowerCase();
    const voterPhone = (payload.voterPhone || "").trim();
    const voterType = (payload.voterType || "").trim().toLowerCase();
    const bandContactEmail = (payload.bandContactEmail || "").trim().toLowerCase();

    if (!city || !bandName || !voterName || !voterEmail || !voterType) {
      return json(400, { error: "Missing required fields" });
    }
    if (!["individual", "band"].includes(voterType)) {
      return json(400, { error: "voterType must be individual or band" });
    }

    // Match official starter candidates first
    const { data: officialBands } = await supabase
      .from("bands")
      .select("name")
      .eq("city", city);

    const officialMatch = (officialBands || []).find(
      (b) => normalizeBandName(b.name).toLowerCase() === normalizedInput
    );
    if (officialMatch) {
      bandName = officialMatch.name;
    }

    // Alias match
    const { data: aliases } = await supabase
      .from("band_aliases")
      .select("alias, canonical_name")
      .eq("city", city);

    const aliasMatch = (aliases || []).find(
      (a) => normalizeBandName(a.alias).toLowerCase() === normalizedInput
    );

    const canonicalBandName = aliasMatch
      ? aliasMatch.canonical_name
      : (officialMatch ? officialMatch.name : bandName);

    const { error: insErr } = await supabase.from("votes").insert([{
      city,
      band_name: bandName,
      canonical_band_name: canonicalBandName,
      normalized_email: voterEmail,
      normalized_band_name: normalizedInput,
      voter_name: voterName,
      voter_email: voterEmail,
      voter_phone: voterPhone || null,
      voter_type: voterType,
      band_contact_email: bandContactEmail || null,
      is_valid_vote: true,
      invalid_reason: null,
    }]);

    if (insErr) return json(500, { error: insErr.message });

    const { data: bandVotes, error: countErr } = await supabase
      .from("votes")
      .select("id")
      .eq("city", city)
      .eq("canonical_band_name", canonicalBandName)
      .or("is_valid_vote.is.null,is_valid_vote.eq.true");

    if (countErr) return json(500, { error: countErr.message });

    const count = (bandVotes || []).length;

    return json(200, {
      ok: true,
      message: `Thank you for voting! ${canonicalBandName} now has ${count} vote${count === 1 ? "" : "s"} in ${city}.`,
      city,
      bandName: canonicalBandName,
      count,
      threshold: 10,
    });
  }

  return json(405, { error: "Method not allowed" });
};
