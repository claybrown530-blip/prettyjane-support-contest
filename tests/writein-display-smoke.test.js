const test = require("node:test");
const assert = require("node:assert/strict");

const { __test } = require("../netlify/functions/vote.js");

const { buildLeaderboardSnapshotFromVotes, getWriteInGroupKey } = __test;

function countedVote(name) {
  return {
    band_name: name,
    canonical_band_name: name,
    normalized_band_name: name,
    vote_status: "counted",
    is_valid_vote: true,
  };
}

function rejectedVote(name) {
  return {
    band_name: name,
    canonical_band_name: name,
    normalized_band_name: name,
    vote_status: "rejected",
    is_valid_vote: false,
  };
}

test("normalization grouping collapses spacing and casing variants", () => {
  assert.equal(getWriteInGroupKey("CroonDog"), getWriteInGroupKey("Croon dog"));
  assert.equal(getWriteInGroupKey("CROON DOG"), "croondog");

  const snapshot = buildLeaderboardSnapshotFromVotes({
    city: "San Diego, CA",
    cityRule: { allowWriteIns: true },
    roster: [],
    votes: [
      countedVote("CroonDog"),
      countedVote("CroonDog"),
      countedVote("Croon dog"),
      countedVote("Croon dog"),
      countedVote("croon dog"),
      rejectedVote("CroonDog"),
    ],
  });

  assert.equal(snapshot.writeInCountByNormalizedName.croondog, 5);
  assert.equal(snapshot.totals.CroonDog, 5);
});

test("threshold visibility shows spaced write-ins once they hit five counted votes", () => {
  const snapshot = buildLeaderboardSnapshotFromVotes({
    city: "San Francisco, CA",
    cityRule: { allowWriteIns: true },
    roster: [],
    votes: Array.from({ length: 5 }, () => countedVote("Kiori band")),
  });

  assert.equal(snapshot.totals["Kiori band"], 5);
  assert.equal(snapshot.writeInCountByNormalizedName.kioriband, 5);
});

test("below-threshold junk stays hidden", () => {
  const snapshot = buildLeaderboardSnapshotFromVotes({
    city: "Seattle, WA",
    cityRule: { allowWriteIns: true },
    roster: [],
    votes: [
      countedVote("Definitely Junk"),
      countedVote("Definitely Junk"),
      countedVote("Definitely Junk"),
      countedVote("Definitely Junk"),
      rejectedVote("Definitely Junk"),
    ],
  });

  assert.equal(snapshot.writeInCountByNormalizedName.definitelyjunk, 4);
  assert.equal(snapshot.totals["Definitely Junk"], undefined);
});

test("approved roster bands still bypass write-in visibility threshold", () => {
  const snapshot = buildLeaderboardSnapshotFromVotes({
    city: "Seattle, WA",
    cityRule: { allowWriteIns: true },
    roster: [{ name: "Approved Band" }],
    votes: [countedVote("Approved Band")],
  });

  assert.equal(snapshot.totals["Approved Band"], 1);
  assert.deepEqual(snapshot.writeInCountByNormalizedName, {});
});
