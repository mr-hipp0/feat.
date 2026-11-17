(function () {
  'use strict';
  const E = globalThis.FEAT_ENGINE;
  const $ = id => document.getElementById(id);
  const STORAGE_KEY = 'feat.album-game.v1';
  const GENRES = { all: 'All genres', 'hip-hop': 'Hip-hop', rnb: 'R&B', pop: 'Pop', rock: 'Rock', latin: 'Latin', electronic: 'Electronic', country: 'Country' };
  const ROLES = { guest: 'Guest', producer: 'Producer', songwriter: 'Songwriter' };
  const DIFFICULTIES = {
    easy: { label: 'Easy', caption: 'Top 50', description: 'Up to 50 of the most-streamed albums matching your filters.' },
    medium: { label: 'Medium', caption: 'Top 200', description: 'Up to 200 albums matching your filters, including every Easy album.' },
    hard: { label: 'Hard', caption: 'Everything', description: 'Every matching album, from huge hits to deeper cuts. Includes Easy and Medium.' }
  };
  const rawCatalog = [...(globalThis.FEAT_CATALOG_A || []), ...(globalThis.FEAT_CATALOG_B || []), ...(globalThis.FEAT_CATALOG_EXPANDED || [])];
  const catalog = [...new Map(rawCatalog.filter(a => a && typeof a.id === 'string' && typeof a.title === 'string').sort((a, b) => (a.rank || Infinity) - (b.rank || Infinity)).map(a => [a.id, a])).values()];
  const albumById = new Map(catalog.map(a => [a.id, a]));
  let state = { version: 1, revision: 0, settings: { producers: false, songwriters: false, decades: [], difficulty: 'hard', autoplay: true, volume: .25 }, genre: 'all', stats: { currentStreak: 0, bestStreak: 0, played: 0, won: 0 }, seenIds: [], round: null };
  let chosenId = null;
  let suggestions = [];
  let selectedOption = -1;
  let previousVisible = 0;
  let storageAvailable = true;
  let isNewRecord = false;
  let renderedRoundId = null;
  let resultDismissedRoundId = null;
  let preparedAudioRoundId = null;
  let player = null;

  const decadeLabel = decade => decade === 'all' ? 'All decades' : `${decade}s`;
  const decadesLabel = decades => decades.length ? decades.map(decadeLabel).join(' + ') : 'All decades';
  const albumCountLabel = count => `${count} playable ${count === 1 ? 'album' : 'albums'}`;
  function audioPreferences(settings) {
    return { autoplay: typeof settings?.autoplay === 'boolean' ? settings.autoplay : true, volume: Number.isFinite(settings?.volume) ? Math.min(1, Math.max(0, settings.volume)) : .25 };
  }

  function safeUrl(value) {
    try { const url = new URL(value); return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null; } catch { return null; }
  }
  function albumCoverUrl(album) {
    const cover = album.coverUrl || globalThis.FEAT_ARTWORK?.[album.id]?.coverUrl;
    return /^covers\/[a-z0-9._-]+$/i.test(cover || '') ? new URL(cover, location.href).href : safeUrl(cover);
  }
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }
  function integer(value) { return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0; }
  function storageNotice() { $('storage-notice').hidden = storageAvailable; }
  function persist() {
    state.revision = Math.max(state.revision + 1, Date.now());
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { storageAvailable = false; storageNotice(); }
  }
  function restore() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (!saved || saved.version !== 1) return;
      state.revision = integer(saved.revision);
      state.round = null;
      state.settings = { ...E.snapshotSettings(saved.settings), ...audioPreferences(saved.settings) };
      state.genre = Object.hasOwn(GENRES, saved.genre) ? saved.genre : 'all';
      const stats = saved.stats || {};
      state.stats = { currentStreak: integer(stats.currentStreak), bestStreak: Math.max(integer(stats.bestStreak), integer(stats.currentStreak)), played: integer(stats.played), won: integer(stats.won), lastSettledRoundId: typeof stats.lastSettledRoundId === 'string' ? stats.lastSettledRoundId : null, settledRoundIds: Array.isArray(stats.settledRoundIds) ? stats.settledRoundIds.filter(x => typeof x === 'string').slice(-1000) : [] };
      state.seenIds = Array.isArray(saved.seenIds) ? [...new Set(saved.seenIds.filter(id => albumById.has(id)))] : [];
      const r = saved.round, album = r && albumById.get(r.albumId);
      if (!album || typeof r.id !== 'string' || !Array.isArray(r.guesses) || r.guesses.length > 3 || !Array.isArray(r.clueOrder)) return;
      const settings = E.snapshotSettings(r.settings);
      const people = E.contributors(album, settings);
      const peopleMap = new Map(people.map(p => [E.normalize(p.canonicalName), p]));
      const order = r.clueOrder.map(p => peopleMap.get(E.normalize(p.canonicalName || p.name)));
      if (people.length < 3 || order.some(p => !p) || new Set(order).size !== people.length || order.length !== people.length) return;
      const guesses = [];
      for (const g of r.guesses) {
        if (!g || !['guess', 'skip', 'give-up'].includes(g.kind)) return;
        if (g.kind === 'give-up' && guesses.length !== 2) return;
        if (g.kind === 'guess' && (!albumById.has(g.albumId) || guesses.some(x => x.albumId === g.albumId))) return;
        if (guesses.some(x => x.correct)) return;
        guesses.push({ albumId: g.kind !== 'guess' ? null : g.albumId, kind: g.kind, correct: g.kind === 'guess' && g.albumId === album.id });
      }
      const status = guesses.some(g => g.correct) ? 'won' : guesses.length === 3 ? 'lost' : 'playing';
      state.round = { id: r.id, albumId: album.id, genre: Object.hasOwn(GENRES, r.genre) ? r.genre : state.genre, settings, clueOrder: order, guesses, status, credited: Boolean(r.credited) };
      if (status !== 'playing') {
        const settled = E.settleStats(state.stats, state.round);
        state.stats = settled.stats; state.round = settled.round;
      }
    } catch (error) { if (!(error instanceof SyntaxError)) { storageAvailable = false; storageNotice(); } }
  }
  function syncLatest() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (saved?.version !== 1 || integer(saved.revision) <= state.revision) return false;
      const focus = settingsFocus();
      restore(); chosenId = null; $('album-search').value = ''; closeSuggestions();
      if (!roundMatchesPreferences() && (state.round || pool().length)) startRound({ synchronize: false }); else render();
      if ($('settings-dialog').open) renderSettings(focus);
      return true;
    } catch { return false; }
  }
  function pool(settings = state.settings, genre = state.genre) { return E.eligibleAlbums(catalog, settings, genre); }
  function sameGameSettings(left, right) {
    return JSON.stringify(E.snapshotSettings(left)) === JSON.stringify(E.snapshotSettings(right));
  }
  function roundMatchesPreferences() {
    return state.round && state.genre === state.round.genre && sameGameSettings(state.settings, state.round.settings);
  }
  function renderPreferences() {
    const genreOptions = $('genre-options');
    const focusedGenre = genreOptions.contains(document.activeElement) ? document.activeElement.dataset.genre : null;
    genreOptions.replaceChildren();
    Object.entries(GENRES).forEach(([id, label]) => {
      if (id !== 'all' && !catalog.some(a => (a.genres || []).includes(id))) return;
      const count = pool(state.settings, id).length;
      const option = element('button', 'genre-option');
      option.type = 'button'; option.dataset.genre = id; option.setAttribute('role', 'menuitemradio');
      option.setAttribute('aria-checked', String(id === state.genre));
      option.setAttribute('aria-label', `${label}, ${albumCountLabel(count)}`);
      option.tabIndex = id === state.genre ? 0 : -1;
      const marker = element('span', 'genre-option-marker'); marker.setAttribute('aria-hidden', 'true');
      const check = element('span', 'genre-option-check', '✓'); check.setAttribute('aria-hidden', 'true');
      option.append(marker, element('span', 'genre-option-label', label), element('span', 'genre-option-count', String(count)), check);
      option.addEventListener('click', () => changeGenre(id));
      genreOptions.append(option);
    });
    $('genre-label').textContent = GENRES[state.genre];
    $('genre-count').textContent = pool().length;
    $('genre-select').setAttribute('aria-label', `Album genre: ${GENRES[state.genre]}, ${albumCountLabel(pool().length)}`);
    if (focusedGenre && !$('genre-menu').hidden) {
      const option = [...genreOptions.children].find(node => node.dataset.genre === focusedGenre);
      option?.focus();
    }
    const count = pool().length;
    const tier = DIFFICULTIES[state.settings.difficulty].label;
    $('pool-label').textContent = `Unlimited · ${albumCountLabel(count)} · ${tier}${state.settings.decades.length ? ` · ${decadesLabel(state.settings.decades)}` : ''}`;
    $('catalog-size').textContent = `${catalog.length} albums on the shelves`;
    $('settings-dot').hidden = !state.settings.producers && !state.settings.songwriters && !state.settings.decades.length && state.settings.difficulty === 'hard';
    $('current-streak').textContent = state.stats.currentStreak;
    $('best-streak').textContent = state.stats.bestStreak;
  }
  function closeGenreMenu(returnFocus = false) {
    $('genre-menu').hidden = true;
    $('genre-select').setAttribute('aria-expanded', 'false');
    if (returnFocus) $('genre-select').focus({ preventScroll: true });
  }
  function openGenreMenu(edge) {
    closeSuggestions();
    $('genre-menu').hidden = false;
    $('genre-select').setAttribute('aria-expanded', 'true');
    const options = [...$('genre-options').children];
    const target = edge === 'last' ? options.at(-1) : edge === 'first' ? options[0] : options.find(node => node.dataset.genre === state.genre);
    options.forEach(option => { option.tabIndex = option === target ? 0 : -1; });
    target?.focus();
  }
  function changeGenre(genre) {
    closeGenreMenu(true);
    applyGameplayChange({}, genre);
  }
  function startRound({ synchronize = true } = {}) {
    if (synchronize && syncLatest() && state.round?.status === 'playing') return;
    stopReveal();
    resultDismissedRoundId = null; preparedAudioRoundId = null;
    chosenId = null; $('album-search').value = ''; previousVisible = 0; isNewRecord = false;
    closeSuggestions();
    const available = pool();
    if (!available.length) {
      state.round = null;
      persist(); render(); return;
    }
    let seen = state.seenIds;
    const previousId = state.round?.albumId;
    if (available.every(a => seen.includes(a.id))) {
      const poolIds = new Set(available.map(a => a.id));
      seen = seen.filter(id => !poolIds.has(id));
      if (available.length > 1 && previousId) seen.push(previousId);
    }
    const album = E.selectNextAlbum(available, seen);
    state.round = E.createRound(album, state.settings);
    state.round.genre = state.genre;
    state.seenIds = [...new Set([...seen, album.id])];
    persist(); render();
  }
  function renderClues(animate) {
    const round = state.round;
    const total = round.clueOrder.length;
    const stage = round.status === 'playing' ? Math.min(round.guesses.length, 2) : 2;
    const count = E.revealCounts(total)[stage];
    $('clue-count').textContent = `${count} of ${total} collaborators revealed`;
    const mode = ['Guest artists', ...(round.settings.producers ? ['Producers'] : []), ...(round.settings.songwriters ? ['Songwriters'] : [])];
    $('credit-mode').textContent = mode.join(' + ');
    const clues = $('clues'); clues.replaceChildren(); clues.classList.toggle('is-dense', count > 9);
    round.clueOrder.slice(0, count).forEach((person, i) => {
      const chip = element('div', 'clue-chip');
      if (animate && i >= previousVisible) { chip.classList.add('is-new'); chip.style.animationDelay = `${Math.min(i - previousVisible, 7) * 25}ms`; }
      chip.append(element('span', 'clue-name', person.name), element('span', 'clue-role', person.roles.map(role => ROLES[role]).join(' + ')));
      clues.append(chip);
    });
    previousVisible = count;
    document.querySelectorAll('.reveal-stage').forEach((node, i) => {
      node.classList.toggle('is-active', i <= stage);
      if (i === stage) node.setAttribute('aria-current', 'step'); else node.removeAttribute('aria-current');
    });
  }
  function renderHistory() {
    $('guess-history').replaceChildren();
    state.round.guesses.forEach((g, i) => {
      const row = element('li', g.correct ? 'is-correct' : '');
      row.append(element('span', 'guess-number', String(i + 1)));
      if (g.kind === 'skip' || g.kind === 'give-up') row.append(element('span', 'guess-title', g.kind === 'give-up' ? 'Gave up' : 'Skipped a guess'));
      else {
        const album = albumById.get(g.albumId);
        const text = element('span', 'guess-text');
        text.append(element('span', 'guess-title', album?.title || 'Unknown album'), element('span', 'guess-artist', `— ${album?.artist || ''}`)); row.append(text);
      }
      const mark = element('span', 'guess-mark', g.correct ? '✓' : '×'); mark.setAttribute('aria-label', g.correct ? 'Correct' : g.kind === 'give-up' ? 'Gave up' : g.kind === 'skip' ? 'Skipped' : 'Incorrect'); row.append(mark);
      $('guess-history').append(row);
    });
  }
  function stopReveal() {
    player?.stop();
    preparedAudioRoundId = null;
    if ($('result').open) $('result').close();
    document.body.classList.remove('result-open');
  }
  function dismissResult() {
    resultDismissedRoundId = state.round?.id;
    stopReveal();
    $('show-result').focus({ preventScroll: true });
  }
  function openResult({ userInitiated = false, restored = false } = {}) {
    if (!state.round || state.round.status === 'playing') return;
    const otherDialog = [...document.querySelectorAll('dialog[open]')].some(dialog => dialog.id !== 'result');
    if (otherDialog) return;
    resultDismissedRoundId = null;
    if (!$('result').open) { $('result').showModal(); $('result').scrollTop = 0; document.body.classList.add('result-open'); $('next-album').focus({ preventScroll: true }); }
    const album = albumById.get(state.round.albumId);
    if (player && preparedAudioRoundId !== state.round.id) {
      preparedAudioRoundId = state.round.id;
      player.setAlbum(album, { autoplay: state.settings.autoplay, volume: state.settings.volume, userInitiated, restored });
    }
  }
  function renderResult({ userInitiated = false, restored = false } = {}) {
    const round = state.round, album = albumById.get(round.albumId), won = round.status === 'won';
    if (round.status === 'playing') { stopReveal(); return; }
    $('result').classList.toggle('is-win', won); $('result').classList.toggle('is-loss', !won);
    $('result-kicker').textContent = won ? 'THAT’S THE RECORD.' : 'IT WAS…';
    $('outcome-stamp').textContent = won ? 'FOUND IT!' : round.guesses.at(-1)?.kind === 'give-up' ? 'GAVE UP' : 'NEXT TIME.';
    $('answer-title').textContent = album.title;
    $('answer-artist').textContent = `${album.artist}${album.originalReleaseYear || album.year ? ` · ${album.originalReleaseYear || album.year}` : ''}`;
    $('result-streak').textContent = won ? `🔥 ${state.stats.currentStreak} in a row · Best ${state.stats.bestStreak}` : `Fresh start. · Best streak ${state.stats.bestStreak}`;
    $('record-message').hidden = !isNewRecord;
    $('art-initials').textContent = album.title.replace(/[^a-zA-Z0-9 ]/g, '').split(' ').map(x => x[0]).slice(0, 4).join('');
    const image = $('cover-image'), cover = albumCoverUrl(album);
    if (cover && image.dataset.album !== album.id) {
      image.dataset.album = album.id; image.hidden = true;
      image.onload = () => { image.hidden = false; };
      image.onerror = () => { image.hidden = true; };
      image.referrerPolicy = 'no-referrer'; image.src = cover;
    } else if (!cover) { image.hidden = true; image.removeAttribute('src'); image.dataset.album = album.id; }
    else if (image.complete && image.naturalWidth > 0) image.hidden = false;
    if (resultDismissedRoundId !== round.id) openResult({ userInitiated, restored });
  }
  function render(animate = false, resultOptions = {}) {
    renderPreferences();
    const round = state.round;
    $('empty-state').hidden = Boolean(round); $('round-panel').hidden = !round;
    if (!round) {
      stopReveal();
      $('empty-message').textContent = catalog.length ? `No albums match ${GENRES[state.genre].toLowerCase()}, ${decadesLabel(state.settings.decades).toLowerCase()}, and these credits. Try All decades, another genre, or more credit types.` : 'The album catalog could not load. Refresh to try again.';
      return;
    }
    if (renderedRoundId !== round.id) { renderedRoundId = round.id; previousVisible = 0; $('cover-image').hidden = true; }
    renderClues(animate); renderHistory(); renderResult(resultOptions);
    const playing = round.status === 'playing';
    $('album-search').disabled = !playing; $('guess-button').disabled = !playing || !chosenId;
    $('guess-form').hidden = !playing; $('skip-guess').hidden = !playing;
    $('finished-actions').hidden = playing;
    const finalGuess = playing && round.guesses.length === 2;
    $('skip-label').textContent = finalGuess ? 'Give up' : 'Skip a guess';
    $('give-up-icon').toggleAttribute('hidden', !finalGuess); $('skip-arrow').hidden = finalGuess;
    $('skip-guess').classList.toggle('give-up', finalGuess);
    $('guess-status-row')?.classList.toggle('finished', !playing);
    $('guess-status').textContent = playing ? round.guesses.length === 0 ? '3 guesses. Trust your music taste.' : `${3 - round.guesses.length} ${round.guesses.length === 2 ? 'guess' : 'guesses'} left. A few more familiar faces.` : wonMessage(round);
    storageNotice();
  }
  function wonMessage(round) { return round.status === 'won' ? `Solved in ${round.guesses.length}/3. Keep it going.` : 'Three tries down. Another record awaits.'; }
  function closeSuggestions() {
    $('search-options').hidden = true; $('search-options').replaceChildren();
    $('album-search').setAttribute('aria-expanded', 'false'); $('album-search').removeAttribute('aria-activedescendant'); selectedOption = -1;
  }
  function showSuggestions() {
    const input = $('album-search'), query = input.value.trim();
    chosenId = null; $('guess-button').disabled = true;
    closeSuggestions();
    if (!query || state.round?.status !== 'playing') return;
    suggestions = E.searchAlbums(catalog, query, 7);
    const list = $('search-options'); list.hidden = false; input.setAttribute('aria-expanded', 'true');
    if (!suggestions.length) { list.append(element('p', 'search-empty', 'No match in this trial. Try an album title or artist.')); return; }
    suggestions.forEach((album, i) => {
      const option = element('button', 'search-option'); option.type = 'button'; option.id = `album-option-${i}`; option.setAttribute('role', 'option'); option.setAttribute('aria-selected', 'false');
      const used = state.round.guesses.some(g => g.albumId === album.id);
      const artwork = element('span', 'option-cover'); artwork.setAttribute('aria-hidden', 'true');
      artwork.append(element('span', 'option-cover-record'));
      const cover = albumCoverUrl(album);
      if (cover) {
        const image = document.createElement('img');
        image.alt = ''; image.width = 44; image.height = 44;
        image.loading = 'lazy'; image.decoding = 'async'; image.referrerPolicy = 'no-referrer';
        image.onerror = () => { image.hidden = true; };
        image.src = cover; artwork.append(image);
      }
      const copy = element('span', 'option-copy');
      copy.append(element('span', 'option-title', album.title), element('span', 'option-artist', `${album.artist}${used ? ' · tried' : ''}`));
      const arrow = element('span', 'option-arrow', '↗'); arrow.setAttribute('aria-hidden', 'true');
      option.append(artwork, copy, arrow);
      if (used) option.classList.add('option-used');
      option.addEventListener('click', () => chooseSuggestion(album));
      option.addEventListener('pointerenter', () => highlightOption(i));
      list.append(option);
    });
  }
  function highlightOption(index, scroll = false) {
    const nodes = $('search-options').querySelectorAll('[role="option"]');
    if (!nodes.length) return;
    selectedOption = (index + nodes.length) % nodes.length;
    nodes.forEach((node, i) => node.setAttribute('aria-selected', String(i === selectedOption)));
    $('album-search').setAttribute('aria-activedescendant', nodes[selectedOption].id);
    if (scroll) nodes[selectedOption].scrollIntoView({ block: 'nearest' });
  }
  function chooseSuggestion(album) {
    chosenId = album.id; $('album-search').value = album.title; closeSuggestions(); $('guess-button').disabled = false; $('album-search').focus();
  }
  function celebrate() {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const scoreboard = document.querySelector('.score'); scoreboard.classList.remove('bump'); void scoreboard.offsetWidth; scoreboard.classList.add('bump');
    const holder = $('celebration'); holder.replaceChildren();
    for (let i = 0; i < 20; i++) {
      const bit = element('span', 'confetti'); bit.style.setProperty('--x', `${(Math.random() - .5) * 450}px`); bit.style.setProperty('--y', `${Math.random() * 140 - 210}px`); bit.style.setProperty('--r', `${Math.random() * 500}deg`); bit.style.animationDelay = `${Math.random() * 90}ms`; if (i % 3 === 0) bit.style.background = 'var(--ink)'; holder.append(bit);
    }
    setTimeout(() => holder.replaceChildren(), 1400);
  }
  function submit(skipped = false) {
    if (!state.round || state.round.status !== 'playing' || (!skipped && !chosenId)) return;
    // Adopt newer progress before a stale tab can overwrite a completed round.
    if (syncLatest()) { $('guess-status').textContent = 'Updated from your other tab. Your progress is in sync.'; return; }
    const result = E.submitGuess(state.round, skipped ? state.round.guesses.length === 2 ? 'give-up' : 'skip' : chosenId);
    if (result.duplicate) { $('guess-status').textContent = 'You already tried that album. Pick another—no guess used.'; return; }
    const previousBest = state.stats.bestStreak;
    state.round = result.round;
    if (result.finished) { const settled = E.settleStats(state.stats, state.round); state.stats = settled.stats; state.round = settled.round; isNewRecord = result.correct && state.stats.bestStreak > previousBest; }
    chosenId = null; $('album-search').value = ''; closeSuggestions(); persist(); render(true, { userInitiated: true });
    if (result.correct) celebrate();
    if (result.finished) $('next-album').focus({ preventScroll: true }); else $('album-search').focus({ preventScroll: true });
  }
  function openDialog(id) { closeSuggestions(); closeGenreMenu(); $(id).showModal(); }
  function openSettings() {
    syncLatest(); renderSettings(); openDialog('settings-dialog');
  }
  function settingsFocus() {
    const active = document.activeElement;
    if (!$('settings-dialog').contains(active)) return {};
    return { decade: active.dataset.decade, difficulty: active.dataset.difficulty, id: active.id };
  }
  function renderSettings(focus = {}) {
    $('producer-toggle').checked = state.settings.producers; $('songwriter-toggle').checked = state.settings.songwriters;
    $('autoplay-toggle').checked = state.settings.autoplay; $('volume-setting').value = Math.round(state.settings.volume * 100);
    $('volume-label').textContent = `${$('volume-setting').value}%`;
    renderDifficultyOptions();
    renderDecadeOptions();
    updateSettingsSummary();
    const target = focus.decade ? [...$('decade-options').children].find(button => button.dataset.decade === focus.decade) : focus.difficulty ? [...$('difficulty-options').children].find(button => button.dataset.difficulty === focus.difficulty) : focus.id ? $(focus.id) : null;
    target?.focus({ preventScroll: true });
  }
  function applyGameplayChange(patch = {}, genre, focus = settingsFocus()) {
    syncLatest();
    const changes = typeof patch === 'function' ? patch(state.settings) : patch;
    const nextSettings = { ...state.settings, ...E.snapshotSettings({ ...state.settings, ...changes }) };
    const nextGenre = genre ?? state.genre;
    if (nextGenre !== state.genre || !sameGameSettings(nextSettings, state.settings)) {
      state.settings = nextSettings; state.genre = nextGenre;
      // Refresh without settling the abandoned round or resetting its streak.
      startRound({ synchronize: false });
    }
    if ($('settings-dialog').open) renderSettings(focus);
  }
  function applyAudioChange(patch) {
    const focus = settingsFocus(); syncLatest();
    const next = audioPreferences({ ...state.settings, ...patch });
    if (next.autoplay !== state.settings.autoplay || next.volume !== state.settings.volume) {
      state.settings = { ...state.settings, ...next }; persist();
      player?.setEnabled(next.autoplay); player?.setVolume(next.volume);
    }
    if ($('settings-dialog').open) renderSettings(focus);
  }
  function renderDifficultyOptions() {
    const root = $('difficulty-options'); root.replaceChildren();
    for (const [difficulty, details] of Object.entries(DIFFICULTIES)) {
      const button = element('button', 'difficulty-option'); button.type = 'button'; button.dataset.difficulty = difficulty;
      button.setAttribute('role', 'radio'); button.setAttribute('aria-checked', String(difficulty === state.settings.difficulty)); button.tabIndex = difficulty === state.settings.difficulty ? 0 : -1;
      button.append(element('strong', '', details.label), element('span', '', details.caption));
      button.addEventListener('click', () => applyGameplayChange({ difficulty }));
      root.append(button);
    }
  }
  function renderDecadeOptions() {
    const root = $('decade-options'); root.replaceChildren();
    const choices = E.normalizeDecades([...E.availableDecades(catalog), ...state.settings.decades]);
    $('all-decades').setAttribute('aria-pressed', String(!state.settings.decades.length));
    for (const decade of choices) {
      const button = element('button', 'decade-option'); button.type = 'button'; button.dataset.decade = decade;
      button.setAttribute('aria-pressed', String(state.settings.decades.includes(decade)));
      const count = pool({ ...state.settings, decades: [decade] }).length;
      const marker = element('span', 'decade-check', '✓'); marker.setAttribute('aria-hidden', 'true');
      button.append(marker, element('span', '', decadeLabel(decade)));
      button.setAttribute('aria-label', `${decadeLabel(decade)}, ${albumCountLabel(count)}`);
      button.title = `${decadeLabel(decade)} · ${albumCountLabel(count)}`;
      button.addEventListener('click', () => applyGameplayChange(settings => ({ decades: settings.decades.includes(decade) ? settings.decades.filter(value => value !== decade) : [...settings.decades, decade] })));
      root.append(button);
    }
  }
  function updateSettingsSummary() {
    const count = pool().length;
    $('settings-pool-count').textContent = `${albumCountLabel(count)} · ${DIFFICULTIES[state.settings.difficulty].label} · ${GENRES[state.genre]} · ${decadesLabel(state.settings.decades)}`;
    $('difficulty-help').textContent = DIFFICULTIES[state.settings.difficulty].description;
    for (const button of $('difficulty-options').children) {
      const difficulty = button.dataset.difficulty, details = DIFFICULTIES[difficulty];
      button.setAttribute('aria-label', `${details.label}, ${details.caption}, ${albumCountLabel(pool({ ...state.settings, difficulty }).length)}`);
    }
  }
  function showCredits() {
    const album = albumById.get(state.round?.albumId); if (!album || state.round.status === 'playing') return;
    $('credits-title').textContent = `${album.title} — ${album.artist}`;
    $('credits-edition').textContent = `${album.edition || 'Standard edition'}${album.year ? ` · ${album.year}` : ''}. Credits used for your selected settings.`;
    $('credits-list').replaceChildren();
    E.contributors(album, state.round.settings).sort((a, b) => a.name.localeCompare(b.name)).forEach(person => {
      const row = element('li'); row.append(element('strong', '', person.name), element('span', '', person.roles.map(r => ROLES[r]).join(' + '))); $('credits-list').append(row);
    });
    $('credits-sources').replaceChildren();
    [...new Set([...(album.sources || []), ...E.contributors(album, state.round.settings).flatMap(p => p.sources)])].forEach((source, i) => {
      const url = safeUrl(source); if (!url) return;
      const link = element('a', '', `${new URL(url).hostname.replace(/^www\./, '')} — credit source ${i + 1} ↗`); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; $('credits-sources').append(link);
    });
    const artworkSource = safeUrl(globalThis.FEAT_ARTWORK?.[album.id]?.coverSource || album.coverSource);
    if (artworkSource) {
      const link = element('a', '', 'Album artwork & attribution ↗'); link.href = artworkSource; link.target = '_blank'; link.rel = 'noopener noreferrer'; $('credits-sources').append(link);
    }
    openDialog('credits-dialog');
  }
  function renderAbout() {
    const section = $('catalog-details'); section.replaceChildren(); section.append(element('h3', '', 'A collection with a date stamp'));
    const metadata = globalThis.FEAT_CATALOG_META || {};
    const firstSnapshot = metadata.rankingSnapshotRetrievedAt || metadata.retrievedAt || catalog.find(a => a.rankingRetrievedAt)?.rankingRetrievedAt;
    const snapshot = new Date(firstSnapshot);
    const snapshotDate = Number.isFinite(snapshot.getTime()) ? new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', month: 'long', day: 'numeric', year: 'numeric' }).format(snapshot) : null;
    const guestOnlyCount = catalog.filter(album => E.contributors(album, {}).length >= 3).length;
    const description = `${catalog.length} albums, including ${guestOnlyCount} that qualify with guests alone. Popularity comes from dated public streaming references${snapshotDate ? `, retrieved ${snapshotDate}` : ''}. ${metadata.coverageSummary || 'The catalog combines reviewed album families from the available ranking coverage; it is not a live or exhaustive global ranking.'} Genre tags are broad editorial labels. After genre, release decades, and credit types are combined, Easy selects up to 50 albums by total streams, Medium includes the top 200, and Hard includes every matching album. The pools build on each other.`;
    section.append(element('p', '', description));
  }
  async function shareResult() {
    const round = state.round; if (!round || round.status === 'playing') return;
    const marks = round.guesses.map(g => g.correct ? '🟩' : g.kind === 'give-up' ? '🏳️' : g.kind === 'skip' ? '⬜' : '🟥').join('');
    const text = `FEAT. ${round.status === 'won' ? `${round.guesses.length}/3` : 'X/3'}\n${marks}\n🔥 Streak ${state.stats.currentStreak} · Best ${state.stats.bestStreak}\n${location.origin}${location.pathname}`;
    try { await navigator.clipboard.writeText(text); $('share-result').textContent = 'Copied ✓'; setTimeout(() => { $('share-result').textContent = 'Copy result ↗'; }, 2200); }
    catch { $('share-result').textContent = 'Copy unavailable'; }
  }

  $('guess-form').addEventListener('submit', event => { event.preventDefault(); submit(); });
  $('album-search').addEventListener('input', showSuggestions);
  $('album-search').addEventListener('keydown', event => {
    if (event.key === 'Escape') closeSuggestions();
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !$('search-options').hidden && suggestions.length) { event.preventDefault(); highlightOption(selectedOption === -1 ? event.key === 'ArrowDown' ? 0 : suggestions.length - 1 : selectedOption + (event.key === 'ArrowDown' ? 1 : -1), true); }
    if (event.key === 'Enter' && !chosenId && !$('search-options').hidden && suggestions.length) { event.preventDefault(); chooseSuggestion(suggestions[Math.max(0, selectedOption)]); }
  });
  $('search-options').addEventListener('keydown', event => {
    const nodes = [...$('search-options').querySelectorAll('[role="option"]')]; const at = nodes.indexOf(document.activeElement);
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && nodes.length) { event.preventDefault(); const next = (at + (event.key === 'ArrowDown' ? 1 : -1) + nodes.length) % nodes.length; nodes[next].focus(); highlightOption(next, true); }
    if (event.key === 'Escape') { closeSuggestions(); $('album-search').focus(); }
  });
  document.addEventListener('click', event => {
    if (!$('guess-form').contains(event.target)) closeSuggestions();
    if (!$('genre-control').contains(event.target)) closeGenreMenu();
  });
  $('skip-guess').addEventListener('click', () => submit(true));
  $('next-album').addEventListener('click', () => { startRound(); if (state.round) $('album-search').focus({ preventScroll: true }); });
  $('next-from-clues').addEventListener('click', () => { startRound(); if (state.round) $('album-search').focus({ preventScroll: true }); });
  $('show-result').addEventListener('click', () => openResult({ userInitiated: true }));
  $('view-clues').addEventListener('click', dismissResult);
  $('result').addEventListener('cancel', event => { event.preventDefault(); dismissResult(); });
  $('result').addEventListener('close', () => { document.body.classList.remove('result-open'); player?.stop(); preparedAudioRoundId = null; });
  $('genre-select').addEventListener('click', () => {
    if ($('genre-menu').hidden) openGenreMenu(); else closeGenreMenu();
  });
  $('genre-select').addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); openGenreMenu(event.key === 'ArrowUp' ? 'last' : 'first'); }
    if (event.key === 'Escape') { event.preventDefault(); closeGenreMenu(true); }
  });
  $('genre-menu').addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeGenreMenu(true); return; }
    if (event.key === 'Tab') { event.preventDefault(); closeGenreMenu(); (event.shiftKey ? $('genre-select') : $('how-to-button')).focus(); return; }
    const options = [...$('genre-options').children];
    const index = options.indexOf(document.activeElement);
    let next;
    if (event.key === 'ArrowDown') next = (index + 1) % options.length;
    else if (event.key === 'ArrowUp') next = (index - 1 + options.length) % options.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = options.length - 1;
    if (next != null && options.length) {
      event.preventDefault();
      options.forEach((option, i) => { option.tabIndex = i === next ? 0 : -1; });
      options[next].focus();
    }
  });
  $('settings-button').addEventListener('click', openSettings); $('empty-settings').addEventListener('click', openSettings);
  $('producer-toggle').addEventListener('change', event => applyGameplayChange({ producers: event.target.checked }));
  $('songwriter-toggle').addEventListener('change', event => applyGameplayChange({ songwriters: event.target.checked }));
  $('autoplay-toggle').addEventListener('change', event => applyAudioChange({ autoplay: event.target.checked }));
  $('volume-setting').addEventListener('input', event => applyAudioChange({ volume: Number(event.target.value) / 100 }));
  $('all-decades').addEventListener('click', () => applyGameplayChange({ decades: [] }));
  $('difficulty-options').addEventListener('keydown', event => {
    const choices = [...$('difficulty-options').children], current = choices.indexOf(document.activeElement);
    let next;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (current + 1) % choices.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (current - 1 + choices.length) % choices.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = choices.length - 1;
    if (next != null && choices.length) { event.preventDefault(); const difficulty = choices[next].dataset.difficulty; applyGameplayChange({ difficulty }, undefined, { difficulty }); }
  });
  $('decade-options').addEventListener('keydown', event => {
    const choices = [...$('decade-options').children], current = choices.indexOf(document.activeElement);
    let next;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (current + 1) % choices.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (current - 1 + choices.length) % choices.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = choices.length - 1;
    if (next != null && choices.length) { event.preventDefault(); choices[next].focus(); }
  });
  $('settings-done').addEventListener('click', () => $('settings-dialog').close());
  $('how-to-button').addEventListener('click', () => openDialog('how-to-dialog'));
  $('about-button').addEventListener('click', () => openDialog('about-dialog'));
  $('view-credits').addEventListener('click', showCredits); $('share-result').addEventListener('click', shareResult);
  document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => $(button.dataset.close).close()));
  document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', event => {
    if (event.target !== dialog) return; const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  }));
  document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('close', () => { if (!document.querySelector('dialog[open]')) syncLatest(); }));
  addEventListener('storage', event => {
    if (event.key !== STORAGE_KEY || !event.newValue || document.querySelector('dialog[open]')) return;
    syncLatest();
  });
  addEventListener('pagehide', () => { player?.stop(); preparedAudioRoundId = null; });
  addEventListener('pageshow', event => {
    if (event.persisted && $('result').open) openResult({ restored: true });
  });
  if (!E) { $('pool-label').textContent = 'The game could not load. Please refresh.'; return; }
  if (globalThis.FEAT_AUDIO?.create) player = globalThis.FEAT_AUDIO.create({ container: $('reveal-player') });
  restore(); renderAbout();
  if (!roundMatchesPreferences()) startRound(); else { render(false, { restored: true }); persist(); }
})();
