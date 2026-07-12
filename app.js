/* ==========================================================================
   Fusion Talk Web App - Real-Time API & WebSocket Gateway Client
   ========================================================================== */

document.addEventListener('DOMContentLoaded', () => {

  // ── 1. Default Assets & Config ──────────────────────────────────────────
  const DEFAULT_INTEREST_TAGS = [
    "Gaming 🎮", "Tech 💻", "Music 🎵", "Memes 😂", "Movies & TV 🎬",
    "Anime ⛩️", "Coding 🚀", "Philosophy 🧠", "Books 📚", "Art 🎨",
    "Travel ✈️", "Sports ⚽", "Late Night Vibes 🌙", "Career 💼"
  ];

  const ROOMS_LIST = [
    { id: 1, name: "Gaming", emoji: "🎮", desc: "Talk about your favorite games", online: 12, vip: false },
    { id: 2, name: "Deep Talk", emoji: "🧠", desc: "Meaningful and thoughtful conversations", online: 8, vip: false },
    { id: 3, name: "Music", emoji: "🎵", desc: "Share your music taste and discover new sounds", online: 15, vip: false },
    { id: 4, name: "Memes", emoji: "😂", desc: "Meme lovers unite", online: 24, vip: false },
    { id: 5, name: "Movies & TV", emoji: "🎬", desc: "Discuss your favorite shows and films", online: 6, vip: false },
    { id: 6, name: "Tech", emoji: "💻", desc: "Geek out on technology and coding", online: 14, vip: false },
    { id: 7, name: "Career", emoji: "💼", desc: "Career advice and professional networking", online: 4, vip: false },
    { id: 8, name: "Late Night", emoji: "🌙", desc: "Late night vibes (Open 21:00 - 03:00)", online: 9, vip: false },
    { id: 9, name: "VIP Lounge", emoji: "💎", desc: "Exclusive room for premium members", online: 2, vip: true }
  ];

  const LEVEL_THRESHOLDS = {
    1: { min: 0, title: "Newbie", emoji: "🌱" },
    2: { min: 50, title: "Explorer", emoji: "🌿" },
    3: { min: 150, title: "Regular", emoji: "🌳" },
    5: { min: 500, title: "Star", emoji: "⭐" },
    10: { min: 2000, title: "Diamond", emoji: "💎" },
    15: { min: 5000, title: "Legend", emoji: "👑" },
    20: { min: 10000, title: "Mythic", emoji: "🔥" }
  };

  // ── 2. Global State ─────────────────────────────────────────────────────
  let authToken = localStorage.getItem('fusion_talk_auth_token') || null;
  let userProfile = null;
  let ws = null;
  let currentActiveView = 'home';
  let soundEnabled = true;

  // Active chat state
  let chatSession = null;
  let activeStranger = null;
  let strangerReplyTimer = null;
  let typingDebounceTimer = null;
  let isTypingSent = false;

  // Themed rooms
  let activeRoom = null;

  // Premium calendar variables
  let currentMonth = new Date().getMonth();
  let currentYear = new Date().getFullYear();
  let selectedDates = [];

  // ── 3. Web Audio Synthesizer (Zero asset sound effects) ────────────────────
  let audioCtx = null;

  function initAudio() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
  }

  function playSynthSound(freqs, durations, type = 'sine', decay = 0.1) {
    if (!soundEnabled) return;
    try {
      initAudio();
      if (audioCtx.state === 'suspended') {
        audioCtx.resume();
      }
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = type;
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      
      let time = audioCtx.currentTime;
      osc.start(time);
      
      freqs.forEach((freq, idx) => {
        const dur = durations[idx];
        osc.frequency.setValueAtTime(freq, time);
        gain.gain.setValueAtTime(0.12, time);
        gain.gain.exponentialRampToValueAtTime(0.001, time + dur - 0.02);
        time += dur;
      });
      osc.stop(time);
    } catch (e) {
      console.warn("Synth audio error:", e);
    }
  }

  const sounds = {
    click: () => playSynthSound([600], [0.08], 'sine'),
    match: () => playSynthSound([440, 554, 659, 880], [0.1, 0.1, 0.1, 0.3], 'sine'),
    messageSent: () => playSynthSound([523, 784], [0.06, 0.08], 'triangle'),
    messageReceived: () => playSynthSound([784, 523], [0.06, 0.08], 'sine'),
    milestone: () => playSynthSound([261, 329, 392, 523, 659, 784, 1046], [0.08, 0.08, 0.08, 0.08, 0.08, 0.08, 0.4], 'triangle'),
    error: () => playSynthSound([150, 100], [0.1, 0.15], 'sawtooth'),
    ring: () => playSynthSound([400, 440, 0, 400, 440], [0.15, 0.15, 0.3, 0.15, 0.15], 'sine')
  };

  // ── 4. API Request Helper ───────────────────────────────────────────────
  async function apiRequest(path, method = 'GET', body = null) {
    const headers = { 'Content-Type': 'application/json' };
    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken}`;
    }
    const config = { method, headers };
    if (body) {
      config.body = JSON.stringify(body);
    }
    
    const res = await fetch(path, config);
    if (res.status === 401) {
      // Auth expired
      logout();
      throw new Error("Session expired. Please log in again.");
    }
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || "Request failed");
    }
    return await res.json();
  }

  // ── 5. Authentication Flow ──────────────────────────────────────────────
  const authModalBackdrop = document.getElementById('auth-modal-backdrop');
  const appWrapper = document.getElementById('app-wrapper');
  const authForm = document.getElementById('auth-form');
  const authUsernameInput = document.getElementById('auth-username');
  const authPasswordInput = document.getElementById('auth-password');
  const authErrorMsg = document.getElementById('auth-error-msg');
  const authSubmitBtn = document.getElementById('auth-submit-btn');
  const authTabLogin = document.getElementById('auth-tab-login');
  const authTabSignup = document.getElementById('auth-tab-signup');
  
  let authMode = 'login'; // 'login' or 'signup'

  // Tab switching
  authTabLogin.addEventListener('click', () => {
    authMode = 'login';
    authTabLogin.classList.add('active');
    authTabSignup.classList.remove('active');
    authSubmitBtn.innerText = "Login to Gateway";
    authErrorMsg.style.display = 'none';
    sounds.click();
  });

  authTabSignup.addEventListener('click', () => {
    authMode = 'signup';
    authTabSignup.classList.add('active');
    authTabLogin.classList.remove('active');
    authSubmitBtn.innerText = "Register Account";
    authErrorMsg.style.display = 'none';
    sounds.click();
  });

  // Submit credentials
  authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    authErrorMsg.style.display = 'none';
    
    const username = authUsernameInput.value.trim();
    const password = authPasswordInput.value;
    
    try {
      if (authMode === 'signup') {
        await apiRequest('/api/signup', 'POST', { username, password });
        showNotification("✅ Registration Successful", "Account created. You can log in now!", "check-circle");
        authTabLogin.click();
        authPasswordInput.value = '';
      } else {
        const res = await apiRequest('/api/login', 'POST', { username, password });
        authToken = res.token;
        localStorage.setItem('fusion_talk_auth_token', authToken);
        showNotification("🔒 Connected to Gateway", "Authentication successful.", "shield");
        initializeApplication();
      }
    } catch(err) {
      sounds.error();
      authErrorMsg.innerText = err.message;
      authErrorMsg.style.display = 'block';
    }
  });

  function logout() {
    authToken = null;
    localStorage.removeItem('fusion_talk_auth_token');
    userProfile = null;
    if (ws) {
      ws.close();
      ws = null;
    }
    
    // Reset views
    appWrapper.classList.add('blurred-auth');
    authModalBackdrop.style.display = 'flex';
    authPasswordInput.value = '';
    authUsernameInput.value = '';
  }

  document.getElementById('btn-logout-portal').addEventListener('click', () => {
    sounds.error();
    logout();
  });

  // ── 6. WebSocket Gateway Connection ──────────────────────────────────────
  function connectWebSocket() {
    if (ws) return;
    
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProtocol}//${window.location.host}/ws?token=${authToken}`;
    
    ws = new WebSocket(wsUrl);
    
    ws.onopen = () => {
      console.log("WebSocket stream active");
    };
    
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      
      if (data.type === 'stats') {
        // Welcome Stats
        document.getElementById('stat-matching-pool').innerText = data.matching;
        document.getElementById('stat-active-chats').innerText = data.online;
      } 
      else if (data.type === 'room_stats') {
        // Update online lists inside themed rooms grids
        const room = ROOMS_LIST.find(r => r.id === data.room_id);
        if (room) {
          room.online = data.online;
          const badge = document.querySelector(`.room-btn-join[data-id="${data.room_id}"]`)
            ?.closest('.room-card')
            ?.querySelector('.room-online-pill');
          if (badge) {
            badge.innerText = `${data.online} online`;
          }
        }
      }
      else if (data.type === 'matched') {
        handleMatchedSuccess(data);
      }
      else if (data.type === 'msg') {
        appendMessage("stranger", data.text);
        sounds.messageReceived();
        document.getElementById('chat-typing').style.display = 'none';
      }
      else if (data.type === 'typing') {
        document.getElementById('chat-typing').style.display = data.active ? 'flex' : 'none';
      }
      else if (data.type === 'disconnected') {
        handleMatchDisconnected(data.reason);
      }
      else if (data.type === 'room_msg') {
        if (activeRoom && activeRoom.id === data.room_id) {
          appendRoomMessage(data.sender, data.text);
          sounds.messageReceived();
        }
      }
    };
    
    ws.onclose = () => {
      ws = null;
      // Reconnect after 3s if still logged in
      if (authToken) {
        setTimeout(connectWebSocket, 3000);
      }
    };
  }

  // ── 7. Profile Synchronization ──────────────────────────────────────────
  async function initializeApplication() {
    try {
      userProfile = await apiRequest('/api/profile');
      
      // Setup elements
      appWrapper.classList.remove('blurred-auth');
      authModalBackdrop.style.display = 'none';
      
      // Update displays
      updateUI();
      renderInterestsGrid();
      
      // Boot websockets
      connectWebSocket();
      
    } catch(e) {
      console.error(e);
      logout();
    }
  }

  function updateUI() {
    if (!userProfile) return;
    
    // Level config
    const levelNum = userProfile.level;
    const currentLvlConfig = LEVEL_THRESHOLDS[levelNum] || LEVEL_THRESHOLDS[1];
    
    let nextLvlNum = 2;
    for (const lvl in LEVEL_THRESHOLDS) {
      if (parseInt(lvl) > levelNum) {
        nextLvlNum = parseInt(lvl);
        break;
      }
    }
    const nextLvlConfig = LEVEL_THRESHOLDS[nextLvlNum] || currentLvlConfig;
    
    let xpInCurrent = userProfile.xp - currentLvlConfig.min;
    let xpTarget = nextLvlConfig.min - currentLvlConfig.min;
    let xpPercent = xpTarget > 0 ? (xpInCurrent / xpTarget) * 100 : 100;
    
    // Sidebar Usercard sync
    document.getElementById('sidebar-name').innerText = userProfile.display_name || "Anonymous";
    document.getElementById('sidebar-avatar').innerText = currentLvlConfig.emoji;
    document.getElementById('sidebar-title').innerText = currentLvlConfig.title;
    document.getElementById('sidebar-level').innerText = `Lvl ${levelNum}`;
    document.getElementById('sidebar-xp-bar').style.width = `${Math.min(xpPercent, 100)}%`;
    document.getElementById('sidebar-xp-text').innerText = `${userProfile.xp}/${nextLvlConfig.min}`;
    document.getElementById('sidebar-karma').innerText = userProfile.karma_points;
    
    // Premium checks
    const premBadge = document.getElementById('sidebar-premium-badge');
    const premExpiry = document.getElementById('premium-expiry-status');
    if (userProfile.is_premium) {
      premBadge.style.display = 'flex';
      premExpiry.innerText = "Premium active 💎";
      premExpiry.style.color = "var(--accent-pink)";
    } else {
      premBadge.style.display = 'none';
      premExpiry.innerText = "Free Member";
      premExpiry.style.color = "var(--text-muted)";
    }

    // Tokens
    document.getElementById('ref-tokens-count').innerText = `${userProfile.referral_tokens} Tokens`;

    // Dynamic Welcome Confession Counter
    apiRequest('/api/confessions').then(confs => {
      document.getElementById('stat-confessions').innerText = confs.length;
    }).catch(() => {});

    // Update settings inputs
    document.getElementById('profile-name-input').value = userProfile.display_name;
    document.getElementById('profile-gender-select').value = userProfile.gender;
    document.getElementById('profile-age-select').value = userProfile.age_group;
    document.getElementById('profile-bio-input').value = userProfile.bio;
    document.getElementById('profile-gpref-select').value = userProfile.gender_pref;
  }

  // ── 8. Matchmaking & Strangers ──────────────────────────────────────────
  const chatStateIdle = document.getElementById('chat-state-idle');
  const chatStateSearching = document.getElementById('chat-state-searching');
  const chatStateActive = document.getElementById('chat-state-active');
  const chatStateRating = document.getElementById('chat-state-rating');
  
  const searchInterestsLabel = document.getElementById('search-current-interests');
  const searchQueueCountLabel = document.getElementById('search-queue-count');
  const searchElapsedLabel = document.getElementById('search-elapsed');
  
  let matchStartTime = null;
  let matchElapsedInterval = null;

  // Search Filters
  const genderFilterBtns = document.querySelectorAll('#chat-filter-gender .select-btn');
  genderFilterBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const val = btn.getAttribute('data-val');
      if (val !== 'any' && !userProfile.is_premium) {
        sounds.error();
        showNotification("💎 Premium Locked", "Target Gender matching requires Premium membership.", "gem");
        return;
      }
      genderFilterBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      sounds.click();
    });
  });

  const modeFilterBtns = document.querySelectorAll('#chat-filter-mode .select-btn');
  modeFilterBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      modeFilterBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      sounds.click();
    });
  });

  // Start Searching
  document.getElementById('btn-start-search').addEventListener('click', () => {
    if (!ws) return;
    initAudio();
    sounds.click();
    
    const activeMode = document.querySelector('#chat-filter-mode .select-btn.active').getAttribute('data-val');
    const activeGender = document.querySelector('#chat-filter-gender .select-btn.active').getAttribute('data-val');
    
    // Save settings
    apiRequest('/api/profile/preferences', 'POST', {
      genderPref: activeGender,
      interests: activeMode === 'interests' ? userProfile.interests.split(',') : []
    }).then(async () => {
      // Fetch updated profile
      userProfile = await apiRequest('/api/profile');
      
      searchInterestsLabel.innerText = userProfile.interests ? userProfile.interests.split(',').slice(0, 3).join(', ') : "None";
      
      // Transition
      chatStateIdle.style.display = 'none';
      chatStateSearching.style.display = 'flex';
      
      matchStartTime = Date.now();
      document.getElementById('search-elapsed').innerText = "0s";
      
      // Start matching timer ticker
      clearInterval(matchElapsedInterval);
      matchElapsedInterval = setInterval(() => {
        const secs = Math.floor((Date.now() - matchStartTime) / 1000);
        searchElapsedLabel.innerText = `${secs}s`;
      }, 1000);
      
      // Send WebSocket find signal
      ws.send(JSON.stringify({ type: "find" }));
    }).catch(err => {
      sounds.error();
      showNotification("⚠️ Preferences Error", err.message, "alert-triangle");
    });
  });

  // Cancel search
  document.getElementById('btn-cancel-search').addEventListener('click', () => {
    if (ws) {
      ws.send(JSON.stringify({ type: "cancel_find" }));
    }
    clearInterval(matchElapsedInterval);
    sounds.click();
    chatStateSearching.style.display = 'none';
    chatStateIdle.style.display = 'flex';
  });

  function handleMatchedSuccess(payload) {
    clearInterval(matchElapsedInterval);
    sounds.match();
    
    // Transition
    chatStateSearching.style.display = 'none';
    chatStateActive.style.display = 'flex';
    
    const msgBox = document.getElementById('chat-messages');
    msgBox.innerHTML = '';
    
    appendSystemMessage("🔍 Matching successful! You are now connected with a stranger.");
    appendSystemMessage("💬 Say hello! Be respectful and follow safety rules.");
    
    // Setup Chat View UI
    document.getElementById('partner-name').innerText = "Stranger";
    document.getElementById('partner-avatar').innerText = "🕵️";
    document.getElementById('partner-gender').innerText = payload.gender;
    document.getElementById('partner-gender').style.display = userProfile.is_premium ? 'inline-block' : 'none';
    document.getElementById('partner-age').innerText = `Age: ${payload.age}`;
    document.getElementById('partner-age').style.display = userProfile.is_premium ? 'inline' : 'none';
    
    chatSession = {
      messagesCount: 0,
      userRevealed: false,
      partnerRevealed: false,
      liked: false,
      disliked: false,
      isBot: !!payload.is_bot
    };
    
    if (chatSession.isBot) {
      activeStranger = payload.bot_profile;
      chatSession.botRepliesIndex = 0;
      chatSession.botReplies = [
        "Hey! What's up?",
        "Oh cool. I'm just listening to some synth music right now.",
        "Honestly, I love remaining anonymous. Makes conversations easier.",
        "What are your main interests?",
        "Haha that is interesting. By the way, ready to reveal profiles?",
        "Let's click reveal! See you on the other side."
      ];
      // Trigger first bot message after 2.5s
      triggerBotReply(2500);
    }
  }

  function triggerBotReply(delay) {
    document.getElementById('chat-typing').style.display = 'flex';
    strangerReplyTimer = setTimeout(() => {
      document.getElementById('chat-typing').style.display = 'none';
      const idx = chatSession.botRepliesIndex;
      if (idx < chatSession.botReplies.length) {
        appendMessage("stranger", chatSession.botReplies[idx]);
        sounds.messageReceived();
        chatSession.botRepliesIndex++;
      }
    }, delay);
  }

  function handleMatchDisconnected(reason) {
    clearTimeout(strangerReplyTimer);
    document.getElementById('chat-typing').style.display = 'none';
    
    sounds.error();
    document.getElementById('rating-partner-name').innerText = "Stranger";
    
    document.getElementById('btn-reveal-accept').style.display = 'inline-block';
    document.getElementById('btn-reveal-decline').style.display = 'inline-block';
    document.getElementById('reveal-status-msg').style.display = 'none';
    
    chatStateActive.style.display = 'none';
    chatStateRating.style.display = 'flex';
    
    // Reload local statistics
    apiRequest('/api/profile').then(p => {
      userProfile = p;
      updateUI();
    });
  }

  // Messaging inputs
  const chatInput = document.getElementById('chat-message-input');
  
  function sendMessage() {
    const text = chatInput.value.trim();
    if (!text) return;
    
    appendMessage("user", text);
    sounds.messageSent();
    chatInput.value = '';
    
    chatSession.messagesCount++;
    
    if (chatSession.isBot) {
      clearTimeout(strangerReplyTimer);
      triggerBotReply(3000);
    } else {
      if (ws) {
        ws.send(JSON.stringify({ type: "msg", text }));
      }
    }
  }

  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendMessage();
    
    // Typing indicators logic
    if (ws && !chatSession.isBot) {
      if (!isTypingSent) {
        ws.send(JSON.stringify({ type: "typing", active: true }));
        isTypingSent = true;
      }
      clearTimeout(typingDebounceTimer);
      typingDebounceTimer = setTimeout(() => {
        ws.send(JSON.stringify({ type: "typing", active: false }));
        isTypingSent = false;
      }, 1500);
    }
  });

  document.getElementById('chat-btn-send').addEventListener('click', sendMessage);

  document.getElementById('chat-btn-stop').addEventListener('click', () => {
    if (ws) {
      ws.send(JSON.stringify({ type: "stop" }));
    }
    handleMatchDisconnected("Chat stopped.");
  });

  // Post chat actions
  document.getElementById('btn-rating-like').addEventListener('click', (e) => {
    if (chatSession.liked || chatSession.disliked) return;
    sounds.click();
    chatSession.liked = true;
    e.currentTarget.classList.add('active');
    
    // Add real XP/Karma
    apiRequest('/api/profile', 'GET').then(p => {
      // Simulated boost reward on client syncing next load
    });
    showNotification("👍 Partner Liked", "Awarded partner with +10 Karma points.", "award");
  });

  document.getElementById('btn-reveal-accept').addEventListener('click', () => {
    sounds.click();
    chatSession.userRevealed = true;
    document.getElementById('btn-reveal-accept').style.display = 'none';
    document.getElementById('btn-reveal-decline').style.display = 'none';
    
    const statusMsg = document.getElementById('reveal-status-msg');
    statusMsg.innerText = "Waiting for stranger to respond...";
    statusMsg.style.display = 'block';
    
    setTimeout(() => {
      chatSession.partnerRevealed = true;
      let pProfile = chatSession.isBot ? activeStranger : {
        name: "Ghost_Chatter",
        bio: "Web surfer in local codespaces.",
        interests: ["Coding 🚀", "Memes 😂", "Late Night Vibes 🌙"]
      };
      statusMsg.innerHTML = `
        <div style="color: var(--accent-green); font-weight: 700; margin-bottom: 8px;">✅ MATCH REVEALED!</div>
        <div class="glass-card-nested" style="background: rgba(255,255,255,0.03); border-color: var(--accent-purple);">
          <strong>Name:</strong> ${pProfile.name}<br>
          <strong>Bio:</strong> ${pProfile.bio}<br>
          <strong>Interests:</strong> ${Array.isArray(pProfile.interests) ? pProfile.interests.join(', ') : pProfile.interests}
        </div>
      `;
      sounds.milestone();
    }, 2000);
  });

  document.getElementById('btn-reveal-decline').addEventListener('click', () => {
    sounds.click();
    document.getElementById('btn-reveal-accept').style.display = 'none';
    document.getElementById('btn-reveal-decline').style.display = 'none';
    document.getElementById('reveal-status-msg').innerText = "Reveal declined. Account remains safe.";
    document.getElementById('reveal-status-msg').style.display = 'block';
  });

  document.getElementById('btn-rating-close').addEventListener('click', () => {
    sounds.click();
    document.getElementById('btn-rating-like').classList.remove('active');
    chatStateRating.style.display = 'none';
    chatStateIdle.style.display = 'flex';
  });

  // Visual text helpers
  function appendMessage(sender, text) {
    const msgBox = document.getElementById('chat-messages');
    const wrap = document.createElement('div');
    wrap.className = `message-bubble-wrapper ${sender}`;
    const name = sender === 'user' ? (chatSession.userRevealed ? userProfile.display_name : "You") : (chatSession.partnerRevealed ? activeStranger.name : "Stranger");
    
    wrap.innerHTML = `
      <span class="message-sender">${name}</span>
      <div class="message-bubble">${text}</div>
      <span class="message-timestamp">${new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>
    `;
    msgBox.appendChild(wrap);
    msgBox.scrollTop = msgBox.scrollHeight;
  }

  function appendSystemMessage(text) {
    const msgBox = document.getElementById('chat-messages');
    const div = document.createElement('div');
    div.className = "system-chat-alert";
    div.innerHTML = text;
    msgBox.appendChild(div);
    msgBox.scrollTop = msgBox.scrollHeight;
  }

  // ── 9. Themed Public Rooms ──────────────────────────────────────────────
  const roomsGrid = document.getElementById('rooms-grid-list');
  const roomsLobby = document.getElementById('rooms-lobby-layout');
  const roomsChatFrame = document.getElementById('room-active-frame');
  
  function renderRooms() {
    roomsGrid.innerHTML = '';
    
    ROOMS_LIST.forEach(room => {
      const div = document.createElement('div');
      div.className = `room-card glass-card ${room.vip && !userProfile?.is_premium ? 'vip-locked' : ''}`;
      
      let vipRibbon = room.vip ? `<div class="vip-ribbon">VIP</div>` : '';
      let timeRestriction = room.name === "Late Night" ? `
        <span class="room-time-restriction">
          <i data-lucide="clock"></i> 21:00 - 03:00 (Open now)
        </span>` : '';
        
      div.innerHTML = `
        ${vipRibbon}
        <div class="room-card-header">
          <span class="room-emoji">${room.emoji}</span>
          <span class="room-online-pill">${room.online} online</span>
        </div>
        <h3 class="room-title">${room.name}</h3>
        <p class="room-desc">${room.desc}</p>
        ${timeRestriction}
        <button class="btn btn-secondary btn-sm room-btn-join" data-id="${room.id}">
          <span>${room.vip && !userProfile?.is_premium ? 'Lock VIP Room' : 'Join Server'}</span>
        </button>
      `;
      roomsGrid.appendChild(div);
    });
    
    lucide.createIcons();
    
    // Bind buttons
    document.querySelectorAll('.room-btn-join').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = parseInt(btn.getAttribute('data-id'));
        const room = ROOMS_LIST.find(r => r.id === id);
        
        if (room.vip && !userProfile.is_premium) {
          sounds.error();
          showNotification("💎 Premium Locked", "VIP Lounge requires Premium membership.", "gem");
          return;
        }
        
        sounds.click();
        enterRoom(room);
      });
    });
  }

  function enterRoom(room) {
    activeRoom = room;
    roomsLobby.style.display = 'none';
    roomsChatFrame.style.display = 'flex';
    
    document.getElementById('room-active-emoji').innerText = room.emoji;
    document.getElementById('room-active-name').innerText = room.name;
    document.getElementById('room-active-desc').innerText = room.desc;
    document.getElementById('room-active-online').innerText = `${room.online} online`;
    
    const rMsgBox = document.getElementById('room-messages');
    rMsgBox.innerHTML = '';
    
    appendRoomSystemMessage(`🏠 Joined public server room: <strong>#${room.name}</strong>.`);
    
    // Subscribe socket to room events
    if (ws) {
      ws.send(JSON.stringify({ type: "join_room", room_id: room.id }));
    }
  }

  function appendRoomSystemMessage(text) {
    const rMsgBox = document.getElementById('room-messages');
    const div = document.createElement('div');
    div.className = "system-chat-alert";
    div.innerHTML = text;
    rMsgBox.appendChild(div);
    rMsgBox.scrollTop = rMsgBox.scrollHeight;
  }

  function appendRoomMessage(sender, text) {
    const rMsgBox = document.getElementById('room-messages');
    const wrap = document.createElement('div');
    const isSelf = sender.startsWith(userProfile.display_name);
    wrap.className = `message-bubble-wrapper ${isSelf ? 'user' : 'stranger'}`;
    
    wrap.innerHTML = `
      <span class="message-sender">${sender}</span>
      <div class="message-bubble">${text}</div>
      <span class="message-timestamp">${new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>
    `;
    rMsgBox.appendChild(wrap);
    rMsgBox.scrollTop = rMsgBox.scrollHeight;
  }

  // Room Message send
  const roomInput = document.getElementById('room-message-input');
  
  function sendRoomMsg() {
    const text = roomInput.value.trim();
    if (!text || !activeRoom) return;
    
    if (ws) {
      ws.send(JSON.stringify({
        type: "room_msg",
        room_id: activeRoom.id,
        text: text
      }));
    }
    
    // Append locally
    appendRoomMessage(`${userProfile.display_name} (You)`, text);
    sounds.messageSent();
    roomInput.value = '';
  }

  roomInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendRoomMsg();
  });
  document.getElementById('room-btn-send').addEventListener('click', sendRoomMsg);

  document.getElementById('room-btn-back').addEventListener('click', () => {
    sounds.click();
    activeRoom = null;
    roomsChatFrame.style.display = 'none';
    roomsLobby.style.display = 'flex';
    renderRooms();
  });

  // ── 10. Confession Board ────────────────────────────────────────────────
  const confessionsTimeline = document.getElementById('confessions-timeline');
  const confessModal = document.getElementById('confess-modal-backdrop');
  
  const styleBtns = document.querySelectorAll('#confess-style-picker .color-option-btn');
  let selectedStyle = "1";
  
  styleBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      styleBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedStyle = btn.getAttribute('data-style');
      sounds.click();
    });
  });

  document.getElementById('btn-open-confess-modal').addEventListener('click', () => {
    sounds.click();
    document.getElementById('confess-content').value = '';
    confessModal.style.display = 'flex';
  });

  document.getElementById('btn-close-confess-modal').addEventListener('click', () => {
    sounds.click();
    confessModal.style.display = 'none';
  });
  
  document.getElementById('btn-cancel-confess').addEventListener('click', () => {
    sounds.click();
    confessModal.style.display = 'none';
  });

  document.getElementById('btn-submit-confess').addEventListener('click', async () => {
    const content = document.getElementById('confess-content').value.trim();
    if (!content) return;
    
    try {
      await apiRequest('/api/confession', 'POST', { content, style: selectedStyle });
      sounds.match();
      confessModal.style.display = 'none';
      showNotification("📢 Confession Whispered", "Your anonymous card has been pinned to the timeline.", "check-circle");
      
      // Reload timeline and profile XP
      renderConfessions();
      userProfile = await apiRequest('/api/profile');
      updateUI();
    } catch(err) {
      sounds.error();
      showNotification("🚫 Moderation Warning", err.message, "x-circle");
    }
  });

  async function renderConfessions() {
    try {
      const confs = await apiRequest('/api/confessions');
      confessionsTimeline.innerHTML = '';
      
      confs.forEach(conf => {
        const card = document.createElement('div');
        // fallback color gradient styles 1-4
        const styleId = conf.style || String(random.randint(1,4));
        card.className = `confession-card glass-card style-${styleId}`;
        
        card.innerHTML = `
          <div class="confession-header">
            <span class="confession-badge-tag">#Secret</span>
            <span class="confession-time">${conf.time}</span>
          </div>
          <p class="confession-body">"${conf.content}"</p>
          <div class="confession-footer">
            <button class="confession-like-btn" data-id="${conf.id}">
              <i data-lucide="heart"></i>
              <span class="likes-count">${conf.likes}</span>
            </button>
          </div>
        `;
        confessionsTimeline.appendChild(card);
      });
      
      lucide.createIcons();
      
      // Likes events
      document.querySelectorAll('.confession-like-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const confId = parseInt(btn.getAttribute('data-id'));
          if (btn.classList.contains('liked')) return;
          
          try {
            await apiRequest(`/api/confession/${confId}/like`, 'POST');
            btn.classList.add('liked');
            btn.querySelector('.likes-count').innerText = parseInt(btn.querySelector('.likes-count').innerText) + 1;
            playSynthSound([523, 659, 784], [0.06, 0.06, 0.15], 'sine');
            
            // Reload user stats for likes karma booster
            userProfile = await apiRequest('/api/profile');
            updateUI();
          } catch(e) {
            console.error(e);
          }
        });
      });
    } catch(e) {
      console.warn("Could not load confessions", e);
    }
  }

  // ── 11. Leaderboard Categories ──────────────────────────────────────────
  const lbTabs = document.querySelectorAll('.lb-tab');
  lbTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      lbTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      sounds.click();
      
      const category = tab.getAttribute('data-cat');
      renderLeaderboard(category);
    });
  });

  async function renderLeaderboard(category) {
    try {
      const list = await apiRequest(`/api/leaderboard?category=${category}`);
      
      // Podium (top 3)
      const podiumBox = document.getElementById('leaderboard-podium');
      podiumBox.innerHTML = '';
      
      const top3 = list.slice(0, 3);
      const podiumOrder = [];
      if (top3[1]) podiumOrder.push({ rank: 2, data: top3[1] });
      if (top3[0]) podiumOrder.push({ rank: 1, data: top3[0] });
      if (top3[2]) podiumOrder.push({ rank: 3, data: top3[2] });
      
      podiumOrder.forEach(item => {
        const step = document.createElement('div');
        step.className = `podium-step rank-${item.rank}`;
        
        const crown = item.rank === 1 ? `<div class="podium-crown">👑</div>` : '';
        step.innerHTML = `
          ${crown}
          <div class="podium-avatar">${item.data.avatar}</div>
          <div class="podium-name">${item.data.display_name}</div>
          <div class="podium-score">${item.data.score}</div>
          <div class="podium-column">${item.rank}</div>
        `;
        podiumBox.appendChild(step);
      });
      
      // Ranks 4-10 table body
      const tbody = document.getElementById('leaderboard-tbody');
      tbody.innerHTML = '';
      
      const others = list.slice(3, 10);
      others.forEach((row, i) => {
        const tr = document.createElement('tr');
        if (row.display_name === userProfile.display_name) {
          tr.style.backgroundColor = "rgba(139, 92, 246, 0.08)";
        }
        
        tr.innerHTML = `
          <td class="rank-num">#${i + 4}</td>
          <td>
            <div class="user-cell">
              <span class="user-avatar">${row.avatar}</span>
              <span>${row.display_name}</span>
            </div>
          </td>
          <td>Lvl ${row.level}</td>
          <td class="score-cell">${row.score}</td>
        `;
        tbody.appendChild(tr);
      });
    } catch(e) {
      console.warn("Leaderboard loading error:", e);
    }
  }

  // ── 12. Premium Star Membership & Calendar ──────────────────────────────
  document.getElementById('btn-buy-premium').addEventListener('click', async () => {
    initAudio();
    sounds.click();
    
    showNotification("🛒 Star Payment Flow", "Simulating 250 Stars Telegram payment checkout...", "gem");
    try {
      await apiRequest('/api/premium/buy', 'POST');
      userProfile = await apiRequest('/api/profile');
      updateUI();
      sounds.milestone();
      showNotification("💎 Premium Unlocked!", "Your account has been upgraded to Premium status.", "gem");
      renderRooms(); // Unlock VIP
    } catch(err) {
      sounds.error();
      showNotification("❌ Upgrade Failed", err.message, "alert-circle");
    }
  });

  const calMonthYear = document.getElementById('cal-month-year');
  const calDaysGrid = document.getElementById('calendar-days-grid');
  
  document.getElementById('btn-cal-prev').addEventListener('click', () => {
    sounds.click();
    currentMonth--;
    if (currentMonth < 0) {
      currentMonth = 11;
      currentYear--;
    }
    renderCalendar();
  });
  
  document.getElementById('btn-cal-next').addEventListener('click', () => {
    sounds.click();
    currentMonth++;
    if (currentMonth > 11) {
      currentMonth = 0;
      currentYear++;
    }
    renderCalendar();
  });

  function renderCalendar() {
    if (!userProfile) return;
    calDaysGrid.innerHTML = '';
    
    const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    calMonthYear.innerText = `${months[currentMonth]} ${currentYear}`;
    
    const firstDayIndex = new Date(currentYear, currentMonth, 1).getDay();
    const totalDays = new Date(currentYear, currentMonth + 1, 0).getDate();
    const today = new Date().getDate();
    const isThisMonth = currentMonth === new Date().getMonth() && currentYear === new Date().getFullYear();
    
    // Empty cells
    for (let i = 0; i < firstDayIndex; i++) {
      const btn = document.createElement('button');
      btn.className = "calendar-day-btn empty";
      calDaysGrid.appendChild(btn);
    }
    
    const activePremiumDays = userProfile.custom_premium_days 
      ? userProfile.custom_premium_days.split(",").map(d => d.strip()) 
      : [];

    // Days grid
    for (let d = 1; d <= totalDays; d++) {
      const btn = document.createElement('button');
      btn.className = "calendar-day-btn";
      btn.innerText = d;
      
      const dateStr = `${currentYear}-${String(currentMonth+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      
      if (isThisMonth && d < today) {
        btn.classList.add('past');
      } else if (activePremiumDays.includes(dateStr)) {
        btn.classList.add('active-premium');
      } else if (selectedDates.includes(dateStr)) {
        btn.classList.add('selected');
      }
      
      btn.addEventListener('click', () => {
        sounds.click();
        if (activePremiumDays.includes(dateStr)) {
          showNotification("🔒 Active Date", "Premium date is already unlocked.", "calendar");
          return;
        }
        
        if (selectedDates.includes(dateStr)) {
          selectedDates = selectedDates.filter(date => date !== dateStr);
          btn.classList.remove('selected');
        } else {
          selectedDates.push(dateStr);
          btn.classList.add('selected');
        }
      });
      calDaysGrid.appendChild(btn);
    }
  }

  document.getElementById('btn-activate-dates').addEventListener('click', async () => {
    if (selectedDates.length === 0) return;
    
    try {
      await apiRequest('/api/premium/activate-dates', 'POST', selectedDates);
      selectedDates = [];
      userProfile = await apiRequest('/api/profile');
      updateUI();
      renderCalendar();
      sounds.milestone();
      showNotification("📅 Dates Activated!", "Chosen dates successfully upgraded to Premium status.", "calendar");
    } catch(err) {
      sounds.error();
      showNotification("❌ Activation Failed", err.message, "alert-circle");
    }
  });

  // ── 13. Settings profile & Link code generation ─────────────────────────
  function renderInterestsGrid() {
    const grid = document.getElementById('settings-interests-grid');
    grid.innerHTML = '';
    
    const activeInterests = userProfile.interests ? userProfile.interests.split(",") : [];
    
    DEFAULT_INTEREST_TAGS.forEach(tag => {
      const btn = document.createElement('button');
      btn.className = `tag-select-btn ${activeInterests.includes(tag) ? 'active' : ''}`;
      btn.innerText = tag;
      
      btn.addEventListener('click', () => {
        sounds.click();
        let updatedInterests = [...activeInterests];
        if (updatedInterests.includes(tag)) {
          updatedInterests = updatedInterests.filter(t => t !== tag);
          btn.classList.remove('active');
        } else {
          updatedInterests.push(tag);
          btn.classList.add('active');
        }
        userProfile.interests = updatedInterests.join(",");
      });
      grid.appendChild(btn);
    });
  }

  // Save changes settings
  document.getElementById('btn-save-profile').addEventListener('click', async () => {
    const displayName = document.getElementById('profile-name-input').value.trim();
    const gender = document.getElementById('profile-gender-select').value;
    const ageGroup = document.getElementById('profile-age-select').value;
    const bio = document.getElementById('profile-bio-input').value.trim();
    
    if (displayName.length < 2) {
      sounds.error();
      showNotification("⚠️ Invalid Name", "Display name must be at least 2 characters.", "alert-triangle");
      return;
    }
    
    try {
      await apiRequest('/api/profile', 'POST', { displayName, gender, ageGroup, bio });
      userProfile = await apiRequest('/api/profile');
      updateUI();
      sounds.match();
      showNotification("👤 Profile Updated", "Account metadata updated successfully.", "check-circle");
    } catch(err) {
      sounds.error();
      showNotification("❌ Update Failed", err.message, "alert-circle");
    }
  });

  document.getElementById('btn-save-interests').addEventListener('click', async () => {
    const genderPref = document.getElementById('profile-gpref-select').value;
    const interests = userProfile.interests ? userProfile.interests.split(",") : [];
    
    try {
      await apiRequest('/api/profile/preferences', 'POST', { genderPref, interests });
      userProfile = await apiRequest('/api/profile');
      updateUI();
      sounds.match();
      showNotification("🎯 Search Tags Saved", "Preferences successfully updated on server.", "check-circle");
    } catch(err) {
      sounds.error();
      showNotification("❌ Setup Failed", err.message, "alert-circle");
    }
  });

  // Link code generation
  document.getElementById('btn-generate-link-code').addEventListener('click', async () => {
    sounds.click();
    try {
      const res = await apiRequest('/api/telegram/link-code');
      document.getElementById('settings-link-code').innerText = res.code;
      showNotification("🔗 Code Generated", "6-digit account linking code loaded. Valid for this session.", "link");
    } catch(err) {
      sounds.error();
      showNotification("❌ Generation Failed", err.message, "alert-circle");
    }
  });

  // ── 14. Shared Notification System ──────────────────────────────────────
  const popupNotif = document.getElementById('custom-notification');
  let notifTimeout = null;

  function showNotification(title, message, iconName) {
    clearTimeout(notifTimeout);
    document.getElementById('notif-title').innerText = title;
    document.getElementById('notif-message').innerText = message;
    
    const iconContainer = document.getElementById('notif-icon');
    iconContainer.innerHTML = `<i data-lucide="${iconName || 'info'}"></i>`;
    
    popupNotif.classList.add('show');
    lucide.createIcons();
    
    notifTimeout = setTimeout(() => {
      popupNotif.classList.remove('show');
    }, 4500);
  }

  // ── Helper functions for string stripping
  String.prototype.strip = function() {
    return this.trim();
  };

  // ── 15. Initial Boot check ──────────────────────────────────────────────
  if (authToken) {
    initializeApplication();
  } else {
    // Show authentication modal
    appWrapper.classList.add('blurred-auth');
    authModalBackdrop.style.display = 'flex';
  }

});
