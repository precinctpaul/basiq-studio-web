/**
 * Majority Democrats / The Bench membership, cross-checked against
 * tools/MB and Bench Members.txt (the same roster bulk_tag_buckets.py uses
 * for the videos/tags schema) against the archive's actual `people.full_name`
 * spellings. Only the ~30 names that actually have archive content are
 * listed -- the roster has 61, but most have no items in this schema.
 *
 * Deliberately NOT last-name matching: three roster names collide with a
 * DIFFERENT real person sharing that last name in the archive (Don Scott
 * vs Senator Tim Scott, Kayla Young vs Rep. Don/Todd Young, Johnny Garcia
 * vs Rep. Robert Garcia) -- the same class of bug that hit Sherrill/Paige/
 * Mallory earlier in this project. Two names use a different first-name
 * form than the roster ("Pat Ryan" -> "Patrick Ryan", "Jeff Jackson" ->
 * "Jeffrey Jackson") -- confirmed by hand as the same person, not a
 * last-name guess.
 */
export const MAJORITY_DEMOCRATS = new Set([
  "Ruben Gallego",
  "George Whitesides",
  "Matt Mahan",
  "Joe Neguse",
  "Michael Bennet",
  "Sarah McBride",
  "Jared Golden",
  "Jake Auchincloss",
  "Elissa Slotkin",
  "Kristen McDonald Rivet",
  "Angie Craig",
  "Maggie Goodlander",
  "Mikie Sherrill",
  "Gabe Vasquez",
  "Josh Riley",
  "Patrick Ryan",
  "Ritchie Torres",
  "Jeffrey Jackson",
  "Janelle Bynum",
  "Brendan Boyle",
  "Paige Cognetti",
  "Ron Nirenberg",
  "Abigail Spanberger",
  "Marie Gluesenkamp Perez",
  "Cavalier Johnson",
]);

export const THE_BENCH = new Set([
  "Jason Esteves",
  "Mary Peltola",
  "Josh Turek",
  "James Talarico",
  "Mallory McMorrow",
  "Jamie Ager",
]);
