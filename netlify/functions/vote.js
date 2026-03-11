const { createClient } = require("@supabase/supabase-js");

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

const normalize = (s) =>
  (s || "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[\u2019]/g, "'")
    .toLowerCase();

const emailRegex = /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/;
const badWords = ["cum", "penis", "butthole", "asshole", "shit"];

async function getCityLeaderboardSnapshot(supabase, city) {
  const { data: seeds, error: seedErr } = await supabase
    .from("bands")
    .select("city,name")
    .eq("city", city)
    .order("name", { ascending: true });

  if (seedErr) throw seedErr;

  const totals = {};
  const pageSize = 1000;
  let from = 0;

  while (true) {
    const to = from + pageSize - 1;

    const { data: votes, error: voteErr } = await supabase
      .from("votes")
      .select("canonical_band_name, band_name")
      .eq("city", city)
      .or("is_valid_vote.is.null,is_valid_vote.eq.true")
      .range(from, to);

    if (voteErr) throw voteErr;

    for (const v of votes || []) {
      const name = (v.canonical_band_name || v.band_name || "").trim();
      if (!name) continue;
      totals[name] = (totals[name] || 0) + 1;
    }

    if (!votes || votes.length < pageSize) break;
    from += pageSize;
  }

  return {
    city,
    seeds: seeds || [],
    totals,
    threshold: 10,
  };
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
    } catch (err) {
      return json(500, { error: err.message || "Failed to load leaderboard" });
    }
  }

  if (event.httpMethod === "POST") {
    let payload;
    try {
      payload = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { error: "Invalid JSON" });
    }

    let city = (payload.city || "").trim();
    const voterName = (payload.voterName || "").trim();
    const voterEmail = (payload.voterEmail || "").trim().toLowerCase();
    const voterPhone = (payload.voterPhone || "").trim();
    const voterType = (payload.voterType || "").trim().toLowerCase();
    const bandContactEmail = (payload.bandContactEmail || "").trim().toLowerCase();
    let bandName = (payload.bandName || "").trim();

    if (!city || !voterName || !voterEmail || !voterType || !bandName) {
      return json(400, { error: "Missing required fields" });
    }

    if (!["individual", "band"].includes(voterType)) {
      return json(400, { error: "voterType must be individual or band" });
    }

    const normalizedEmail = voterEmail;
    const normalizedBand = normalize(bandName);

    if (!emailRegex.test(normalizedEmail)) {
      return json(400, { error: "Please enter a valid email." });
    }

    if (badWords.some((w) => normalizedBand.includes(w))) {
      return json(400, { error: "That submission cannot be accepted." });
    }

    if (city === "OKC, OK") {
      return json(400, { error: "OKC voting is now closed." });
    }

    let canonicalBandName = bandName;

    const { data: localBands, error: localErr } = await supabase
      .from("bands")
      .select("name")
      .eq("city", city);

    if (localErr) return json(500, { error: localErr.message });

    const localMatch = (localBands || []).find(
      (b) => normalize(b.name) === normalizedBand
    );

    if (localMatch) {
      canonicalBandName = localMatch.name;
    } else if (city === "OKC, OK") {
      return json(400, { error: "OKC is now in the final round. Please choose one of the approved OKC bands." });
    } else {
      const { data: globalAlias, error: aliasErr } = await supabase
        .from("band_aliases_global")
        .select("canonical_name, home_city")
        .eq("alias", normalizedBand)
        .limit(1);

      if (aliasErr) return json(500, { error: aliasErr.message });

      if (globalAlias && globalAlias.length > 0) {
        canonicalBandName = globalAlias[0].canonical_name;
        city = globalAlias[0].home_city;
      } else {
        const { data: allBands, error: allBandsErr } = await supabase
          .from("bands")
          .select("name, city");

        if (allBandsErr) return json(500, { error: allBandsErr.message });

        const globalBandMatch = (allBands || []).find(
          (b) => normalize(b.name) === normalizedBand
        );

        if (globalBandMatch) {
          canonicalBandName = globalBandMatch.name;
          city = globalBandMatch.city;
        }
      }
    }

    const { data: existingVote, error: dupErr } = await supabase
      .from("votes")
      .select("id")
      .eq("city", city)
      .eq("normalized_email", normalizedEmail)
      .or("is_valid_vote.is.null,is_valid_vote.eq.true")
      .limit(1);

    if (dupErr) return json(500, { error: dupErr.message });

    if (existingVote && existingVote.length > 0) {
      try {
        const snapshot = await getCityLeaderboardSnapshot(supabase, city);
        const count = snapshot.totals[canonicalBandName] || 0;
        return json(400, {
          error: `Looks like this email already voted in ${city}.`,
          city,
          bandName: canonicalBandName,
          count,
          threshold: 10,
          snapshot,
        });
      } catch (err) {
        return json(400, {
          error: `Looks like this email already voted in ${city}.`,
          city,
          bandName: canonicalBandName,
          count: 0,
          threshold: 10,
        });
      }
    }

    const { error: insertErr } = await supabase
      .from("votes")
      .insert([{
        city,
        band_name: bandName,
        canonical_band_name: canonicalBandName,
        normalized_email: normalizedEmail,
        normalized_band_name: normalizedBand,
        voter_name: voterName,
        voter_email: normalizedEmail,
        voter_phone: voterPhone || null,
        voter_type: voterType,
        band_contact_email: bandContactEmail || null,
        is_valid_vote: true,
        invalid_reason: null,
      }]);

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
        threshold: 10,
        snapshot,
      });
    } catch (err) {
      return json(500, { error: err.message || "Vote saved, but failed to refresh totals." });
    }
  }

  return json(405, { error: "Method not allowed" });
};
