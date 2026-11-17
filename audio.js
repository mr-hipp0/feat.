/* FEAT. reveal audio. Official embeds own their playback controls and preview availability. */
(function (root, factory) {
  'use strict';
  const api = factory();
  root.FEAT_AUDIO = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const clampVolume = value => Math.min(1, Math.max(0, Number.isFinite(Number(value)) ? Number(value) : .3));
  function https(value) { try { const url = new URL(value); return url.protocol === 'https:' ? url.href : null; } catch { return null; } }
  function numericId(value) { return typeof value === 'string' || typeof value === 'number' ? /^[1-9]\d*$/.test(String(value)) ? String(value) : null : null; }
  function resolvePreview(album, mappings) {
    if (!album || typeof album.id !== 'string') return null;
    const rows = Array.isArray(mappings) ? mappings : Object.values(mappings || {});
    const row = album.preview || rows.find(item => item.albumId === album.id);
    const direct = album.directPreview || (row?.playback === 'direct' ? row : null);
    if (direct?.permittedForGame === true && https(direct.url) && https(direct.licenseSource)) {
      return { mode: 'direct', provider: direct.provider || 'licensed-preview', title: direct.trackTitle || album.title, url: https(direct.url), listeningUrl: https(direct.listeningUrl), maxSeconds: Math.min(30, Math.max(1, Number(direct.maxSeconds) || 30)), source: direct.licenseSource };
    }
    const id = numericId(row?.providerId || album.deezerTrackId || album.deezerAlbumId);
    if (!id || (row?.provider && row.provider !== 'deezer')) return null;
    const kind = row?.kind === 'track' || album.deezerTrackId ? 'track' : 'album';
    return { mode: 'official-embed', provider: 'deezer', providerId: id, kind, title: row?.trackTitle || album.title, listeningUrl: `https://www.deezer.com/${kind}/${id}`, source: row?.source || '' };
  }
  function widgetUrl(source) {
    if (source?.mode !== 'official-embed' || source.provider !== 'deezer' || !numericId(source.providerId) || !['album', 'track'].includes(source.kind)) return null;
    // Official documented player shape. No undocumented autoplay/control parameters.
    return `https://widget.deezer.com/widget/light/${source.kind}/${source.providerId}`;
  }
  function create({ container, onState, mappings, document: suppliedDocument } = {}) {
    if (!container || typeof container.replaceChildren !== 'function') throw new TypeError('A reveal-player container is required.');
    const doc = suppliedDocument || container.ownerDocument || globalThis.document;
    if (!doc) throw new TypeError('A document is required.');
    const make = (tag, className, text) => { const node = doc.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; };
    const heading = make('div', 'feat-audio-heading');
    const title = make('p', 'feat-audio-title');
    const provider = make('span', 'feat-audio-provider');
    heading.append(title, provider);
    const message = make('p', 'feat-audio-message'); message.setAttribute('aria-live', 'polite');
    const actions = make('div', 'feat-audio-actions');
    const playButton = make('button', 'feat-audio-btn', 'Open preview player'); playButton.type = 'button';
    const stopButton = make('button', 'feat-audio-btn feat-audio-secondary', 'Stop player'); stopButton.type = 'button'; stopButton.hidden = true;
    const link = make('a', 'feat-audio-link', 'Listen on Deezer ↗'); link.target = '_blank'; link.rel = 'noopener noreferrer';
    actions.append(playButton, stopButton, link);
    const playerHost = make('div', 'feat-audio-host');
    container.replaceChildren(heading, message, actions, playerHost);
    container.classList.add('feat-audio');
    let album = null, source = null, audio = null, frame = null, timeout = null, enabled = true, volume = .3, generation = 0, disposed = false;
    let state = { status: 'idle', albumId: null, provider: null, mode: null, title: '', listeningUrl: null, requiresInteraction: false, canControlVolume: false, message: '' };
    function emit(status, text) {
      state = { status, albumId: album?.id || null, provider: source?.provider || null, mode: source?.mode || null, title: source?.title || album?.title || '', listeningUrl: source?.listeningUrl || (album ? link.href || null : null), requiresInteraction: source?.mode === 'official-embed' || ['available', 'paused', 'error'].includes(status), canControlVolume: source?.mode === 'direct', message: text || '' };
      message.textContent = state.message;
      playButton.hidden = !source || Boolean(frame) || state.status === 'playing';
      playButton.textContent = source?.mode === 'direct' ? state.status === 'paused' ? 'Resume preview' : 'Play preview' : 'Open preview player';
      stopButton.hidden = !frame && !audio;
      stopButton.textContent = source?.mode === 'direct' && state.status === 'playing' ? 'Pause preview' : 'Stop player';
      if (typeof onState === 'function') onState({ ...state });
    }
    function clearPlayer() {
      generation += 1;
      if (timeout) { clearTimeout(timeout); timeout = null; }
      if (audio) {
        audio.onloadedmetadata = null; audio.ontimeupdate = null; audio.onended = null; audio.onerror = null;
        audio.pause(); audio.removeAttribute('src'); audio.load(); audio.remove(); audio = null;
      }
      if (frame) { frame.removeAttribute('src'); frame.remove(); frame = null; }
      playerHost.replaceChildren();
    }
    async function play() {
      if (disposed || !source) return;
      if (source.mode === 'official-embed') {
        if (frame) return;
        clearPlayer();
        frame = make('iframe', 'feat-audio-frame');
        frame.title = source.kind === 'track' ? `Deezer preview: ${source.title}` : `Deezer album player: ${album.title}`;
        frame.width = '100%'; frame.height = source.kind === 'track' ? '150' : '300';
        frame.setAttribute('allow', 'encrypted-media; clipboard-write');
        frame.setAttribute('frameborder', '0'); frame.setAttribute('allowtransparency', 'true');
        frame.referrerPolicy = 'strict-origin-when-cross-origin';
        const token = generation;
        frame.onload = () => { if (generation !== token) return; if (timeout) clearTimeout(timeout); emit('ready', 'Press Play in the Deezer player. Preview availability depends on your region.'); };
        frame.onerror = () => { if (generation !== token) return; if (timeout) clearTimeout(timeout); emit('error', 'The player could not load. You can still open the listening link.'); };
        frame.src = widgetUrl(source); playerHost.append(frame);
        emit('loading', 'Loading the official Deezer player…');
        timeout = setTimeout(() => { if (generation === token && frame) emit('ready', 'Press Play in the Deezer player. If it is unavailable here, use the listening link.'); }, 12000);
        return;
      }
      if (!audio) {
        audio = make('audio', 'feat-audio-direct'); audio.preload = 'none'; audio.volume = volume;
        audio.src = source.url; audio.controls = true;
        const token = generation;
        audio.ontimeupdate = () => { if (generation === token && audio && audio.currentTime >= source.maxSeconds) { audio.pause(); audio.currentTime = 0; emit('available', 'Preview finished.'); } };
        audio.onended = () => { if (generation === token) emit('available', 'Preview finished.'); };
        audio.onerror = () => { if (generation === token) emit('error', 'This preview could not load. Try the listening link.'); };
        playerHost.append(audio);
      }
      if (audio.currentTime >= source.maxSeconds) audio.currentTime = 0;
      const token = generation;
      emit('loading', 'Starting preview…');
      try { await audio.play(); if (token === generation) emit('playing', `Playing up to ${source.maxSeconds} seconds.`); }
      catch { if (token === generation) emit('available', 'Press Play to start the preview. Your browser may block automatic playback.'); }
    }
    function pause() {
      if (source?.mode === 'direct' && audio) { audio.pause(); emit('paused', 'Preview paused.'); }
      else { clearPlayer(); emit(source ? 'available' : 'idle', source ? 'Player stopped. Open it to listen again.' : ''); }
    }
    function stop() { clearPlayer(); album = null; source = null; heading.hidden = true; actions.hidden = true; container.hidden = true; emit('idle', ''); }
    function setAlbum(nextAlbum, options = {}) {
      if (disposed) return;
      const next = resolvePreview(nextAlbum, mappings || globalThis.FEAT_PREVIEW_TRACKS || []);
      const same = album?.id === nextAlbum?.id && JSON.stringify(source) === JSON.stringify(next);
      enabled = options.autoplay !== false;
      volume = clampVolume(options.volume ?? volume);
      if (same) { if (audio) audio.volume = volume; return { ...state }; }
      clearPlayer(); album = nextAlbum; source = next;
      if (!album) { stop(); return { ...state }; }
      container.hidden = false; heading.hidden = false; actions.hidden = false;
      title.textContent = source?.kind === 'track' || source?.mode === 'direct' ? `From the album: ${source.title}` : 'Hear the album';
      provider.textContent = source?.mode === 'direct' ? 'Licensed preview' : 'Official Deezer player';
      link.href = source?.listeningUrl || `https://www.deezer.com/search/${encodeURIComponent(`${album.artist} ${album.title}`)}/album`;
      link.textContent = source?.mode === 'direct' ? 'Listen to the track ↗' : 'Listen on Deezer ↗';
      if (!source) { provider.hidden = true; emit('unavailable', 'No preview is available here. You can listen on Deezer.'); return { ...state }; }
      provider.hidden = false;
      emit('available', source.mode === 'official-embed' ? source.kind === 'track' ? 'Open the official player to hear a preview of this track.' : 'Open the official album player and choose an available track.' : 'A short preview is available.');
      if (enabled && options.userInitiated === true && options.restored !== true) play();
      return { ...state };
    }
    playButton.addEventListener('click', play);
    stopButton.addEventListener('click', () => { if (source?.mode === 'direct' && state.status === 'playing') pause(); else { clearPlayer(); emit(source ? 'available' : 'idle', 'Player stopped.'); } });
    container.hidden = true;
    return Object.freeze({
      setAlbum, play, pause, stop,
      setVolume(value) { volume = clampVolume(value); if (audio) audio.volume = volume; return volume; },
      setEnabled(value) { enabled = Boolean(value); if (!enabled) pause(); },
      getState() { return { ...state }; },
      dispose() { if (disposed) return; stop(); disposed = true; container.replaceChildren(); }
    });
  }
  return Object.freeze({ create, resolvePreview, widgetUrl, clampVolume });
});
