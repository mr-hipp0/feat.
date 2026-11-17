/* FEAT. game rules. No DOM, storage, network, or framework dependencies. */
(function (root, factory) {
  'use strict';
  const engine = factory();
  if (typeof module === 'object' && module.exports) module.exports = engine;
  root.FEAT_ENGINE = engine;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ROLES = ['guest', 'producer', 'songwriter'];
  // Retained as the legacy catalog count target, not an active gameplay cap.
  const MAX_POOL_SIZE = 500;
  const DIFFICULTY_LIMITS = Object.freeze({ easy: 50, medium: 200, hard: Infinity });
  const ALIASES = new Map([
    ['kevinparker', 'Tame Impala'], ['tameimpala', 'Tame Impala'],
    ['ye', 'Kanye West'], ['kanyewest', 'Kanye West'],
    ['puffdaddy', 'Diddy'], ['pdiddy', 'Diddy'], ['diddy', 'Diddy'],
    ['jayz', 'JAY-Z'], ['jayzcarter', 'JAY-Z'],
    ['pharrell', 'Pharrell Williams'], ['pharrellwilliams', 'Pharrell Williams']
  ]);
  let roundSequence = 0;

  /** Search-friendly Unicode normalization; does not mutate the input. */
  function normalize(text) {
    return String(text == null ? '' : text)
      .normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('en')
      .replace(/ß/g, 'ss').replace(/\$/g, 's')
      .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
  }

  function identity(name) {
    const key = normalize(name).replace(/\s/g, '');
    return ALIASES.get(key) || String(name || '').trim();
  }

  function identityKey(name) {
    return normalize(identity(name)).replace(/\s/g, '');
  }

  function snapshotSettings(settings) {
    return { producers: Boolean(settings && settings.producers), songwriters: Boolean(settings && (settings.songwriters || settings.writers)), decades: normalizeDecades(settings && (settings.decades ?? settings.decade)), difficulty: normalizeDifficulty(settings && settings.difficulty) };
  }

  function normalizeDifficulty(value) {
    const difficulty = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return Object.hasOwn(DIFFICULTY_LIMITS, difficulty) ? difficulty : 'hard';
  }

  function normalizeDecade(value) {
    const number = Number(String(value ?? '').replace(/s$/, ''));
    return Number.isInteger(number) && number >= 1900 && number <= 2100 && number % 10 === 0 ? String(number) : 'all';
  }

  /** Canonical multi-selection; an empty array includes every decade. */
  function normalizeDecades(value) {
    const values = Array.isArray(value) ? value : [value];
    return [...new Set(values.filter(item => typeof item === 'string' || typeof item === 'number')
      .map(normalizeDecade).filter(decade => decade !== 'all'))].sort((a, b) => Number(b) - Number(a));
  }

  /** Original album year determines its decade, even when clues use a reissue. */
  function albumDecade(album) {
    const year = Number(album && (album.originalReleaseYear ?? album.year));
    return Number.isInteger(year) && year >= 1900 && year <= 2109 ? String(Math.floor(year / 10) * 10) : null;
  }

  function availableDecades(catalog) {
    return [...new Set((catalog || []).map(albumDecade).filter(Boolean))].sort((a, b) => Number(b) - Number(a));
  }

  /**
   * Return distinct enabled collaborators in editorial input order.
   * Guests are always enabled. Producer/songwriter roles are opt-in.
   * Main album artists are excluded. Supply primaryArtists for joint albums,
   * and credit.canonicalName for aliases beyond the small known alias map.
   */
  function contributors(album, settings) {
    const selected = snapshotSettings(settings);
    const primaryNames = [album && album.artist, ...((album && album.primaryArtists) || [])];
    const primaryKeys = new Set(primaryNames.filter(Boolean).map(identityKey));
    const people = new Map();
    for (const credit of ((album && album.credits) || [])) {
      if (!credit || typeof credit.name !== 'string' || !credit.name.trim()) continue;
      const canonicalName = identity(credit.canonicalName || credit.name);
      const key = identityKey(canonicalName);
      if (!key || primaryKeys.has(key) || credit.sampleOnly === true) continue;
      const allowedRoles = ROLES.filter(role => Array.isArray(credit.roles) && credit.roles.includes(role) &&
        (role === 'guest' || (role === 'producer' && selected.producers) || (role === 'songwriter' && selected.songwriters)));
      if (!allowedRoles.length) continue;
      const sources = [...(Array.isArray(credit.sources) ? credit.sources : []), credit.source].filter(source => typeof source === 'string' && source);
      if (people.has(key)) {
        const person = people.get(key);
        person.roles = ROLES.filter(role => person.roles.includes(role) || allowedRoles.includes(role));
        person.sources = [...new Set([...person.sources, ...sources])];
        if (!person.source && sources.length) person.source = sources[0];
      } else {
        people.set(key, { name: credit.name.trim(), canonicalName, roles: allowedRoles, source: sources[0] || '', sources: [...new Set(sources)] });
      }
    }
    return [...people.values()];
  }

  /** Filter all preferences, order by popularity, then select the nested tier. */
  function eligibleAlbums(catalog, settings, genre = 'all') {
    const filter = normalize(genre);
    const selected = snapshotSettings(settings), decades = selected.decades;
    return (Array.isArray(catalog) ? catalog : []).filter(album =>
      (filter === 'all' || (album.genres || []).some(value => normalize(value) === filter)) &&
      (!decades.length || decades.includes(albumDecade(album))) && contributors(album, selected).length >= 3
    ).sort((left, right) => {
      // Stream totals remain comparable when candidate lists use different rank scopes.
      if (Number.isFinite(left.streams) && Number.isFinite(right.streams) && left.streams !== right.streams) return right.streams - left.streams;
      const rankLeft = Number.isFinite(left.rank) ? left.rank : Infinity;
      const rankRight = Number.isFinite(right.rank) ? right.rank : Infinity;
      if (rankLeft !== rankRight) return rankLeft - rankRight;
      const streamsLeft = Number.isFinite(left.streams) ? left.streams : 0;
      const streamsRight = Number.isFinite(right.streams) ? right.streams : 0;
      return streamsRight - streamsLeft || String(left.title).localeCompare(String(right.title));
    }).slice(0, DIFFICULTY_LIMITS[selected.difficulty]);
  }

  /** Cumulative names visible before guesses 1, 2, and 3. */
  function revealCounts(count) {
    const total = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
    return [Math.ceil(total / 3), Math.ceil(total * 2 / 3), total];
  }

  /** A deterministic preview in source order. Live rounds use their shuffled clueOrder. */
  function visibleContributors(album, settings, attemptIndex = 0) {
    const people = contributors(album, settings);
    const index = Math.max(0, Math.min(2, Number.isFinite(attemptIndex) ? Math.floor(attemptIndex) : 0));
    return people.slice(0, revealCounts(people.length)[index]);
  }

  function randomIndex(length, rng) {
    const value = Number(rng());
    return Math.min(length - 1, Math.max(0, Math.floor((Number.isFinite(value) ? value : 0) * length)));
  }

  /** Fisher–Yates shuffle returning a copy; an injected RNG makes tests repeatable. */
  function shuffle(list, rng = Math.random) {
    const result = [...list];
    for (let i = result.length - 1; i > 0; i -= 1) {
      const target = randomIndex(i + 1, rng);
      [result[i], result[target]] = [result[target], result[i]];
    }
    return result;
  }

  /**
   * A serializable round owns its settings and random reveal order until finished.
   * status is playing | won | lost; guesses are {albumId,kind,correct} records.
   */
  function createRound(album, settings, rng = Math.random) {
    const selected = snapshotSettings(settings);
    const people = contributors(album, selected);
    if (!album || typeof album.id !== 'string' || !album.id) throw new TypeError('An album with a stable id is required.');
    if (people.length < 3) throw new RangeError('A puzzle requires at least three distinct enabled collaborators.');
    const id = typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${(++roundSequence).toString(36)}-${Math.random().toString(36).slice(2)}`;
    return { id, albumId: album.id, settings: selected, clueOrder: shuffle(people, rng), guesses: [], status: 'playing', credited: false };
  }

  /**
   * Submit an album id, "skip", or "give-up" on the final available attempt.
   * Return {round,correct,finished,duplicate}. Neither argument is mutated.
   * Repeating a guessed album costs no attempt; skips may be repeated.
   */
  function submitGuess(round, albumId) {
    if (!round || !Array.isArray(round.guesses)) throw new TypeError('A valid round is required.');
    if (round.status !== 'playing') return { round, correct: round.status === 'won', finished: true, duplicate: false };
    if (typeof albumId !== 'string' || !albumId) throw new TypeError('Select an album before guessing.');
    const gaveUp = albumId === 'give-up';
    if (gaveUp && round.guesses.length !== 2) throw new RangeError('Give up is available on the final guess.');
    const skipped = albumId === 'skip' || gaveUp;
    if (!skipped && round.guesses.some(guess => guess.kind === 'guess' && guess.albumId === albumId)) {
      return { round, correct: false, finished: false, duplicate: true };
    }
    const correct = !skipped && albumId === round.albumId;
    const guesses = [...round.guesses, { albumId: skipped ? null : albumId, kind: gaveUp ? 'give-up' : skipped ? 'skip' : 'guess', correct }];
    const status = correct ? 'won' : guesses.length >= 3 ? 'lost' : 'playing';
    const nextRound = { ...round, guesses, status };
    return { round: nextRound, correct, finished: status !== 'playing', duplicate: false };
  }

  function nonnegativeInteger(value) {
    return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  }

  /**
   * Settle finished rounds exactly once across ordinary storage/re-render cycles.
   * Persist BOTH returned objects. History guards stale round settlement as well.
   * stats fields: currentStreak,bestStreak,played,won,lastSettledRoundId,settledRoundIds.
   * Extra caller-owned stats fields are preserved.
   */
  function settleStats(stats, round) {
    const initial = stats && typeof stats === 'object' ? stats : {};
    const nextStats = { ...initial, currentStreak: nonnegativeInteger(initial.currentStreak), bestStreak: nonnegativeInteger(initial.bestStreak), played: nonnegativeInteger(initial.played), won: nonnegativeInteger(initial.won) };
    nextStats.bestStreak = Math.max(nextStats.bestStreak, nextStats.currentStreak);
    const settled = Array.isArray(initial.settledRoundIds) ? initial.settledRoundIds.filter(id => typeof id === 'string').slice(-999) : [];
    if (!round || !['won', 'lost'].includes(round.status)) return { stats: nextStats, round };
    if (round.credited || initial.lastSettledRoundId === round.id || settled.includes(round.id)) {
      return { stats: nextStats, round: { ...round, credited: true } };
    }
    nextStats.played += 1;
    if (round.status === 'won') {
      nextStats.won += 1;
      nextStats.currentStreak += 1;
      nextStats.bestStreak = Math.max(nextStats.bestStreak, nextStats.currentStreak);
    } else nextStats.currentStreak = 0;
    nextStats.lastSettledRoundId = round.id;
    nextStats.settledRoundIds = [...settled, round.id];
    return { stats: nextStats, round: { ...round, credited: true } };
  }

  /** Return an unseen album, or start a fresh cycle when every album has been seen. */
  function selectNextAlbum(pool, seenIds = [], rng = Math.random) {
    if (!Array.isArray(pool) || !pool.length) return null;
    const seen = seenIds instanceof Set ? seenIds : new Set(Array.isArray(seenIds) ? seenIds : []);
    const unseen = pool.filter(album => !seen.has(album.id));
    const choices = unseen.length ? unseen : pool;
    return choices[randomIndex(choices.length, rng)];
  }

  function editDistance(left, right, ceiling) {
    if (Math.abs(left.length - right.length) > ceiling) return ceiling + 1;
    let previous = Array.from({ length: right.length + 1 }, (_, i) => i);
    for (let i = 1; i <= left.length; i += 1) {
      const row = [i];
      for (let j = 1; j <= right.length; j += 1) {
        row[j] = Math.min(row[j - 1] + 1, previous[j] + 1, previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1));
      }
      if (Math.min(...row) > ceiling) return ceiling + 1;
      previous = row;
    }
    return previous[right.length];
  }

  /** Ranked catalog suggestions by title, aliases, artist, then small spelling errors. */
  function searchAlbums(catalog, query, limit = 7) {
    const term = normalize(query);
    if (!term) return [];
    const compactTerm = term.replace(/\s/g, '');
    const matches = [];
    for (const album of (Array.isArray(catalog) ? catalog : [])) {
      const titles = [album.title, ...(Array.isArray(album.aliases) ? album.aliases : [])].map(normalize);
      const artist = normalize(album.artist);
      let score = Infinity;
      for (const title of titles) {
        if (title === term || title.replace(/\s/g, '') === compactTerm) score = Math.min(score, 0);
        else if (title.startsWith(term)) score = Math.min(score, 10 + (title.length - term.length) / 100);
        else if (title.includes(term)) score = Math.min(score, 20 + title.indexOf(term) / 100);
      }
      if (artist.startsWith(term)) score = Math.min(score, 30);
      else if (artist.includes(term) || titles.some(title => `${title} ${artist}`.includes(term))) score = Math.min(score, 35);
      if (score === Infinity && compactTerm.length >= 3) {
        const tolerance = compactTerm.length >= 6 ? 2 : 1;
        const candidates = [...titles.map(title => title.replace(/\s/g, '')), artist.replace(/\s/g, '')];
        for (const candidate of candidates) {
          const distance = editDistance(compactTerm, candidate, tolerance);
          if (distance <= tolerance) score = Math.min(score, 40 + distance);
        }
      }
      if (Number.isFinite(score)) matches.push({ album, score });
    }
    return matches.sort((left, right) => left.score - right.score ||
      (Number.isFinite(left.album.rank) ? left.album.rank : Infinity) - (Number.isFinite(right.album.rank) ? right.album.rank : Infinity) ||
      String(left.album.title).localeCompare(String(right.album.title))
    ).slice(0, Math.max(0, nonnegativeInteger(limit))).map(match => match.album);
  }

  return Object.freeze({ MAX_POOL_SIZE, DIFFICULTY_LIMITS, normalize, normalizeDifficulty, normalizeDecade, normalizeDecades, snapshotSettings, albumDecade, availableDecades, contributors, eligibleAlbums, revealCounts, visibleContributors, shuffle, createRound, submitGuess, settleStats, selectNextAlbum, searchAlbums });
});
