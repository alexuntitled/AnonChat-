/* ==========================================================================
   Fusion Talk Web App – Navigation + Real-Time API + WebSocket Client
   ========================================================================== */

document.addEventListener('DOMContentLoaded', () => {

  // ── 1. Constants ─────────────────────────────────────────────────────────
  const DEFAULT_INTEREST_TAGS = [
    "Gaming 🎮","Tech 💻","Music 🎵","Memes 😂","Movies & TV 🎬",
    "Anime ⛩️","Coding 🚀","Philosophy 🧠","Books 📚","Art 🎨",
    "Travel ✈️","Sports ⚽","Late Night Vibes 🌙","Career 💼"
  ];

  const ROOMS_LIST = [
    { id:1,  name:"Gaming",     emoji:"🎮", desc:"Talk about your favorite games",              vip:false },
    { id:2,  name:"Deep Talk",  emoji:"🧠", desc:"Meaningful and thoughtful conversations",     vip:false },
    { id:3,  name:"Music",      emoji:"🎵", desc:"Share your music taste and discover new sounds",vip:false},
    { id:4,  name:"Memes",      emoji:"😂", desc:"Meme lovers unite",                           vip:false },
    { id:5,  name:"Movies & TV",emoji:"🎬", desc:"Discuss your favourite shows and films",       vip:false },
    { id:6,  name:"Tech",       emoji:"💻", desc:"Geek out on technology and coding",            vip:false },
    { id:7,  name:"Career",     emoji:"💼", desc:"Career advice and professional networking",    vip:false },
    { id:8,  name:"Late Night", emoji:"🌙", desc:"Late night vibes (Open 21:00 – 03:00)",       vip:false },
    { id:9,  name:"VIP Lounge", emoji:"💎", desc:"Exclusive room for premium members",           vip:true  }
  ];

  const LEVEL_MAP = {
    1:{min:0,    title:"Newbie",   emoji:"🌱"},
    2:{min:50,   title:"Explorer", emoji:"🌿"},
    3:{min:150,  title:"Regular",  emoji:"🌳"},
    5:{min:500,  title:"Star",     emoji:"⭐"},
    10:{min:2000,title:"Diamond",  emoji:"💎"},
    15:{min:5000,title:"Legend",   emoji:"👑"},
    20:{min:10000,title:"Mythic",  emoji:"🔥"}
  };

  // ── 2. Global State ───────────────────────────────────────────────────────
  let authToken   = localStorage.getItem('ft_token') || null;
  let userProfile = null;
  let ws          = null;
  let activeView  = 'home';
  let soundEnabled= true;

  // Chat state
  let chatSession = null;
  let activeStranger = null;
  let botReplyTimer = null;
  let typingTimer   = null;
  let isTypingSent  = false;

  // Rooms
  let activeRoom = null;

  // Calendar
  let calMonth = new Date().getMonth();
  let calYear  = new Date().getFullYear();
  let selectedDates = [];

  // ── 3. Sound Engine ───────────────────────────────────────────────────────
  let audioCtx = null;

  function initAudio() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }

  function beep(freqs, durs, type='sine') {
    if (!soundEnabled) return;
    try {
      initAudio();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const osc  = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = type;
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      let t = audioCtx.currentTime;
      osc.start(t);
      freqs.forEach((f, i) => {
        const d = durs[i];
        osc.frequency.setValueAtTime(f, t);
        gain.gain.setValueAtTime(0.10, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + d - 0.01);
        t += d;
      });
      osc.stop(t);
    } catch(e) {}
  }

  const sfx = {
    click:    () => beep([600],[0.07]),
    match:    () => beep([440,554,659,880],[0.10,0.10,0.10,0.30]),
    send:     () => beep([523,784],[0.06,0.08],'triangle'),
    recv:     () => beep([784,523],[0.06,0.08]),
    milestone:() => beep([261,329,392,523,659,784,1046],[0.08,0.08,0.08,0.08,0.08,0.08,0.35],'triangle'),
    error:    () => beep([150,100],[0.10,0.15],'sawtooth')
  };

  // ── 4. API Helper ─────────────────────────────────────────────────────────
  async function api(path, method='GET', body=null) {
    const headers = { 'Content-Type':'application/json' };
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
    const cfg = { method, headers };
    if (body) cfg.body = JSON.stringify(body);
    const res = await fetch(path, cfg);
    if (res.status === 401) { doLogout(); throw new Error('Session expired'); }
    const json = await res.json();
    if (!res.ok) throw new Error(json.detail || 'Request failed');
    return json;
  }

  // ── 5. Navigation / Tab Switching ─────────────────────────────────────────
  const sections  = document.querySelectorAll('.view-section');
  const navItems  = document.querySelectorAll('.nav-item');

  function switchView(viewId) {
    activeView = viewId;

    // Show/hide sections
    sections.forEach(s => {
      s.style.display = s.id === `view-${viewId}` ? '' : 'none';
    });

    // Highlight active nav
    navItems.forEach(n => {
      n.classList.toggle('active', n.getAttribute('data-view') === viewId);
    });

    // Side-effects per view
    if (viewId === 'rooms')        renderRooms();
    if (viewId === 'confessions')  renderConfessions();
    if (viewId === 'leaderboard')  renderLeaderboard('karma');
    if (viewId === 'premium')      renderCalendar();

    sfx.click();
  }

  // Bind nav clicks
  navItems.forEach(item => {
    item.addEventListener('click', () => {
      const v = item.getAttribute('data-view');
      if (v) switchView(v);
    });
  });

  // Start on home
  switchView('home');

  // Hero shortcut buttons
  document.getElementById('hero-start-chat-btn')?.addEventListener('click', () => switchView('chat'));
  document.getElementById('hero-submit-confess-btn')?.addEventListener('click', () => {
    switchView('confessions');
    setTimeout(() => el('btn-open-confess-modal')?.click(), 300);
  });

  // Sound toggle
  document.getElementById('btn-toggle-sound')?.addEventListener('click', () => {
    soundEnabled = !soundEnabled;
    const icon = document.getElementById('sound-icon');
    if (icon) icon.setAttribute('data-lucide', soundEnabled ? 'volume-2' : 'volume-x');
    if (typeof lucide !== 'undefined') lucide.createIcons();
    sfx.click();
  });

  // ── 6. Auth: DOM Refs ─────────────────────────────────────────────────────
  const authBackdrop   = document.getElementById('auth-modal-backdrop');
  const appWrapper     = document.getElementById('app-wrapper');
  const authForm       = document.getElementById('auth-form');
  const authUser       = document.getElementById('auth-username');
  const authPass       = document.getElementById('auth-password');
  const authError      = document.getElementById('auth-error-msg');
  const authSubmitBtn  = document.getElementById('auth-submit-btn');
  const authTabLogin   = document.getElementById('auth-tab-login');
  const authTabSignup  = document.getElementById('auth-tab-signup');
  let   authMode       = 'login';

  authTabLogin.addEventListener('click', () => {
    authMode = 'login';
    authTabLogin.classList.add('active');
    authTabSignup.classList.remove('active');
    authSubmitBtn.textContent = 'Login to Gateway';
    authError.style.display = 'none';
  });

  authTabSignup.addEventListener('click', () => {
    authMode = 'signup';
    authTabSignup.classList.add('active');
    authTabLogin.classList.remove('active');
    authSubmitBtn.textContent = 'Register Account';
    authError.style.display = 'none';
  });

  authForm.addEventListener('submit', async e => {
    e.preventDefault();
    authError.style.display = 'none';
    const username = authUser.value.trim();
    const password = authPass.value;
    try {
      if (authMode === 'signup') {
        await api('/api/signup','POST',{ username, password });
        showNotif('✅ Registered!','Account created. Now log in.','check-circle');
        authTabLogin.click();
        authPass.value = '';
      } else {
        const res = await api('/api/login','POST',{ username, password });
        authToken = res.token;
        localStorage.setItem('ft_token', authToken);
        showNotif('🔒 Welcome Back','Authentication successful.','shield');
        initApp();
      }
    } catch(err) {
      sfx.error();
      authError.textContent = err.message;
      authError.style.display = 'block';
    }
  });

  function doLogout() {
    authToken = null;
    localStorage.removeItem('ft_token');
    userProfile = null;
    if (ws) { ws.close(); ws = null; }
    appWrapper.classList.add('blurred-auth');
    authBackdrop.style.display = 'flex';
    authPass.value = '';
  }

  document.getElementById('btn-logout-portal').addEventListener('click', () => {
    sfx.error();
    doLogout();
  });

  // ── 7. Boot Application ───────────────────────────────────────────────────
  async function initApp() {
    try {
      userProfile = await api('/api/profile');
      appWrapper.classList.remove('blurred-auth');
      authBackdrop.style.display = 'none';
      updateSidebar();
      buildInterestsGrid();
      connectWS();
      switchView('home');
    } catch(e) {
      doLogout();
    }
  }

  // ── 8. Sidebar / UI Sync ──────────────────────────────────────────────────
  function levelConfig(lvl) {
    let cfg = LEVEL_MAP[1];
    for (const k of Object.keys(LEVEL_MAP).map(Number).sort((a,b)=>a-b)) {
      if (lvl >= k) cfg = LEVEL_MAP[k];
    }
    return cfg;
  }

  function nextLevelConfig(lvl) {
    const keys = Object.keys(LEVEL_MAP).map(Number).sort((a,b)=>a-b);
    for (const k of keys) { if (k > lvl) return LEVEL_MAP[k]; }
    return LEVEL_MAP[keys[keys.length-1]];
  }

  function updateSidebar() {
    if (!userProfile) return;
    const lvl  = userProfile.level || 1;
    const cur  = levelConfig(lvl);
    const nxt  = nextLevelConfig(lvl);
    const xp   = userProfile.xp || 0;
    const pct  = nxt.min > cur.min ? Math.min(((xp-cur.min)/(nxt.min-cur.min))*100, 100) : 100;

    el('sidebar-name').textContent   = userProfile.display_name || 'Anonymous';
    el('sidebar-avatar').textContent = cur.emoji;
    el('sidebar-title').textContent  = cur.title;
    el('sidebar-level').textContent  = `Lvl ${lvl}`;
    el('sidebar-xp-bar').style.width = `${pct}%`;
    el('sidebar-xp-text').textContent= `${xp} / ${nxt.min} XP`;
    el('sidebar-karma').textContent  = userProfile.karma_points || 0;

    const premBadge = el('sidebar-premium-badge');
    const premStatus= el('premium-expiry-status');
    if (userProfile.is_premium) {
      premBadge.style.display  = 'flex';
      premStatus.textContent   = 'Premium Active 💎';
      premStatus.style.color   = 'var(--accent-pink)';
    } else {
      premBadge.style.display  = 'none';
      premStatus.textContent   = 'Free Member';
      premStatus.style.color   = 'var(--text-muted)';
    }

    const tokEl = el('ref-tokens-count');
    if (tokEl) tokEl.textContent = `${userProfile.referral_tokens || 0} Tokens`;

    // Confessions count on home
    api('/api/confessions').then(list => {
      const statEl = el('stat-confessions');
      if (statEl) statEl.textContent = list.length;
    }).catch(()=>{});

    // Populate settings fields
    safeSet('profile-name-input',    userProfile.display_name);
    safeSet('profile-gender-select', userProfile.gender);
    safeSet('profile-age-select',    userProfile.age_group);
    safeSet('profile-bio-input',     userProfile.bio);
    safeSet('profile-gpref-select',  userProfile.gender_pref);
  }

  // ── 9. WebSocket ──────────────────────────────────────────────────────────
  function connectWS() {
    if (ws) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/ws?token=${authToken}`);

    ws.onopen = () => console.log('WS connected');

    ws.onmessage = e => {
      const d = JSON.parse(e.data);
      if (d.type === 'stats') {
        safeText('stat-matching-pool', d.matching);
        safeText('stat-active-chats',  d.online);
      } else if (d.type === 'room_stats') {
        const pill = document.querySelector(`.room-btn-join[data-id="${d.room_id}"]`)
          ?.closest('.room-card')?.querySelector('.room-online-pill');
        if (pill) pill.textContent = `${d.online} online`;
        const badge = el('room-active-online');
        if (badge && activeRoom && activeRoom.id === d.room_id)
          badge.textContent = `${d.online} online`;
      } else if (d.type === 'matched') {
        onMatched(d);
      } else if (d.type === 'msg') {
        appendMsg('stranger', d.text);
        sfx.recv();
        el('chat-typing').style.display = 'none';
      } else if (d.type === 'typing') {
        el('chat-typing').style.display = d.active ? 'flex' : 'none';
      } else if (d.type === 'disconnected') {
        onPartnerLeft(d.reason);
      } else if (d.type === 'room_msg') {
        if (activeRoom && activeRoom.id === d.room_id) {
          appendRoomMsg(d.sender, d.text);
          sfx.recv();
        }
      }
    };

    ws.onclose = () => {
      ws = null;
      if (authToken) setTimeout(connectWS, 3000);
    };
  }

  function wsSend(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  // ── 10. Matchmaking ───────────────────────────────────────────────────────
  const chatIdle      = el('chat-state-idle');
  const chatSearching = el('chat-state-searching');
  const chatActive    = el('chat-state-active');
  const chatRating    = el('chat-state-rating');

  let searchInterval = null;
  let searchStart    = null;

  // Gender filter buttons
  document.querySelectorAll('#chat-filter-gender .select-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.val !== 'any' && !userProfile?.is_premium) {
        sfx.error();
        showNotif('💎 Premium Required','Gender filtering needs Premium.','gem');
        return;
      }
      document.querySelectorAll('#chat-filter-gender .select-btn').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      sfx.click();
    });
  });

  // Mode filter buttons
  document.querySelectorAll('#chat-filter-mode .select-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#chat-filter-mode .select-btn').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      sfx.click();
    });
  });

  el('btn-start-search').addEventListener('click', () => {
    if (!ws) return;
    initAudio();
    sfx.click();
    chatIdle.style.display = 'none';
    chatSearching.style.display = 'flex';
    searchStart = Date.now();
    el('search-elapsed').textContent = '0s';
    clearInterval(searchInterval);
    searchInterval = setInterval(() => {
      el('search-elapsed').textContent = `${Math.floor((Date.now()-searchStart)/1000)}s`;
    }, 1000);
    wsSend({ type:'find' });
  });

  el('btn-cancel-search').addEventListener('click', () => {
    wsSend({ type:'cancel_find' });
    clearInterval(searchInterval);
    sfx.click();
    chatSearching.style.display = 'none';
    chatIdle.style.display = 'flex';
  });

  function onMatched(payload) {
    clearInterval(searchInterval);
    sfx.match();
    chatSearching.style.display = 'none';
    chatActive.style.display    = 'flex';
    el('chat-messages').innerHTML = '';
    appendSysMsg('🔍 Connected with a stranger! Say hello.');
    appendSysMsg('💬 Be respectful. Stay anonymous until you choose to reveal.');

    chatSession = {
      isBot: !!payload.is_bot,
      userRevealed: false,
      partnerRevealed: false,
      botIdx: 0,
      botLines: [
        "Hey! What's up?",
        "Cool — I usually just browse here late at night.",
        "Honestly staying anonymous makes conversations easier.",
        "What are your main interests?",
        "Haha! By the way, want to reveal profiles?",
        "Let's click reveal and see each other! 😄"
      ]
    };
    activeStranger = payload.bot_profile || null;

    if (chatSession.isBot) scheduleBotReply(2500);
  }

  function scheduleBotReply(delay) {
    el('chat-typing').style.display = 'flex';
    botReplyTimer = setTimeout(() => {
      el('chat-typing').style.display = 'none';
      const line = chatSession.botLines[chatSession.botIdx++] || "...";
      appendMsg('stranger', line);
      sfx.recv();
    }, delay);
  }

  function onPartnerLeft(reason) {
    clearTimeout(botReplyTimer);
    el('chat-typing').style.display = 'none';
    sfx.error();
    chatActive.style.display = 'none';
    chatRating.style.display = 'flex';
    el('btn-reveal-accept').style.display   = 'inline-block';
    el('btn-reveal-decline').style.display  = 'inline-block';
    el('reveal-status-msg').style.display   = 'none';
    api('/api/profile').then(p=>{ userProfile=p; updateSidebar(); }).catch(()=>{});
  }

  // Send chat message
  const chatInput = el('chat-message-input');

  function sendChatMsg() {
    const text = chatInput.value.trim();
    if (!text || !chatSession) return;
    appendMsg('user', text);
    sfx.send();
    chatInput.value = '';
    if (chatSession.isBot) {
      clearTimeout(botReplyTimer);
      scheduleBotReply(3000);
    } else {
      wsSend({ type:'msg', text });
    }
  }

  chatInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') sendChatMsg();
    if (!chatSession?.isBot) {
      if (!isTypingSent) { wsSend({type:'typing',active:true}); isTypingSent=true; }
      clearTimeout(typingTimer);
      typingTimer = setTimeout(() => { wsSend({type:'typing',active:false}); isTypingSent=false; }, 1500);
    }
  });
  el('chat-btn-send').addEventListener('click', sendChatMsg);

  el('chat-btn-stop').addEventListener('click', () => {
    wsSend({ type:'stop' });
    onPartnerLeft('You stopped the chat.');
  });

  // Rating actions
  el('btn-rating-like').addEventListener('click', e => {
    sfx.click();
    e.currentTarget.classList.add('active');
    showNotif('👍 Partner Liked','Karma boost sent to your partner.','award');
  });

  el('btn-reveal-accept').addEventListener('click', () => {
    sfx.click();
    el('btn-reveal-accept').style.display  = 'none';
    el('btn-reveal-decline').style.display = 'none';
    const msg = el('reveal-status-msg');
    msg.textContent = 'Waiting for partner…';
    msg.style.display = 'block';
    setTimeout(() => {
      const p = activeStranger || { name:'Ghost_Chatter', bio:'Wandering the web.', interests:['Memes 😂','Tech 💻'] };
      msg.innerHTML = `
        <div style="color:var(--accent-green);font-weight:700;margin-bottom:8px">✅ PROFILES REVEALED!</div>
        <div class="glass-card-nested" style="background:rgba(255,255,255,.03);border-color:var(--accent-purple);padding:12px;border-radius:10px;margin-top:6px">
          <strong>Name:</strong> ${p.name || 'Unknown'}<br>
          <strong>Bio:</strong> ${p.bio || '—'}<br>
          <strong>Interests:</strong> ${Array.isArray(p.interests)?p.interests.join(', '):p.interests||'—'}
        </div>`;
      sfx.milestone();
    }, 2000);
  });

  el('btn-reveal-decline').addEventListener('click', () => {
    sfx.click();
    el('btn-reveal-accept').style.display  = 'none';
    el('btn-reveal-decline').style.display = 'none';
    el('reveal-status-msg').textContent = 'Reveal declined. Staying anonymous.';
    el('reveal-status-msg').style.display = 'block';
  });

  el('btn-rating-close').addEventListener('click', () => {
    sfx.click();
    el('btn-rating-like').classList.remove('active');
    chatRating.style.display = 'none';
    chatIdle.style.display   = 'flex';
    chatSession = null;
    activeStranger = null;
  });

  function appendMsg(sender, text) {
    const box   = el('chat-messages');
    const wrap  = document.createElement('div');
    wrap.className = `message-bubble-wrapper ${sender}`;
    const name = sender === 'user'
      ? (chatSession?.userRevealed    ? userProfile?.display_name : 'You')
      : (chatSession?.partnerRevealed ? (activeStranger?.name||'Stranger') : 'Stranger');
    wrap.innerHTML = `
      <span class="message-sender">${name}</span>
      <div class="message-bubble">${escHtml(text)}</div>
      <span class="message-timestamp">${timeStr()}</span>`;
    box.appendChild(wrap);
    box.scrollTop = box.scrollHeight;
  }

  function appendSysMsg(text) {
    const box = el('chat-messages');
    const d   = document.createElement('div');
    d.className   = 'system-chat-alert';
    d.textContent = text;
    box.appendChild(d);
    box.scrollTop = box.scrollHeight;
  }

  // ── 11. Themed Rooms ──────────────────────────────────────────────────────
  const roomsLobby = el('rooms-lobby-layout');
  const roomsFrame = el('room-active-frame');

  function renderRooms() {
    const grid = el('rooms-grid-list');
    if (!grid) return;
    grid.innerHTML = '';
    ROOMS_LIST.forEach(room => {
      const locked = room.vip && !userProfile?.is_premium;
      const card = document.createElement('div');
      card.className = `room-card glass-card${locked?' vip-locked':''}`;
      card.innerHTML = `
        ${room.vip ? '<div class="vip-ribbon">VIP</div>' : ''}
        <div class="room-card-header">
          <span class="room-emoji">${room.emoji}</span>
          <span class="room-online-pill">— online</span>
        </div>
        <h3 class="room-title">${room.name}</h3>
        <p class="room-desc">${room.desc}</p>
        <button class="btn btn-secondary btn-sm room-btn-join" data-id="${room.id}">
          ${locked ? '🔒 VIP Only' : 'Join Server'}
        </button>`;
      grid.appendChild(card);
    });

    if (typeof lucide !== 'undefined') lucide.createIcons();

    document.querySelectorAll('.room-btn-join').forEach(btn => {
      btn.addEventListener('click', () => {
        const id   = parseInt(btn.dataset.id);
        const room = ROOMS_LIST.find(r => r.id === id);
        if (room.vip && !userProfile?.is_premium) {
          sfx.error();
          showNotif('💎 Premium Required','VIP Lounge needs Premium.','gem');
          return;
        }
        enterRoom(room);
      });
    });
  }

  function enterRoom(room) {
    activeRoom = room;
    roomsLobby.style.display = 'none';
    roomsFrame.style.display = 'flex';
    el('room-active-emoji').textContent   = room.emoji;
    el('room-active-name').textContent    = room.name;
    el('room-active-desc').textContent    = room.desc;
    el('room-active-online').textContent  = '— online';
    el('room-messages').innerHTML = '';
    appendRoomSys(`🏠 Joined <strong>#${room.name}</strong> — say something!`);
    wsSend({ type:'join_room', room_id: room.id });
    sfx.click();
  }

  el('room-btn-back').addEventListener('click', () => {
    sfx.click();
    activeRoom = null;
    roomsFrame.style.display = 'none';
    roomsLobby.style.display = 'flex';
    renderRooms();
  });

  const roomInput = el('room-message-input');

  function sendRoomMsg() {
    const text = roomInput.value.trim();
    if (!text || !activeRoom) return;
    wsSend({ type:'room_msg', room_id: activeRoom.id, text });
    appendRoomMsg(`${userProfile?.display_name||'You'} (You)`, text);
    sfx.send();
    roomInput.value = '';
  }

  roomInput.addEventListener('keydown', e => { if(e.key==='Enter') sendRoomMsg(); });
  el('room-btn-send').addEventListener('click', sendRoomMsg);

  function appendRoomMsg(sender, text) {
    const box  = el('room-messages');
    const isSelf = sender.includes('(You)');
    const wrap = document.createElement('div');
    wrap.className = `message-bubble-wrapper ${isSelf?'user':'stranger'}`;
    wrap.innerHTML = `
      <span class="message-sender">${sender}</span>
      <div class="message-bubble">${escHtml(text)}</div>
      <span class="message-timestamp">${timeStr()}</span>`;
    box.appendChild(wrap);
    box.scrollTop = box.scrollHeight;
  }

  function appendRoomSys(html) {
    const box = el('room-messages');
    const d   = document.createElement('div');
    d.className = 'system-chat-alert';
    d.innerHTML = html;
    box.appendChild(d);
    box.scrollTop = box.scrollHeight;
  }

  // ── 12. Confessions ───────────────────────────────────────────────────────
  const confModal = el('confess-modal-backdrop');
  let confStyle   = '1';

  document.querySelectorAll('#confess-style-picker .color-option-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#confess-style-picker .color-option-btn').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      confStyle = btn.dataset.style || '1';
      sfx.click();
    });
  });

  el('btn-open-confess-modal').addEventListener('click', () => {
    el('confess-content').value = '';
    confModal.style.display = 'flex';
    sfx.click();
  });

  ['btn-close-confess-modal','btn-cancel-confess'].forEach(id => {
    el(id)?.addEventListener('click', () => { confModal.style.display='none'; sfx.click(); });
  });

  el('btn-submit-confess').addEventListener('click', async () => {
    const content = el('confess-content').value.trim();
    if (!content) return;
    try {
      await api('/api/confession','POST',{ content, style:confStyle });
      sfx.match();
      confModal.style.display = 'none';
      showNotif('📢 Confessed!','Your anonymous card is live on the timeline.','check-circle');
      renderConfessions();
      userProfile = await api('/api/profile');
      updateSidebar();
    } catch(err) {
      sfx.error();
      showNotif('🚫 Error', err.message,'x-circle');
    }
  });

  async function renderConfessions() {
    const timeline = el('confessions-timeline');
    if (!timeline) return;
    try {
      const list = await api('/api/confessions');
      timeline.innerHTML = '';
      if (list.length === 0) {
        timeline.innerHTML = `<div class="system-chat-alert" style="margin:30px auto">No confessions yet. Be the first! 🤫</div>`;
        return;
      }
      list.forEach(c => {
        const card = document.createElement('div');
        card.className = `confession-card glass-card style-${c.style||'1'}`;
        card.innerHTML = `
          <div class="confession-header">
            <span class="confession-badge-tag">#Secret</span>
            <span class="confession-time">${c.time||'Recently'}</span>
          </div>
          <p class="confession-body">"${escHtml(c.content)}"</p>
          <div class="confession-footer">
            <button class="confession-like-btn" data-id="${c.id}">
              <i data-lucide="heart"></i>
              <span class="likes-count">${c.likes||0}</span>
            </button>
          </div>`;
        timeline.appendChild(card);
      });
      if (typeof lucide !== 'undefined') lucide.createIcons();

      document.querySelectorAll('.confession-like-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (btn.classList.contains('liked')) return;
          try {
            await api(`/api/confession/${btn.dataset.id}/like`,'POST');
            btn.classList.add('liked');
            btn.querySelector('.likes-count').textContent =
              parseInt(btn.querySelector('.likes-count').textContent) + 1;
            sfx.match();
          } catch(e) {}
        });
      });
    } catch(e) {
      console.warn('Confessions failed', e);
    }
  }

  // ── 13. Leaderboard ───────────────────────────────────────────────────────
  document.querySelectorAll('.lb-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.lb-tab').forEach(t=>t.classList.remove('active'));
      tab.classList.add('active');
      sfx.click();
      renderLeaderboard(tab.dataset.cat);
    });
  });

  async function renderLeaderboard(cat='karma') {
    try {
      const list = await api(`/api/leaderboard?category=${cat}`);
      const podium = el('leaderboard-podium');
      if (podium) {
        podium.innerHTML = '';
        const order = [list[1], list[0], list[2]];
        const ranks  = [2, 1, 3];
        order.forEach((item, i) => {
          if (!item) return;
          const step = document.createElement('div');
          step.className = `podium-step rank-${ranks[i]}`;
          step.innerHTML = `
            ${ranks[i]===1?'<div class="podium-crown">👑</div>':''}
            <div class="podium-avatar">${item.avatar||'🌱'}</div>
            <div class="podium-name">${item.display_name}</div>
            <div class="podium-score">${item.score}</div>
            <div class="podium-column">${ranks[i]}</div>`;
          podium.appendChild(step);
        });
      }
      const tbody = el('leaderboard-tbody');
      if (tbody) {
        tbody.innerHTML = '';
        list.slice(3,10).forEach((row,i) => {
          const tr = document.createElement('tr');
          if (row.display_name === userProfile?.display_name)
            tr.style.background = 'rgba(139,92,246,.10)';
          tr.innerHTML = `
            <td class="rank-num">#${i+4}</td>
            <td><div class="user-cell"><span>${row.avatar}</span><span>${row.display_name}</span></div></td>
            <td>Lvl ${row.level}</td>
            <td class="score-cell">${row.score}</td>`;
          tbody.appendChild(tr);
        });
      }
    } catch(e) { console.warn('Leaderboard error',e); }
  }

  // ── 14. Premium & Calendar ────────────────────────────────────────────────
  el('btn-buy-premium').addEventListener('click', async () => {
    initAudio();
    sfx.click();
    showNotif('🛒 Upgrading…','Processing 250 Stars payment…','gem');
    try {
      await api('/api/premium/buy','POST');
      userProfile = await api('/api/profile');
      updateSidebar();
      sfx.milestone();
      showNotif('💎 Premium Unlocked!','Your account is now Premium.','gem');
      renderRooms();
    } catch(err) {
      sfx.error();
      showNotif('❌ Failed', err.message,'alert-circle');
    }
  });

  el('btn-cal-prev').addEventListener('click', () => {
    sfx.click();
    calMonth--;
    if (calMonth < 0) { calMonth=11; calYear--; }
    renderCalendar();
  });
  el('btn-cal-next').addEventListener('click', () => {
    sfx.click();
    calMonth++;
    if (calMonth > 11) { calMonth=0; calYear++; }
    renderCalendar();
  });

  function renderCalendar() {
    const grid = el('calendar-days-grid');
    const hdr  = el('cal-month-year');
    if (!grid || !hdr) return;
    const months = ['January','February','March','April','May','June',
                    'July','August','September','October','November','December'];
    hdr.textContent = `${months[calMonth]} ${calYear}`;
    grid.innerHTML  = '';

    const firstDay  = new Date(calYear, calMonth, 1).getDay();
    const totalDays = new Date(calYear, calMonth+1, 0).getDate();
    const today     = new Date();
    const isNow     = calMonth === today.getMonth() && calYear === today.getFullYear();
    const activeDays = (userProfile?.custom_premium_days||'').split(',').map(d=>d.trim()).filter(Boolean);

    for (let i=0; i<firstDay; i++) {
      const e = document.createElement('button');
      e.className = 'calendar-day-btn empty';
      grid.appendChild(e);
    }
    for (let d=1; d<=totalDays; d++) {
      const btn  = document.createElement('button');
      btn.className  = 'calendar-day-btn';
      btn.textContent = d;
      const ds = `${calYear}-${String(calMonth+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      if (isNow && d < today.getDate())    btn.classList.add('past');
      else if (activeDays.includes(ds))    btn.classList.add('active-premium');
      else if (selectedDates.includes(ds)) btn.classList.add('selected');
      btn.addEventListener('click', () => {
        sfx.click();
        if (btn.classList.contains('past') || btn.classList.contains('active-premium')) return;
        if (selectedDates.includes(ds)) {
          selectedDates = selectedDates.filter(x=>x!==ds);
          btn.classList.remove('selected');
        } else {
          selectedDates.push(ds);
          btn.classList.add('selected');
        }
      });
      grid.appendChild(btn);
    }
  }

  el('btn-activate-dates').addEventListener('click', async () => {
    if (!selectedDates.length) return;
    try {
      await api('/api/premium/activate-dates','POST', selectedDates);
      selectedDates = [];
      userProfile = await api('/api/profile');
      updateSidebar();
      renderCalendar();
      sfx.milestone();
      showNotif('📅 Dates Activated!','Premium days locked in.','calendar');
    } catch(err) {
      sfx.error();
      showNotif('❌ Failed', err.message,'alert-circle');
    }
  });

  // ── 15. Settings ──────────────────────────────────────────────────────────
  function buildInterestsGrid() {
    const grid = el('settings-interests-grid');
    if (!grid) return;
    grid.innerHTML = '';
    const active = (userProfile?.interests||'').split(',').map(t=>t.trim()).filter(Boolean);
    DEFAULT_INTEREST_TAGS.forEach(tag => {
      const btn = document.createElement('button');
      btn.className = `tag-select-btn${active.includes(tag)?' active':''}`;
      btn.textContent = tag;
      btn.addEventListener('click', () => {
        sfx.click();
        btn.classList.toggle('active');
        const current = (userProfile.interests||'').split(',').map(t=>t.trim()).filter(Boolean);
        if (btn.classList.contains('active')) {
          if (!current.includes(tag)) current.push(tag);
        } else {
          const idx = current.indexOf(tag);
          if (idx > -1) current.splice(idx,1);
        }
        userProfile.interests = current.join(',');
      });
      grid.appendChild(btn);
    });
  }

  el('btn-save-profile')?.addEventListener('click', async () => {
    const displayName = el('profile-name-input').value.trim();
    const gender      = el('profile-gender-select').value;
    const ageGroup    = el('profile-age-select').value;
    const bio         = el('profile-bio-input').value.trim();
    if (displayName.length < 2) {
      sfx.error();
      showNotif('⚠️ Too Short','Display name must be at least 2 characters.','alert-triangle');
      return;
    }
    try {
      await api('/api/profile','POST',{ displayName, gender, ageGroup, bio });
      userProfile = await api('/api/profile');
      updateSidebar();
      sfx.match();
      showNotif('👤 Profile Saved','Your profile has been updated.','check-circle');
    } catch(err) {
      sfx.error();
      showNotif('❌ Error', err.message,'alert-circle');
    }
  });

  el('btn-save-interests')?.addEventListener('click', async () => {
    const genderPref = el('profile-gpref-select').value;
    const interests  = (userProfile.interests||'').split(',').map(t=>t.trim()).filter(Boolean);
    try {
      await api('/api/profile/preferences','POST',{ genderPref, interests });
      userProfile = await api('/api/profile');
      updateSidebar();
      sfx.match();
      showNotif('🎯 Preferences Saved','Your matching preferences are live.','check-circle');
    } catch(err) {
      sfx.error();
      showNotif('❌ Error', err.message,'alert-circle');
    }
  });

  el('btn-generate-link-code')?.addEventListener('click', async () => {
    sfx.click();
    try {
      const res = await api('/api/telegram/link-code');
      el('settings-link-code').textContent = res.code;
      showNotif('🔗 Code Ready','Use /link '+res.code+' in the Telegram bot.','link');
    } catch(err) {
      sfx.error();
      showNotif('❌ Error', err.message,'alert-circle');
    }
  });

  // ── 16. Notification Toast ────────────────────────────────────────────────
  let notifTO = null;

  function showNotif(title, msg, icon='info') {
    clearTimeout(notifTO);
    const popup = el('custom-notification');
    if (!popup) return;
    el('notif-title').textContent   = title;
    el('notif-message').textContent = msg;
    const ic = el('notif-icon');
    if (ic) ic.innerHTML = `<i data-lucide="${icon}"></i>`;
    popup.classList.add('show');
    if (typeof lucide !== 'undefined') lucide.createIcons();
    notifTO = setTimeout(() => popup.classList.remove('show'), 4500);
  }

  // ── 17. Helpers ───────────────────────────────────────────────────────────
  function el(id)           { return document.getElementById(id); }
  function safeText(id, v)  { const e=el(id); if(e) e.textContent=v; }
  function safeSet(id, v)   { const e=el(id); if(e) e.value=v||''; }
  function timeStr()        { return new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}); }
  function escHtml(str)     { return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  // ── 18. Boot ─────────────────────────────────────────────────────────────
  if (authToken) {
    initApp();
  } else {
    appWrapper.classList.add('blurred-auth');
    authBackdrop.style.display = 'flex';
  }

});
