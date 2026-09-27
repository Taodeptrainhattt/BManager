(function () {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  let store = null;
  let currentFolderId = null;
  let activeTabId = null;
  let tabOrder = []; // fileIds, in tab order
  let dragFileId = null;

  // fileId -> { output: string, status: 'running'|'stopped' }
  const fileSessions = {};

  // fileIds that were stopped via the Clear button and should auto-restart
  // once the 'stopped' status event confirms the process actually exited.
  const pendingRestart = new Set();

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function saveStore() {
    window.bmanager.setStore(store);
  }

  function naturalSort(files) {
    return [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  }

  // ================= INIT =================
  async function init() {
    store = await window.bmanager.getStore();
    applyBackground(store.settings.background || defaultBackground());

    if (!store.username) {
      $('#name-prompt').classList.remove('hidden');
      $('#name-input').focus();
    } else {
      startWelcome(store.username);
    }
  }

  $('#name-submit').addEventListener('click', submitName);
  $('#name-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitName(); });

  function submitName() {
    const val = $('#name-input').value.trim();
    if (!val) return;
    store.username = val;
    saveStore();
    $('#name-prompt').classList.add('hidden');
    startWelcome(val);
  }

  function startWelcome(name) {
    $('#welcome-line1').textContent = `Welcome, ${name}`;
    $('#welcome-line2').textContent = `Manage and control your bots with BManager`;
    $('#welcome-splash').classList.remove('hidden');
    setTimeout(() => {
      $('#welcome-splash').classList.add('hidden');
      $('#app-shell').classList.remove('hidden');
      showView('hub');
    }, 3000);
  }

  // ================= VIEW SWITCHING =================
  function showView(name) {
    $$('.view').forEach((v) => v.classList.add('hidden'));
    $$('.tool-btn').forEach((b) => b.classList.remove('active'));
    $('#content-watermark').classList.toggle('hidden', name === 'terminal');
    if (name === 'hub') {
      $('#view-hub').classList.remove('hidden');
      $('#btn-home').classList.add('active');
      renderFolderGrid();
    } else if (name === 'favorites') {
      $('#view-favorites').classList.remove('hidden');
      $('#btn-favorites').classList.add('active');
      renderFavoritesGrid();
    } else if (name === 'files') {
      $('#view-files').classList.remove('hidden');
    } else if (name === 'terminal') {
      $('#view-terminal').classList.remove('hidden');
      $('#btn-terminal').classList.add('active');
      renderTerminalTabs();
    } else if (name === 'settings') {
      $('#view-settings').classList.remove('hidden');
      $('#btn-settings').classList.add('active');
      loadSettingsForm();
    } else if (name === 'profile') {
      $('#view-profile').classList.remove('hidden');
      $('#btn-profile').classList.add('active');
      renderProfileView();
    }
  }

  $('#btn-home').addEventListener('click', () => showView('hub'));
  $('#btn-favorites').addEventListener('click', () => showView('favorites'));
  $('#btn-terminal').addEventListener('click', () => showView('terminal'));
  $('#btn-settings').addEventListener('click', () => showView('settings'));
  $('#btn-profile').addEventListener('click', () => showView('profile'));
  $('#files-back-btn').addEventListener('click', () => showView('hub'));

  // ================= HUB: FOLDER LIST =================
  function renderFolderGrid() {
    const grid = $('#folder-grid');
    grid.innerHTML = '';
    const folders = store.folders || [];
    $('#hub-empty-hint').classList.toggle('hidden', folders.length > 0);

    folders.forEach((f) => {
      const card = document.createElement('div');
      card.className = 'folder-card';
      card.dataset.id = f.id;
      card.innerHTML = `
        <div class="folder-icon">
          <svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>
        </div>
        <div class="folder-main">
          <div class="folder-name">${escapeHtml(f.name)}</div>
          <div class="folder-count">${f.files.length} .js file${f.files.length === 1 ? '' : 's'}</div>
        </div>
        <input class="folder-note-input" type="text" placeholder="Add a note..." value="${escapeAttr(f.note || '')}" />
        <div class="folder-actions">
          <button class="icon-btn" data-action="rename" title="Rename">
            <svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
          </button>
          <button class="icon-btn danger" data-action="delete" title="Delete">
            <svg viewBox="0 0 24 24"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1L5 6"/></svg>
          </button>
        </div>
      `;
      card.querySelector('.folder-name').addEventListener('click', () => openFolder(f.id));
      const noteInput = card.querySelector('.folder-note-input');
      noteInput.addEventListener('click', (e) => e.stopPropagation());
      noteInput.addEventListener('change', () => {
        f.note = noteInput.value;
        saveStore();
      });
      card.querySelector('[data-action="rename"]').addEventListener('click', () => renameFolder(f));
      card.querySelector('[data-action="delete"]').addEventListener('click', () => deleteFolder(f));
      grid.appendChild(card);
    });
  }

  function renameFolder(folder) {
    openMiniModal('Rename folder', folder.name, (val) => {
      if (val.trim()) folder.name = val.trim();
      saveStore();
      renderFolderGrid();
    });
  }

  function deleteFolder(folder) {
    if (confirm(`Delete folder "${folder.name}" from BManager?`)) {
      store.folders = store.folders.filter((f) => f.id !== folder.id);
      saveStore();
      renderFolderGrid();
    }
  }

  function openFolder(folderId) {
    currentFolderId = folderId;
    const folder = store.folders.find((f) => f.id === folderId);
    if (!folder) return;
    $('#files-title').textContent = folder.name;
    showView('files');
    renderFileGrid(folder);
  }

  // ================= FILES VIEW =================
  // Fewer cards per row -> bigger cards, more cards per row -> smaller cards.
  // n=3 -> scale ~1.15 (largest), n=10 -> scale ~0.55 (smallest), linear between.
  function scaleForCardsPerRow(n) {
    const maxScale = 1.15, minScale = 0.55, minN = 3, maxN = 10;
    const t = (n - minN) / (maxN - minN);
    return maxScale - t * (maxScale - minScale);
  }

  function applyCardsPerRowSetting(gridSelector) {
    const n = Math.min(10, Math.max(3, store.settings.cardsPerRow || 4));
    const grid = $(gridSelector || '#file-grid');
    grid.style.gridTemplateColumns = `repeat(${n}, 1fr)`;
    grid.style.setProperty('--card-scale', scaleForCardsPerRow(n));
  }

  function renderFileGrid(folder) {
    applyCardsPerRowSetting();
    folder.files = naturalSort(folder.files);
    const grid = $('#file-grid');
    grid.innerHTML = '';
    folder.files.forEach((file, idx) => {
      const card = document.createElement('div');
      card.className = 'file-card';
      card.dataset.id = file.id;
      const session = fileSessions[file.id];
      const status = session ? session.status : 'stopped';
      card.innerHTML = `
        <div class="x-btn" title="Remove">✕</div>
        <div class="fav-btn${file.favorite ? ' active' : ''}" title="${file.favorite ? 'Remove from favorites' : 'Add to favorites'}">
          <svg viewBox="0 0 24 24"><path d="M12 3.5 14.6 9l6 .9-4.3 4.2 1 6-5.3-2.8L6.7 20.1l1-6L3.4 9.9l6-.9Z"/></svg>
        </div>
        <div class="file-square">${idx + 1}</div>
        <div class="file-name">${escapeHtml(file.name)}</div>
        <input class="file-note-input" type="text" placeholder="Note..." value="${escapeAttr(file.note || '')}" />
        <div class="file-status ${status}"><span class="dot"></span>${status === 'running' ? 'Running' : 'Idle'}</div>
      `;
      card.querySelector('.x-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        deleteFile(folder.id, file.id);
      });
      card.querySelector('.fav-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        toggleFavorite(file);
        renderFileGrid(folder);
      });
      const noteInput = card.querySelector('.file-note-input');
      noteInput.addEventListener('click', (e) => e.stopPropagation());
      noteInput.addEventListener('change', () => {
        file.note = noteInput.value;
        saveStore();
      });
      card.addEventListener('click', () => runFile(file));
      grid.appendChild(card);
    });
  }

  function deleteFile(folderId, fileId) {
    const folder = store.folders.find((f) => f.id === folderId);
    if (!folder) return;
    folder.files = folder.files.filter((f) => f.id !== fileId);
    saveStore();
    renderFileGrid(folder);
    renderFolderGrid();
  }

  function toggleFavorite(file) {
    file.favorite = !file.favorite;
    saveStore();
  }

  // ================= FAVORITES VIEW =================
  function renderFavoritesGrid() {
    applyCardsPerRowSetting('#favorites-grid');
    const grid = $('#favorites-grid');
    grid.innerHTML = '';

    const favorites = [];
    (store.folders || []).forEach((folder) => {
      folder.files.forEach((file) => {
        if (file.favorite) favorites.push({ file, folder });
      });
    });
    $('#favorites-empty-hint').classList.toggle('hidden', favorites.length > 0);

    favorites.sort((a, b) => a.file.name.localeCompare(b.file.name, undefined, { numeric: true, sensitivity: 'base' }));

    favorites.forEach(({ file, folder }) => {
      const session = fileSessions[file.id];
      const status = session ? session.status : 'stopped';
      const card = document.createElement('div');
      card.className = 'file-card';
      card.dataset.id = file.id;
      card.innerHTML = `
        <div class="fav-btn active" title="Remove from favorites">
          <svg viewBox="0 0 24 24"><path d="M12 3.5 14.6 9l6 .9-4.3 4.2 1 6-5.3-2.8L6.7 20.1l1-6L3.4 9.9l6-.9Z"/></svg>
        </div>
        <div class="file-square">★</div>
        <div class="file-name">${escapeHtml(file.name)}</div>
        <div class="favorites-folder-tag">${escapeHtml(folder.name)}</div>
        <div class="file-status ${status}"><span class="dot"></span>${status === 'running' ? 'Running' : 'Idle'}</div>
      `;
      card.querySelector('.fav-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        toggleFavorite(file);
        renderFavoritesGrid();
      });
      card.addEventListener('click', () => runFile(file));
      grid.appendChild(card);
    });
  }

  // ================= PROFILE =================
  const appStartTime = Date.now();

  function formatUptime(ms) {
    let totalSeconds = Math.floor(ms / 1000);
    const days = Math.floor(totalSeconds / 86400);
    totalSeconds %= 86400;
    const hours = Math.floor(totalSeconds / 3600);
    totalSeconds %= 3600;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return `${days}d ${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  }

  function updateProfileUptime() {
    const el = $('#profile-uptime');
    if (el) el.textContent = formatUptime(Date.now() - appStartTime);
  }
  setInterval(updateProfileUptime, 1000);

  function renderProfileRunningList() {
    const list = $('#profile-running-list');
    list.innerHTML = '';
    const running = [];
    (store.folders || []).forEach((folder) => {
      folder.files.forEach((file) => {
        const session = fileSessions[file.id];
        if (session && session.status === 'running') running.push({ file, folder });
      });
    });
    $('#profile-running-empty').classList.toggle('hidden', running.length > 0);
    running.sort((a, b) => a.file.name.localeCompare(b.file.name, undefined, { numeric: true, sensitivity: 'base' }));
    running.forEach(({ file, folder }) => {
      const row = document.createElement('div');
      row.className = 'profile-running-row';
      row.innerHTML = `
        <span class="dot"></span>
        <span class="profile-running-name">${escapeHtml(file.name)}</span>
        <span class="profile-running-folder">${escapeHtml(folder.name)}</span>
      `;
      list.appendChild(row);
    });
  }

  function renderProfileView() {
    $('#profile-username').textContent = store.username || 'User';
    updateProfileUptime();
    renderProfileRunningList();
  }

  $('#add-file-btn').addEventListener('click', async () => {
    const folder = store.folders.find((f) => f.id === currentFolderId);
    if (!folder) return;
    const res = await window.bmanager.addFilesToFolder();
    if (res.canceled) return;
    const existingPaths = new Set(folder.files.map((f) => f.filePath));
    let added = 0;
    res.files.forEach((fp) => {
      if (existingPaths.has(fp)) return;
      folder.files.push({
        id: uid(),
        name: fp.split(/[\\/]/).filter(Boolean).pop(),
        filePath: fp,
        note: '',
        favorite: false
      });
      added++;
    });
    if (added > 0) {
      saveStore();
      renderFileGrid(folder);
      renderFolderGrid();
    }
  });

  // ================= RUN FILE / TERMINAL =================
  async function runFile(file) {
    const session = getOrCreateSession(file.id, 'stopped');
    if (!tabOrder.includes(file.id)) tabOrder.push(file.id);

    if (session.status !== 'running') {
      session.output += `$ node ${file.name}\n`;
      const res = await window.bmanager.runFile(file.id, file.filePath);
      if (!res.ok) {
        session.output += `[${res.message}]\n`;
      } else {
        session.status = 'running';
      }
    }
    activeTabId = file.id;
    showView('terminal');
  }

  function renderTerminalTabs() {
    const tabsEl = $('#terminal-tabs');
    tabsEl.innerHTML = '';

    if (tabOrder.length === 0) {
      $('#terminal-active-name').textContent = 'No process selected';
      $('#terminal-output').innerHTML = '';
      updateTerminalActionButtons();
      return;
    }
    if (!activeTabId || !tabOrder.includes(activeTabId)) activeTabId = tabOrder[tabOrder.length - 1];

    tabOrder.forEach((fileId) => {
      const info = findFileById(fileId);
      const session = fileSessions[fileId];
      const tab = document.createElement('div');
      tab.className = 'terminal-tab' + (fileId === activeTabId ? ' active' : '') + (session && session.status === 'running' ? ' running' : '');
      tab.draggable = true;
      tab.dataset.id = fileId;
      tab.innerHTML = `
        <span class="tab-dot"></span>
        <span class="tab-label">${escapeHtml(info ? info.name : 'file')}</span>
        <span class="tab-close">✕</span>
      `;
      tab.addEventListener('click', (e) => {
        if (e.target.classList.contains('tab-close')) return;
        activeTabId = fileId;
        renderTerminalTabs();
      });
      tab.querySelector('.tab-close').addEventListener('click', async (e) => {
        e.stopPropagation();
        await window.bmanager.stopFile(fileId);
        tabOrder = tabOrder.filter((id) => id !== fileId);
        delete fileSessions[fileId];
        if (activeTabId === fileId) activeTabId = null;
        renderTerminalTabs();
      });

      // drag & drop reordering
      tab.addEventListener('dragstart', () => {
        dragFileId = fileId;
        tab.classList.add('dragging');
      });
      tab.addEventListener('dragend', () => tab.classList.remove('dragging'));
      tab.addEventListener('dragover', (e) => {
        e.preventDefault();
        tab.classList.add('drag-over');
      });
      tab.addEventListener('dragleave', () => tab.classList.remove('drag-over'));
      tab.addEventListener('drop', (e) => {
        e.preventDefault();
        tab.classList.remove('drag-over');
        if (!dragFileId || dragFileId === fileId) return;
        const fromIdx = tabOrder.indexOf(dragFileId);
        const toIdx = tabOrder.indexOf(fileId);
        tabOrder.splice(fromIdx, 1);
        tabOrder.splice(toIdx, 0, dragFileId);
        dragFileId = null;
        renderTerminalTabs();
      });

      tabsEl.appendChild(tab);
    });

    const info = findFileById(activeTabId);
    $('#terminal-active-name').textContent = info ? info.name : '';
    renderTerminalOutput(activeTabId);
    updateTerminalActionButtons();
  }

  function updateTerminalActionButtons() {
    const session = activeTabId ? fileSessions[activeTabId] : null;
    const running = !!(session && session.status === 'running');
    const hasTab = !!activeTabId;
    $('#terminal-stop-btn').disabled = !hasTab || !running;
    $('#terminal-clear-btn').disabled = !hasTab;
    $('#terminal-run-btn').disabled = !hasTab || running;
  }

  // ANSI color codes -> hex, matching the app's dark palette
  const ANSI_FG = {
    30: '#4b5062', 31: '#ff5468', 32: '#33d17a', 33: '#e5c07b', 34: '#4f8cff', 35: '#c586c0', 36: '#56b6c2', 37: '#e7e9f0',
    90: '#6b7280', 91: '#ff8098', 92: '#6be3a5', 93: '#f0d894', 94: '#7fa9ff', 95: '#dca6e0', 96: '#8fd6df', 97: '#ffffff'
  };
  const ANSI_BG = {
    40: '#4b5062', 41: '#ff5468', 42: '#33d17a', 43: '#e5c07b', 44: '#4f8cff', 45: '#c586c0', 46: '#56b6c2', 47: '#e7e9f0',
    100: '#6b7280', 101: '#ff8098', 102: '#6be3a5', 103: '#f0d894', 104: '#7fa9ff', 105: '#dca6e0', 106: '#8fd6df', 107: '#ffffff'
  };

  function freshAnsiState() {
    return { fg: null, bg: null, bold: false, italic: false, underline: false, dim: false };
  }

  // Converts a chunk of raw process stdout/stderr (which may contain ANSI
  // color/style escape codes, e.g. from chalk/colors) into safe HTML with
  // inline styles, so colored console.log output shows up colored here too.
  // `state` is mutated in place so color/style carries over correctly when
  // this is called repeatedly on successive chunks of the same stream.
  function parseAnsiChunk(raw, state) {
    if (!raw) return '';
    // Drop non-color control sequences (cursor movement, clear-line, etc.)
    // but keep "m" (SGR / color) sequences for the next step.
    const cleaned = raw.replace(/\x1b\[[0-9;]*[A-HJKSTfsu]/g, '');
    const parts = cleaned.split(/\x1b\[([0-9;]*)m/g);
    let out = '';
    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 0) {
        const text = parts[i];
        if (!text) continue;
        const styles = [];
        if (state.fg) styles.push('color:' + state.fg);
        if (state.bg) styles.push('background:' + state.bg);
        if (state.bold) styles.push('font-weight:700');
        if (state.italic) styles.push('font-style:italic');
        if (state.underline) styles.push('text-decoration:underline');
        if (state.dim) styles.push('opacity:.6');
        const escaped = escapeHtml(text);
        out += styles.length ? `<span style="${styles.join(';')}">${escaped}</span>` : escaped;
      } else {
        const codes = parts[i].split(';').filter((c) => c !== '').map(Number);
        if (codes.length === 0) {
          Object.assign(state, freshAnsiState());
          continue;
        }
        codes.forEach((c) => {
          if (c === 0) Object.assign(state, freshAnsiState());
          else if (c === 1) state.bold = true;
          else if (c === 2) state.dim = true;
          else if (c === 3) state.italic = true;
          else if (c === 4) state.underline = true;
          else if (c === 22) { state.bold = false; state.dim = false; }
          else if (c === 23) state.italic = false;
          else if (c === 24) state.underline = false;
          else if (c === 39) state.fg = null;
          else if (c === 49) state.bg = null;
          else if (ANSI_FG[c]) state.fg = ANSI_FG[c];
          else if (ANSI_BG[c]) state.bg = ANSI_BG[c];
        });
      }
    }
    return out;
  }

  // Full rebuild: re-parses the whole buffer from scratch and replaces the
  // pane's content. Used only for one-off events (switching tabs, clearing,
  // sending input) — never for every incoming stdout chunk, since that's
  // what made the terminal grind to a halt after hours of streaming logs.
  function renderTerminalOutput(fileId) {
    const session = fileSessions[fileId];
    const out = $('#terminal-output');
    if (!session) { out.innerHTML = ''; return; }
    const state = freshAnsiState();
    out.innerHTML = parseAnsiChunk(session.output, state);
    session.ansiState = state;
    session.renderedLength = session.output.length;
    session.needsRebuild = false;
    out.scrollTop = out.scrollHeight;
  }

  // Incremental update: only parses and appends the NEW text since the last
  // render, instead of re-parsing and replacing the entire accumulated log.
  // This is what keeps a bot that's been running for hours from lagging —
  // cost scales with the size of the new chunk, not with total log length.
  function appendTerminalOutputChunk(fileId) {
    const session = fileSessions[fileId];
    if (!session) return;
    const newText = session.output.slice(session.renderedLength);
    session.renderedLength = session.output.length;
    if (!newText) return;
    const html = parseAnsiChunk(newText, session.ansiState);
    if (!html) return;
    const out = $('#terminal-output');
    out.insertAdjacentHTML('beforeend', html);
    out.scrollTop = out.scrollHeight;
  }

  // Multiple stdout chunks can arrive within the same frame; batch them into
  // a single DOM update via requestAnimationFrame instead of touching the
  // DOM on every single IPC message.
  const pendingTerminalRenders = new Set();
  let terminalRenderScheduled = false;
  function scheduleTerminalRender(fileId) {
    pendingTerminalRenders.add(fileId);
    if (terminalRenderScheduled) return;
    terminalRenderScheduled = true;
    requestAnimationFrame(flushTerminalRenders);
  }
  function flushTerminalRenders() {
    terminalRenderScheduled = false;
    const ids = [...pendingTerminalRenders];
    pendingTerminalRenders.clear();
    ids.forEach((fileId) => {
      if (fileId !== activeTabId) return;
      if ($('#view-terminal').classList.contains('hidden')) return;
      const session = fileSessions[fileId];
      if (!session) return;
      if (session.needsRebuild) renderTerminalOutput(fileId);
      else appendTerminalOutputChunk(fileId);
    });
  }

  // Keep each session's stored log bounded so it can run for hours without
  // eating memory or making every future render more expensive. Trimmed in
  // bulk (soft/hard cap) rather than on every append, so the slice itself
  // stays rare instead of running on every incoming chunk.
  const OUTPUT_SOFT_CAP = 400000; // ~400k chars before we bother trimming
  const OUTPUT_HARD_CAP = 250000; // trimmed back down to this many chars
  function trimSessionOutput(session) {
    if (session.output.length <= OUTPUT_SOFT_CAP) return;
    session.output = '…(older output trimmed)…\n' + session.output.slice(-OUTPUT_HARD_CAP);
    session.renderedLength = 0;
    session.ansiState = freshAnsiState();
    session.needsRebuild = true;
  }

  function getOrCreateSession(fileId, status) {
    if (!fileSessions[fileId]) {
      fileSessions[fileId] = {
        output: '',
        status: status || 'stopped',
        renderedLength: 0,
        ansiState: freshAnsiState(),
        needsRebuild: false
      };
    }
    return fileSessions[fileId];
  }

  $('#terminal-stop-btn').addEventListener('click', async () => {
    if (!activeTabId || !fileSessions[activeTabId]) return;
    await window.bmanager.stopFile(activeTabId);
  });

  // Clear: if the bot is running, stop it (like Ctrl+C), wipe the console
  // log once it has actually exited, then automatically run it again.
  // If it's already stopped, Clear just wipes the log.
  $('#terminal-clear-btn').addEventListener('click', async () => {
    if (!activeTabId) return;
    const session = fileSessions[activeTabId];
    if (session && session.status === 'running') {
      pendingRestart.add(activeTabId);
      await window.bmanager.stopFile(activeTabId);
    } else {
      if (session) session.output = '';
      renderTerminalOutput(activeTabId);
    }
  });

  // Run: start the currently selected bot again after it has stopped.
  $('#terminal-run-btn').addEventListener('click', () => {
    if (!activeTabId) return;
    const file = findFileById(activeTabId);
    if (!file) return;
    runFile(file);
  });

  function sendTerminalInput() {
    const input = $('#terminal-input');
    const text = input.value;
    if (!text || !activeTabId) return;
    window.bmanager.sendInput(activeTabId, text);
    const session = fileSessions[activeTabId];
    if (session) session.output += `> ${text}\n`;
    renderTerminalOutput(activeTabId);
    input.value = '';
  }
  $('#terminal-send-btn').addEventListener('click', sendTerminalInput);
  $('#terminal-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendTerminalInput(); });

  function findFileById(fileId) {
    for (const folder of store.folders) {
      const f = folder.files.find((x) => x.id === fileId);
      if (f) return f;
    }
    return null;
  }

  window.bmanager.onProcessOutput(({ fileId, data }) => {
    const session = getOrCreateSession(fileId, 'running');
    session.output += data;
    trimSessionOutput(session);
    if (activeTabId === fileId) scheduleTerminalRender(fileId);
  });

  window.bmanager.onProcessStatus(({ fileId, data }) => {
    const session = getOrCreateSession(fileId, 'stopped');
    session.status = data;

    if (data === 'stopped' && pendingRestart.has(fileId)) {
      pendingRestart.delete(fileId);
      session.output = '';
      session.renderedLength = 0;
      session.ansiState = freshAnsiState();
      const file = findFileById(fileId);
      if (file) runFile(file);
    }

    if (!$('#view-terminal').classList.contains('hidden')) renderTerminalTabs();
    if (!$('#view-favorites').classList.contains('hidden')) renderFavoritesGrid();
    if (!$('#view-profile').classList.contains('hidden')) renderProfileRunningList();
    const folder = store.folders.find((f) => f.id === currentFolderId);
    if (folder && folder.files.some((f) => f.id === fileId) && !$('#view-files').classList.contains('hidden')) {
      renderFileGrid(folder);
    }
  });

  // ================= SETTINGS =================
  // working copy of the background settings, edited live and only
  // persisted to the store when "Save changes" is pressed
  let bgDraft = null;

  function defaultBackground() {
    return { colors: ['#0b0c10'], angle: 135, image: null, posX: 50, posY: 50, zoom: 100 };
  }

  const BG_PRESET_COLORS = ['#4f8cff', '#7b5cff', '#ff5468', '#33d17a', '#e5c07b', '#56b6c2'];

  // Reads an image file, scales it down so BOTH width and height stay under
  // the given caps (regardless of aspect ratio), and returns a JPEG data
  // URL. Bounding both dimensions — not just width — is what stops a very
  // large or oddly-shaped photo from failing to fit/save.
  // Caps a background photo's resolution to whatever the user's actual
  // screen can show (accounting for retina/high-DPI scaling), instead of a
  // fixed guess. If the photo is already smaller than the screen, it's left
  // untouched — we never upscale it. If it's larger than the screen could
  // ever display, there's no point storing more pixels than that, so it's
  // trimmed down to exactly match (no visible quality loss either way).
  function getScreenMaxDimensions() {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round((window.screen.width || 1920) * dpr);
    const h = Math.round((window.screen.height || 1080) * dpr);
    // Safety ceiling so an unusually large/scaled display doesn't produce
    // an excessively large file.
    return { w: Math.min(w, 3840), h: Math.min(h, 2400) };
  }

  function downscaleImageToDataUrl(file, maxW, maxH, quality) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          const scale = Math.min(1, maxW / img.width, maxH / img.height);
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(img.width * scale));
          canvas.height = Math.max(1, Math.round(img.height * scale));
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.onerror = reject;
        img.src = reader.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  // Wires "drag on a box to pick the visible region" for a background
  // photo. Shared between the Settings preview banner and the Music
  // appearance panel's small position pad.
  function setupPositionPad(padEl, dotEl, getState, onChange) {
    let dragging = false;
    function update(clientX, clientY) {
      const rect = padEl.getBoundingClientRect();
      const x = Math.min(100, Math.max(0, ((clientX - rect.left) / rect.width) * 100));
      const y = Math.min(100, Math.max(0, ((clientY - rect.top) / rect.height) * 100));
      const state = getState();
      state.posX = Math.round(x);
      state.posY = Math.round(y);
      if (dotEl) { dotEl.style.left = state.posX + '%'; dotEl.style.top = state.posY + '%'; }
      onChange();
    }
    padEl.addEventListener('mousedown', (e) => {
      if (!getState().image) return;
      dragging = true;
      update(e.clientX, e.clientY);
    });
    window.addEventListener('mousemove', (e) => { if (dragging) update(e.clientX, e.clientY); });
    window.addEventListener('mouseup', () => { dragging = false; });
  }

  // Solid/gradient color value with no image involved.
  function computeSolidBgValue(colors, angle) {
    const list = colors && colors.length ? colors : ['#0b0c10'];
    if (list.length <= 1) return list[0];
    return `linear-gradient(${angle || 135}deg, ${list.join(', ')})`;
  }

  // Kept for compatibility with callers that just want "what should --bg be
  // right now" — the image case now says "transparent" since the photo (a
  // separate <img> layer) is shown on its own, with no color mixed in.
  function computeBgValue(bg) {
    return bg.image ? 'transparent' : computeSolidBgValue(bg.colors, bg.angle);
  }

  // Applies either the photo (as-is, no color tint) or the solid/gradient
  // color — never both mixed together.
  function applyBackground(bg) {
    document.documentElement.style.setProperty('--bg', computeBgValue(bg));
    const img = $('#app-bg-image');
    if (bg.image) {
      img.src = bg.image;
      img.style.opacity = '1';
      img.style.objectPosition = `${bg.posX != null ? bg.posX : 50}% ${bg.posY != null ? bg.posY : 50}%`;
      img.style.transform = `scale(${(bg.zoom || 100) / 100})`;
    } else {
      img.style.opacity = '0';
      img.removeAttribute('src');
    }
  }

  function renderBgColorRow() {
    const row = $('#bg-color-row');
    row.innerHTML = '';
    bgDraft.colors.forEach((color, i) => {
      const dot = document.createElement('div');
      dot.className = 'bg-color-dot';
      dot.innerHTML = `
        <input type="color" value="${color}" />
        ${bgDraft.colors.length > 1 ? '<div class="dot-remove">✕</div>' : ''}
      `;
      dot.querySelector('input').addEventListener('input', (e) => {
        bgDraft.colors[i] = e.target.value;
        refreshBgPreview();
      });
      const removeBtn = dot.querySelector('.dot-remove');
      if (removeBtn) {
        removeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          bgDraft.colors.splice(i, 1);
          renderBgColorRow();
          refreshBgPreview();
        });
      }
      row.appendChild(dot);
    });

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'bg-add-color';
    addBtn.textContent = '+';
    addBtn.title = 'Add a color to blend into the gradient';
    addBtn.disabled = bgDraft.colors.length >= 3;
    addBtn.addEventListener('click', () => {
      if (bgDraft.colors.length >= 3) return;
      const next = BG_PRESET_COLORS[bgDraft.colors.length % BG_PRESET_COLORS.length];
      bgDraft.colors.push(next);
      renderBgColorRow();
      refreshBgPreview();
    });
    row.appendChild(addBtn);

    $('#bg-angle-row').classList.toggle('hidden', bgDraft.colors.length < 2);
  }

  function refreshBgPreview() {
    const preview = $('#bg-preview');
    const hasImage = !!bgDraft.image;
    preview.style.background = hasImage
      ? `url("${bgDraft.image}") ${bgDraft.posX}% ${bgDraft.posY}%/cover no-repeat`
      : computeSolidBgValue(bgDraft.colors, bgDraft.angle);
    preview.classList.toggle('has-image', hasImage);
    $('#bg-position-dot').classList.toggle('visible', hasImage);
    $('#bg-position-dot').style.left = bgDraft.posX + '%';
    $('#bg-position-dot').style.top = bgDraft.posY + '%';
    $('#bg-zoom-row').classList.toggle('hidden', !hasImage);
    $('#bg-color-row').classList.toggle('hidden', hasImage);
    $('#bg-angle-row').classList.toggle('hidden', hasImage || bgDraft.colors.length < 2);
    applyBackground(bgDraft);
  }

  $('#bg-gradient-angle').addEventListener('input', () => {
    bgDraft.angle = parseInt($('#bg-gradient-angle').value, 10);
    $('#bg-angle-value').textContent = bgDraft.angle + '°';
    refreshBgPreview();
  });
  $('#bg-zoom').addEventListener('input', () => {
    bgDraft.zoom = parseInt($('#bg-zoom').value, 10);
    $('#bg-zoom-value').textContent = bgDraft.zoom + '%';
    refreshBgPreview();
  });
  setupPositionPad($('#bg-preview'), $('#bg-position-dot'), () => bgDraft, refreshBgPreview);

  $('#bg-image-btn').addEventListener('click', () => $('#bg-image-input').click());
  $('#bg-image-clear').addEventListener('click', () => {
    bgDraft.image = null;
    refreshBgPreview();
  });
  $('#bg-image-input').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = ''; // let picking the same file again still fire "change"
    if (!file) return;
    try {
      const { w, h } = getScreenMaxDimensions();
      bgDraft.image = await downscaleImageToDataUrl(file, w, h, 0.85);
      bgDraft.posX = 50;
      bgDraft.posY = 50;
      bgDraft.zoom = 100;
      $('#bg-zoom').value = 100;
      $('#bg-zoom-value').textContent = '100%';
      refreshBgPreview();
    } catch (err) {
      console.error('Failed to load background image:', err);
    }
  });

  function loadSettingsForm() {
    $('#setting-cards-per-row').value = store.settings.cardsPerRow || 4;
    $('#setting-sound-enabled').checked = store.settings.soundEnabled !== false;

    const savedBg = store.settings.background || defaultBackground();
    bgDraft = {
      colors: [...(savedBg.colors && savedBg.colors.length ? savedBg.colors : ['#0b0c10'])],
      angle: savedBg.angle || 135,
      image: savedBg.image || null,
      posX: savedBg.posX != null ? savedBg.posX : 50,
      posY: savedBg.posY != null ? savedBg.posY : 50,
      zoom: savedBg.zoom || 100
    };
    $('#bg-gradient-angle').value = bgDraft.angle;
    $('#bg-angle-value').textContent = bgDraft.angle + '°';
    $('#bg-zoom').value = bgDraft.zoom;
    $('#bg-zoom-value').textContent = bgDraft.zoom + '%';
    renderBgColorRow();
    refreshBgPreview();
  }

  $('#setting-save-btn').addEventListener('click', () => {
    let n = parseInt($('#setting-cards-per-row').value, 10);
    if (isNaN(n)) n = 4;
    n = Math.min(10, Math.max(3, n));
    store.settings.cardsPerRow = n;
    store.settings.soundEnabled = $('#setting-sound-enabled').checked;
    store.settings.background = {
      colors: [...bgDraft.colors],
      angle: bgDraft.angle,
      image: bgDraft.image || null,
      posX: bgDraft.posX,
      posY: bgDraft.posY,
      zoom: bgDraft.zoom
    };
    saveStore();
    applyCardsPerRowSetting();
    applyBackground(store.settings.background);
    $('#setting-saved-msg').classList.remove('hidden');
    setTimeout(() => $('#setting-saved-msg').classList.add('hidden'), 1800);
  });

  // ================= BUTTON CLICK SOUND =================
  let audioCtx = null;
  function ensureAudioCtx() {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      audioCtx = new Ctx();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }
  function playClickSound() {
    if (!store || store.settings.soundEnabled === false) return;
    const ctx = ensureAudioCtx();
    if (!ctx) return;
    try {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(720, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(420, ctx.currentTime + 0.08);
      gain.gain.setValueAtTime(0.001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.09, ctx.currentTime + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.11);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.12);
    } catch (e) { /* ignore */ }
  }
  const SOUND_SELECTOR = 'button, .tool-btn, .icon-btn, .file-card, .folder-card, .ctx-item, .bg-add-color, .dot-remove, .fav-btn';
  document.addEventListener('click', (e) => {
    const el = e.target.closest(SOUND_SELECTOR);
    if (el && !el.disabled) playClickSound();
  }, true);

  // ================= MUSIC PLAYER =================
  const MUSIC_APPEARANCE_KEY = 'bmanager-music-appearance';
  const MUSIC_BG_PRESETS = ['#4f8cff', '#7b5cff', '#ff5468', '#33d17a', '#e5c07b', '#56b6c2'];

  function loadMusicAppearance() {
    try {
      const raw = localStorage.getItem(MUSIC_APPEARANCE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.colors) && parsed.colors.length) {
          if (parsed.posX == null) parsed.posX = 50;
          if (parsed.posY == null) parsed.posY = 50;
          if (!parsed.zoom) parsed.zoom = 100;
          return parsed;
        }
      }
    } catch (e) { /* ignore corrupt/unavailable storage */ }
    return { colors: ['#171225', '#2c2150'], angle: 135, image: null, posX: 50, posY: 50, zoom: 100 };
  }
  function saveMusicAppearance() {
    try { localStorage.setItem(MUSIC_APPEARANCE_KEY, JSON.stringify(musicAppearance)); } catch (e) { /* ignore */ }
  }
  let musicAppearance = loadMusicAppearance();

  function computeMusicBgValue() {
    const colors = musicAppearance.colors;
    if (colors.length <= 1) return colors[0] || '#171225';
    return `linear-gradient(${musicAppearance.angle || 135}deg, ${colors.join(', ')})`;
  }

  function applyMusicAppearance() {
    const layer = $('#music-bg-layer');
    const hasImage = !!musicAppearance.image;
    $('#music-bg-position-row').classList.toggle('hidden', !hasImage);
    $('#music-bg-zoom-row').classList.toggle('hidden', !hasImage);
    $('#music-bg-color-row').classList.toggle('hidden', hasImage);
    if (hasImage) {
      $('#music-bg-tint').style.background = 'transparent';
      layer.src = musicAppearance.image;
      layer.style.opacity = '1';
      layer.style.objectPosition = `${musicAppearance.posX}% ${musicAppearance.posY}%`;
      layer.style.transform = `scale(${(musicAppearance.zoom || 100) / 100})`;
      $('#music-bg-position-pad').style.backgroundImage = `url("${musicAppearance.image}")`;
      $('#music-bg-position-dot').style.left = musicAppearance.posX + '%';
      $('#music-bg-position-dot').style.top = musicAppearance.posY + '%';
      $('#music-bg-zoom').value = musicAppearance.zoom;
      $('#music-bg-zoom-value').textContent = musicAppearance.zoom + '%';
    } else {
      $('#music-bg-tint').style.background = computeMusicBgValue();
      layer.style.opacity = '0';
      layer.removeAttribute('src');
    }
  }

  function renderMusicColorDots() {
    const row = $('#music-bg-color-row');
    row.innerHTML = '';
    musicAppearance.colors.forEach((color, i) => {
      const dot = document.createElement('div');
      dot.className = 'bg-color-dot small';
      dot.innerHTML = `
        <input type="color" value="${color}" />
        ${musicAppearance.colors.length > 1 ? '<div class="dot-remove">✕</div>' : ''}
      `;
      dot.querySelector('input').addEventListener('input', (e) => {
        musicAppearance.colors[i] = e.target.value;
        applyMusicAppearance();
        saveMusicAppearance();
      });
      const removeBtn = dot.querySelector('.dot-remove');
      if (removeBtn) {
        removeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          musicAppearance.colors.splice(i, 1);
          renderMusicColorDots();
          applyMusicAppearance();
          saveMusicAppearance();
        });
      }
      row.appendChild(dot);
    });

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'bg-add-color small';
    addBtn.textContent = '+';
    addBtn.title = 'Add a color to blend into the background';
    addBtn.disabled = musicAppearance.colors.length >= 3;
    addBtn.addEventListener('click', () => {
      if (musicAppearance.colors.length >= 3) return;
      musicAppearance.colors.push(MUSIC_BG_PRESETS[musicAppearance.colors.length % MUSIC_BG_PRESETS.length]);
      renderMusicColorDots();
      applyMusicAppearance();
      saveMusicAppearance();
    });
    row.appendChild(addBtn);
  }

  $('#music-appearance-toggle').addEventListener('click', () => {
    $('#music-appearance-panel').classList.toggle('hidden');
  });
  $('#music-bg-image-btn').addEventListener('click', () => $('#music-bg-image-input').click());
  $('#music-bg-image-clear').addEventListener('click', () => {
    musicAppearance.image = null;
    applyMusicAppearance();
    saveMusicAppearance();
  });
  $('#music-bg-image-input').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = ''; // let picking the same file again still fire "change"
    if (!file) return;
    try {
      // Bounding BOTH width and height (not just width) is what stops a
      // very large or unusually tall/wide photo from producing an
      // oversized data URL that silently fails to fit into localStorage.
      musicAppearance.image = await downscaleImageToDataUrl(file, 640, 640, 0.82);
      musicAppearance.posX = 50;
      musicAppearance.posY = 50;
      musicAppearance.zoom = 100;
      applyMusicAppearance();
      saveMusicAppearance();
    } catch (err) {
      console.error('Failed to load music background image:', err);
    }
  });
  $('#music-bg-zoom').addEventListener('input', () => {
    musicAppearance.zoom = parseInt($('#music-bg-zoom').value, 10);
    $('#music-bg-zoom-value').textContent = musicAppearance.zoom + '%';
    applyMusicAppearance();
    saveMusicAppearance();
  });
  setupPositionPad($('#music-bg-position-pad'), $('#music-bg-position-dot'), () => musicAppearance, () => {
    applyMusicAppearance();
    saveMusicAppearance();
  });

  renderMusicColorDots();
  applyMusicAppearance();

  $('#btn-music').addEventListener('click', () => {
    $('#music-modal').classList.remove('hidden');
  });
  $('#music-close-btn').addEventListener('click', () => {
    $('#music-modal').classList.add('hidden');
  });
  $('#music-choose-btn').addEventListener('click', () => {
    $('#music-file-input').click();
  });
  $('#music-file-input').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = ''; // let picking the same file again still fire "change"
    if (!file) return;
    const audio = $('#music-audio');
    audio.src = URL.createObjectURL(file);
    audio.loop = true; // auto-replay when the track ends
    audio.play().catch(() => {});
    $('#music-rewind-btn').disabled = false;
    $('#music-play-btn').disabled = false;
    $('#music-forward-btn').disabled = false;
  });

  function updateMusicPlayIcon(playing) {
    $('#music-play-btn').innerHTML = playing
      ? '<svg viewBox="0 0 24 24"><rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/></svg>'
      : '<svg viewBox="0 0 24 24"><path d="M6 4v16l14-8Z"/></svg>';
  }

  function formatMusicTime(sec) {
    if (!isFinite(sec) || isNaN(sec) || sec < 0) return '00:00';
    sec = Math.floor(sec);
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function updateMusicProgressUI() {
    const audio = $('#music-audio');
    const duration = audio.duration || 0;
    const current = audio.currentTime || 0;
    const pct = duration > 0 ? Math.min(100, (current / duration) * 100) : 0;
    $('#music-progress-fill').style.width = pct + '%';
    $('#music-progress-thumb').style.left = pct + '%';
    $('#music-current-time').textContent = formatMusicTime(current);
    $('#music-remaining-time').textContent = duration > 0 ? '-' + formatMusicTime(duration - current) : '-00:00';
  }

  const musicAudioEl = $('#music-audio');
  musicAudioEl.addEventListener('timeupdate', updateMusicProgressUI);
  musicAudioEl.addEventListener('loadedmetadata', updateMusicProgressUI);
  musicAudioEl.addEventListener('play', () => updateMusicPlayIcon(true));
  musicAudioEl.addEventListener('pause', () => updateMusicPlayIcon(false));

  $('#music-play-btn').addEventListener('click', () => {
    const audio = $('#music-audio');
    if (!audio.src) return;
    if (audio.paused) audio.play().catch(() => {});
    else audio.pause();
  });
  $('#music-rewind-btn').addEventListener('click', () => {
    const audio = $('#music-audio');
    if (!audio.src) return;
    audio.currentTime = Math.max(0, audio.currentTime - 10);
  });
  $('#music-forward-btn').addEventListener('click', () => {
    const audio = $('#music-audio');
    if (!audio.src || !audio.duration) return;
    audio.currentTime = Math.min(audio.duration, audio.currentTime + 10);
  });

  // Thick scrub bar: click or drag anywhere on it to seek.
  let musicScrubbing = false;
  function seekMusicFromClientX(clientX) {
    const audio = $('#music-audio');
    if (!audio.duration) return;
    const rect = $('#music-progress-track').getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    audio.currentTime = ratio * audio.duration;
    updateMusicProgressUI();
  }
  $('#music-progress-track').addEventListener('mousedown', (e) => {
    musicScrubbing = true;
    seekMusicFromClientX(e.clientX);
  });
  window.addEventListener('mousemove', (e) => {
    if (musicScrubbing) seekMusicFromClientX(e.clientX);
  });
  window.addEventListener('mouseup', () => { musicScrubbing = false; });



  // ================= HUB CONTEXT MENU =================
  function openContextMenu(selector, x, y) {
    closeAllContextMenus();
    const menu = $(selector);
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    menu.classList.remove('hidden');
  }
  function closeAllContextMenus() {
    $$('.context-menu').forEach((m) => m.classList.add('hidden'));
  }
  document.addEventListener('click', closeAllContextMenus);

  $('#view-hub').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openContextMenu('#ctx-hub', e.clientX, e.clientY);
  });
  $('#ctx-hub').addEventListener('click', (e) => {
    const action = e.target.dataset.action;
    if (action === 'add-folder') addFolderFlow();
    if (action === 'open-settings') showView('settings');
  });

  // ================= ADD FOLDER FLOW =================
  async function addFolderFlow() {
    const res = await window.bmanager.chooseAndScanFolder();
    if (res.canceled) return;
    if (res.empty) {
      alert('This folder has no .js files. Please choose a different folder.');
      return addFolderFlow();
    }
    const dirPath = res.dirPath;
    const name = dirPath.split(/[\\/]/).filter(Boolean).pop() || dirPath;
    const folder = {
      id: uid(),
      name,
      dirPath,
      note: '',
      files: res.files.map((fp) => ({
        id: uid(),
        name: fp.split(/[\\/]/).filter(Boolean).pop(),
        filePath: fp,
        note: '',
        favorite: false
      }))
    };
    store.folders.push(folder);
    saveStore();
    renderFolderGrid();
  }

  // ================= MINI MODAL (rename / delete-confirm) =================
  let miniModalCallback = null;

  function openMiniModal(title, value, callback) {
    $('#mini-modal-title').textContent = title;
    $('#mini-modal-input').value = value;
    miniModalCallback = callback;
    $('#mini-modal').classList.remove('hidden');
    $('#mini-modal-input').focus();
    $('#mini-modal-input').select();
  }
  $('#mini-modal-cancel').addEventListener('click', () => {
    $('#mini-modal').classList.add('hidden');
    miniModalCallback = null;
  });
  $('#mini-modal-ok').addEventListener('click', () => {
    const val = $('#mini-modal-input').value;
    $('#mini-modal').classList.add('hidden');
    if (miniModalCallback) miniModalCallback(val);
    miniModalCallback = null;
  });
  $('#mini-modal-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#mini-modal-ok').click(); });

  // ================= HELPERS =================
  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }
  function escapeAttr(str) { return escapeHtml(str); }

  init();
})();
