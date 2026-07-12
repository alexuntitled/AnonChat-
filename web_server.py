import asyncio
import os
import random
import string
import hashlib
from typing import Dict, List, Set
from datetime import datetime, date

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Header, Depends, status
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from bot.database.connection import get_db
from bot.database.models import init_db

app = FastAPI(title="Fusion Talk Server")

# Allow CORS for codespace flexibility
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Password Hashing Helper ──────────────────────────────────────────
def hash_password(password: str) -> str:
    salt = "incognito_salt_984"
    return hashlib.sha256((password + salt).encode()).hexdigest()

# ── Session Memory Store ─────────────────────────────────────────────
# token -> user_id
active_sessions: Dict[str, int] = {}

# ── Pydantic Request Models ──────────────────────────────────────────
class AuthModel(BaseModel):
    username: str
    password: str

class ProfileUpdateModel(BaseModel):
    displayName: str
    gender: str
    ageGroup: str
    bio: str

class PrefUpdateModel(BaseModel):
    genderPref: str
    interests: List[str]

class ConfessionModel(BaseModel):
    content: str
    style: str

# ── Dependency: Get Web User from Token ──────────────────────────────
async def get_current_user_id(authorization: str = Header(None)) -> int:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid authentication token")
    token = authorization.split(" ")[1]
    if token not in active_sessions:
        raise HTTPException(status_code=401, detail="Session expired. Please log in again")
    return active_sessions[token]

# ── Setup DB WAL mode on Startup ─────────────────────────────────────
@app.on_event("startup")
async def on_startup():
    await init_db()
    db = await get_db()
    # Enable Write-Ahead Logging for high concurrency SQLite access
    await db.execute("PRAGMA journal_mode=WAL")
    await db.commit()

# ── REST API: Authentication ──────────────────────────────────────────

@app.post("/api/signup")
async def signup(data: AuthModel):
    username = data.username.strip().lower()
    password = data.password
    
    if len(username) < 3 or len(password) < 4:
        raise HTTPException(status_code=400, detail="Username must be >= 3 and password >= 4 chars")
    
    db = await get_db()
    
    # Check uniqueness
    cursor = await db.execute("SELECT id FROM web_users WHERE username = ?", (username,))
    if await cursor.fetchone() is not None:
        raise HTTPException(status_code=400, detail="Username already exists")
    
    password_hash = hash_password(password)
    
    # Insert web user
    await db.execute(
        """INSERT INTO web_users (username, password_hash, display_name)
           VALUES (?, ?, ?)""",
        (username, password_hash, f"User_{username[:4]}")
    )
    await db.commit()
    
    return {"message": "Signup successful!"}

@app.post("/api/login")
async def login(data: AuthModel):
    username = data.username.strip().lower()
    password = data.password
    
    db = await get_db()
    
    cursor = await db.execute(
        "SELECT id, password_hash FROM web_users WHERE username = ?", (username,)
    )
    row = await cursor.fetchone()
    if row is None:
        raise HTTPException(status_code=400, detail="Invalid username or password")
    
    user_id, stored_hash = row
    if hash_password(password) != stored_hash:
        raise HTTPException(status_code=400, detail="Invalid username or password")
    
    # Generate session token
    token = "".join(random.choices(string.ascii_letters + string.digits, k=32))
    active_sessions[token] = user_id
    
    return {"token": token}

# ── REST API: Profile management ──────────────────────────────────────

@app.get("/api/profile")
async def get_profile(user_id: int = Depends(get_current_user_id)):
    db = await get_db()
    cursor = await db.execute("SELECT * FROM web_users WHERE id = ?", (user_id,))
    row = await cursor.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Profile not found")
    
    user_dict = dict(row)
    
    # Check Telegram premium linkage
    if user_dict.get("telegram_id"):
        cursor_tg = await db.execute(
            "SELECT is_premium FROM users WHERE user_id = ?", (user_dict["telegram_id"],)
        )
        tg_row = await cursor_tg.fetchone()
        if tg_row and tg_row[0] == 1:
            user_dict["is_premium"] = 1

    # Check custom premium days check (referral days)
    today_str = date.today().isoformat()
    if user_dict.get("custom_premium_days"):
        active_days = [d.strip() for d in user_dict["custom_premium_days"].split(",") if d.strip()]
        if today_str in active_days:
            user_dict["is_premium"] = 1
            
    # Clean sensitive fields before output
    user_dict.pop("password_hash", None)
    
    return user_dict

@app.post("/api/profile")
async def update_profile(data: ProfileUpdateModel, user_id: int = Depends(get_current_user_id)):
    db = await get_db()
    await db.execute(
        """UPDATE web_users 
           SET display_name = ?, gender = ?, age_group = ?, bio = ?
           WHERE id = ?""",
        (data.displayName, data.gender, data.ageGroup, data.bio, user_id)
    )
    await db.commit()
    return {"message": "Profile updated!"}

@app.post("/api/profile/preferences")
async def update_preferences(data: PrefUpdateModel, user_id: int = Depends(get_current_user_id)):
    db = await get_db()
    
    # Premium check for gender matching filter
    if data.genderPref != 'any':
        cursor = await db.execute("SELECT is_premium FROM web_users WHERE id = ?", (user_id,))
        p_row = await cursor.fetchone()
        if not p_row or p_row[0] == 0:
            raise HTTPException(status_code=403, detail="Gender matching filter requires premium")
            
    interests_str = ",".join(data.interests)
    await db.execute(
        """UPDATE web_users 
           SET gender_pref = ?, interests = ?
           WHERE id = ?""",
        (data.genderPref, interests_str, user_id)
    )
    await db.commit()
    return {"message": "Matchmaking preferences saved!"}

# ── REST API: Confessions ─────────────────────────────────────────────

@app.get("/api/confessions")
async def get_confessions():
    db = await get_db()
    cursor = await db.execute("SELECT * FROM confessions ORDER BY id DESC LIMIT 50")
    rows = await cursor.fetchall()
    
    # Map rooms output
    conf_list = []
    for r in rows:
        conf_dict = dict(r)
        # Mock times nicely
        conf_dict["time"] = "Recently"
        conf_list.append(conf_dict)
        
    return conf_list

@app.post("/api/confession")
async def post_confession(data: ConfessionModel, user_id: int = Depends(get_current_user_id)):
    content = data.content.strip()
    if not content:
        raise HTTPException(status_code=400, detail="Content cannot be empty")
        
    db = await get_db()
    # Insert confession directly
    await db.execute(
        """INSERT INTO confessions (user_id, content, status, likes)
           VALUES (?, ?, 'approved', 0)""",
        (user_id, content)
    )
    # Reward XP for submission
    await db.execute(
        "UPDATE web_users SET xp = xp + 15, karma_points = karma_points + 5 WHERE id = ?",
        (user_id,)
    )
    await db.commit()
    return {"message": "Confession posted!"}

@app.post("/api/confession/{id}/like")
async def like_confession(id: int, user_id: int = Depends(get_current_user_id)):
    db = await get_db()
    await db.execute("UPDATE confessions SET likes = likes + 1 WHERE id = ?", (id,))
    # Reward author
    cursor_author = await db.execute("SELECT user_id FROM confessions WHERE id = ?", (id,))
    author_row = await cursor_author.fetchone()
    if author_row:
        author_id = author_row[0]
        await db.execute(
            "UPDATE web_users SET xp = xp + 5, karma_points = karma_points + 3 WHERE id = ?",
            (author_id,)
        )
    await db.commit()
    return {"message": "Confession liked!"}

# ── REST API: Leaderboard ─────────────────────────────────────────────

@app.get("/api/leaderboard")
async def get_leaderboard(category: str = "karma"):
    db = await get_db()
    
    column = "karma_points"
    if category == "xp":
        column = "xp"
    elif category == "chats":
        column = "total_chats"
        
    # Get top users combining web users and Telegram users to display real-time ranks
    cursor = await db.execute(
        f"SELECT display_name, {column} as score, level, '🌱' as avatar FROM web_users "
        f"ORDER BY {column} DESC LIMIT 15"
    )
    rows = await cursor.fetchall()
    
    leaderboard = []
    for r in rows:
        d = dict(r)
        # Assign matching avatar emoji based on level thresholds
        lvl = d.get("level", 1)
        if lvl >= 20: d["avatar"] = "🔥"
        elif lvl >= 15: d["avatar"] = "👑"
        elif lvl >= 10: d["avatar"] = "💎"
        elif lvl >= 5: d["avatar"] = "⭐"
        elif lvl >= 3: d["avatar"] = "🌳"
        elif lvl >= 2: d["avatar"] = "🌿"
        leaderboard.append(d)
        
    return leaderboard

# ── REST API: Premium Operations ──────────────────────────────────────

@app.post("/api/premium/buy")
async def buy_premium(user_id: int = Depends(get_current_user_id)):
    db = await get_db()
    await db.execute("UPDATE web_users SET is_premium = 1, xp = xp + 50 WHERE id = ?", (user_id,))
    await db.commit()
    return {"message": "Premium status upgraded!"}

@app.post("/api/premium/activate-dates")
async def activate_premium_dates(dates: List[str], user_id: int = Depends(get_current_user_id)):
    db = await get_db()
    
    cursor = await db.execute("SELECT referral_tokens, custom_premium_days FROM web_users WHERE id = ?", (user_id,))
    row = await cursor.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="User not found")
        
    tokens, current_days_str = row
    if tokens < len(dates):
        raise HTTPException(status_code=400, detail="Insufficient referral tokens")
        
    current_days = [d.strip() for d in current_days_str.split(",") if d.strip()]
    for d in dates:
        if d not in current_days:
            current_days.append(d)
            
    updated_days_str = ",".join(current_days)
    new_tokens = tokens - len(dates)
    
    await db.execute(
        "UPDATE web_users SET referral_tokens = ?, custom_premium_days = ? WHERE id = ?",
        (new_tokens, updated_days_str, user_id)
    )
    await db.commit()
    return {"message": "Dates activated!"}

@app.get("/api/telegram/link-code")
async def get_link_code(user_id: int = Depends(get_current_user_id)):
    db = await get_db()
    
    # Check if code already exists
    cursor = await db.execute("SELECT token FROM linking_tokens WHERE web_user_id = ?", (user_id,))
    row = await cursor.fetchone()
    if row:
        return {"code": row[0]}
        
    # Generate new random 6 digit code
    code = "".join(random.choices(string.digits, k=6))
    await db.execute(
        "INSERT INTO linking_tokens (token, web_user_id) VALUES (?, ?)",
        (code, user_id)
    )
    await db.commit()
    
    return {"code": code}

# ── 13. Real-Time WebSockets Engine ─────────────────────────────────────

# Active Web Connection Sockets Tracker
class ConnectionManager:
    def __init__(self):
        # ws -> user_id
        self.active_connections: Dict[WebSocket, int] = {}
        # user_id -> ws
        self.user_websockets: Dict[int, WebSocket] = {}
        
        # Matchmaking Queue (user_id list)
        self.matching_queue: List[int] = []
        
        # Active matched pairs: user_id -> user_id
        self.active_matches: Dict[int, int] = {}
        # Active match websocket pairs: ws -> ws
        self.websocket_pairs: Dict[WebSocket, WebSocket] = {}
        
        # Room subscribers: room_id -> list of websockets
        self.room_connections: Dict[int, List[WebSocket]] = {}

    async def connect(self, websocket: WebSocket, user_id: int):
        await websocket.accept()
        self.active_connections[websocket] = user_id
        self.user_websockets[user_id] = websocket
        await self.broadcast_global_stats()

    async def disconnect(self, websocket: WebSocket):
        user_id = self.active_connections.pop(websocket, None)
        if user_id:
            self.user_websockets.pop(user_id, None)
            # Remove from matching queue
            if user_id in self.matching_queue:
                self.matching_queue.remove(user_id)
            # Remove matching pairs
            partner_id = self.active_matches.pop(user_id, None)
            if partner_id:
                self.active_matches.pop(partner_id, None)
                # Notify partner
                partner_ws = self.user_websockets.get(partner_id)
                if partner_ws:
                    try:
                        await partner_ws.send_json({"type": "disconnected", "reason": "Partner left the chat"})
                    except Exception:
                        pass
                        
            partner_ws = self.websocket_pairs.pop(websocket, None)
            if partner_ws:
                self.websocket_pairs.pop(partner_ws, None)
                
        # Remove from room active registers
        for r_id in list(self.room_connections.keys()):
            if websocket in self.room_connections[r_id]:
                self.room_connections[r_id].remove(websocket)
                await self.broadcast_room_stats(r_id)
                
        await self.broadcast_global_stats()

    # Matchmaking & Relays
    async def request_match(self, websocket: WebSocket):
        user_id = self.active_connections.get(websocket)
        if not user_id:
            return
            
        if user_id in self.matching_queue:
            return
            
        self.matching_queue.append(user_id)
        await self.broadcast_global_stats()
        
        # Run match looping
        asyncio.create_task(self.process_match(user_id))

    async def process_match(self, user_id: int):
        await asyncio.sleep(0.5) # micro pause to allow queueing
        ws = self.user_websockets.get(user_id)
        if not ws or user_id not in self.matching_queue:
            return
            
        # Try to match with another searching web user
        candidates = [uid for uid in self.matching_queue if uid != user_id]
        if candidates:
            partner_id = candidates[0]
            
            # Pop both
            self.matching_queue.remove(user_id)
            self.matching_queue.remove(partner_id)
            
            # Sync session matching
            self.active_matches[user_id] = partner_id
            self.active_matches[partner_id] = user_id
            
            ws_partner = self.user_websockets.get(partner_id)
            self.websocket_pairs[ws] = ws_partner
            self.websocket_pairs[ws_partner] = ws
            
            # Load display tags
            db = await get_db()
            cursor_u = await db.execute("SELECT display_name, gender, age_group FROM web_users WHERE id = ?", (user_id,))
            u_row = await cursor_u.fetchone()
            
            cursor_p = await db.execute("SELECT display_name, gender, age_group FROM web_users WHERE id = ?", (partner_id,))
            p_row = await cursor_p.fetchone()
            
            u_name = u_row[0] if u_row else "Stranger"
            p_name = p_row[0] if p_row else "Stranger"
            
            # Send match payloads
            try:
                await ws.send_json({
                    "type": "matched", 
                    "partner_name": "Stranger",
                    "gender": p_row[1] if p_row else "unset", 
                    "age": p_row[2] if p_row else "unset"
                })
            except Exception:
                pass
                
            try:
                await ws_partner.send_json({
                    "type": "matched", 
                    "partner_name": "Stranger",
                    "gender": u_row[1] if u_row else "unset", 
                    "age": u_row[2] if u_row else "unset"
                })
            except Exception:
                pass
                
            await self.broadcast_global_stats()
            return
            
        # Fallback to AI Companion bot after 4 seconds of searching
        await asyncio.sleep(3.5)
        ws = self.user_websockets.get(user_id)
        if ws and user_id in self.matching_queue:
            self.matching_queue.remove(user_id)
            
            # Select random preset personality
            preset = random.choice([
                {"name": "Alex", "avatar": "🎮", "gender": "male", "age": "18-24", "interests": "Gaming, Tech", "bio": "React dev and gamer."},
                {"name": "Sophia", "avatar": "🧠", "gender": "female", "age": "25-34", "interests": "Philosophy, Art", "bio": "Coffee and Camus."},
                {"name": "Emma", "avatar": "🎵", "gender": "female", "age": "25-34", "interests": "Music, Art", "bio": "Indie band vocalist."}
            ])
            
            try:
                await ws.send_json({
                    "type": "matched",
                    "partner_name": "Stranger",
                    "gender": preset["gender"],
                    "age": preset["age"],
                    "is_bot": True,
                    "bot_profile": preset
                })
            except Exception:
                pass
                
            await self.broadcast_global_stats()

    async def relay_message(self, websocket: WebSocket, text: str):
        partner_ws = self.websocket_pairs.get(websocket)
        if partner_ws:
            try:
                await partner_ws.send_json({"type": "msg", "text": text})
            except Exception:
                pass

    async def relay_typing(self, websocket: WebSocket, active: bool):
        partner_ws = self.websocket_pairs.get(websocket)
        if partner_ws:
            try:
                await partner_ws.send_json({"type": "typing", "active": active})
            except Exception:
                pass

    async def cancel_match(self, websocket: WebSocket):
        user_id = self.active_connections.get(websocket)
        if user_id in self.matching_queue:
            self.matching_queue.remove(user_id)
        await self.broadcast_global_stats()

    # Rooms Messaging
    async def join_room(self, websocket: WebSocket, room_id: int):
        if room_id not in self.room_connections:
            self.room_connections[room_id] = []
        self.room_connections[room_id].append(websocket)
        await self.broadcast_room_stats(room_id)

    async def broadcast_room_message(self, room_id: int, sender_name: str, text: str):
        if room_id in self.room_connections:
            # Relays room text payload to all active room subscribers
            dead_sockets = []
            for ws in self.room_connections[room_id]:
                try:
                    await ws.send_json({
                        "type": "room_msg",
                        "sender": sender_name,
                        "text": text,
                        "room_id": room_id
                    })
                except Exception:
                    dead_sockets.append(ws)
            # Cleanup inactive sockets
            for ws in dead_sockets:
                self.room_connections[room_id].remove(ws)

    # Real-Time Broadcast Metrics
    async def broadcast_global_stats(self):
        online_count = len(self.active_connections)
        matching_count = len(self.matching_queue) + len(self.active_matches)
        
        # Broadcast globally to all active websockets
        dead_sockets = []
        for ws in self.active_connections.keys():
            try:
                await ws.send_json({
                    "type": "stats",
                    "online": max(online_count, 1),
                    "matching": matching_count
                })
            except Exception:
                dead_sockets.append(ws)
                
        for ws in dead_sockets:
            self.active_connections.pop(ws, None)

    async def broadcast_room_stats(self, room_id: int):
        count = len(self.room_connections.get(room_id, []))
        
        # Notify all active room subscribers
        dead_sockets = []
        for ws in self.active_connections.keys():
            try:
                await ws.send_json({
                    "type": "room_stats",
                    "room_id": room_id,
                    "online": max(count, 1) + 2 # Add static +2 to simulate background user fluctuations
                })
            except Exception:
                dead_sockets.append(ws)
                
        for ws in dead_sockets:
            self.active_connections.pop(ws, None)

manager = ConnectionManager()

# Background Chatter Task to simulate themed room logs when active
async def room_background_chatter_loop():
    ROOM_BOT_CHATTERS = [
        {"name": "MemeLord 🦖", "text": "Me when the compiler throws 82 errors: *closes laptop*"},
        {"name": "CoffeeBrain ☕", "text": "Highly recommend trying cold brew with oat milk today."},
        {"name": "RetroVibe 🌙", "text": "Anyone listening to the synthwave playlist? It sounds beautiful."},
        {"name": "TechExplorer 💻", "text": "Just finished upgrading my sqlite schemas, works like a charm!"},
        {"name": "GamerX 🎮", "text": "Who is down for a fast match in Elden Ring? DM me."}
    ]
    
    while True:
        await asyncio.sleep(random.randint(6, 12))
        active_rooms = list(manager.room_connections.keys())
        if active_rooms:
            target_room = random.choice(active_rooms)
            if manager.room_connections[target_room]:
                bot = random.choice(ROOM_BOT_CHATTERS)
                await manager.broadcast_room_message(target_room, bot["name"], bot["text"])

@app.on_event("startup")
async def start_chatter_task():
    asyncio.create_task(room_background_chatter_loop())

# ── WebSocket Handler routes ──────────────────────────────────────────

@app.websocket("/ws")
async def websocket_gateway(websocket: WebSocket, token: str = "guest"):
    # Authenticate token
    user_id = active_sessions.get(token)
    if not user_id:
        # Close connection if unauthorized
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return
        
    await manager.connect(websocket, user_id)
    
    try:
        while True:
            data = await websocket.receive_json()
            msg_type = data.get("type")
            
            if msg_type == "find":
                await manager.request_match(websocket)
            elif msg_type == "cancel_find":
                await manager.cancel_match(websocket)
            elif msg_type == "msg":
                await manager.relay_message(websocket, data.get("text", ""))
            elif msg_type == "typing":
                await manager.relay_typing(websocket, data.get("active", False))
            elif msg_type == "join_room":
                room_id = int(data.get("room_id", 0))
                await manager.join_room(websocket, room_id)
            elif msg_type == "room_msg":
                room_id = int(data.get("room_id", 0))
                # Fetch user name from DB
                db = await get_db()
                cursor = await db.execute("SELECT display_name FROM web_users WHERE id = ?", (user_id,))
                row = await cursor.fetchone()
                sender = row[0] if row else "Anonymous"
                await manager.broadcast_room_message(room_id, sender, data.get("text", ""))
            elif msg_type == "stop":
                partner_ws = manager.websocket_pairs.get(websocket)
                if partner_ws:
                    try:
                        await partner_ws.send_json({"type": "disconnected", "reason": "Stranger stopped chatting"})
                    except Exception:
                        pass
                await manager.disconnect(websocket)
                # Reconnect standard gateway
                await manager.connect(websocket, user_id)
                
    except WebSocketDisconnect:
        await manager.disconnect(websocket)
    except Exception as e:
        print("WS Error:", e)
        await manager.disconnect(websocket)

# ── Mount static folder last ──────────────────────────────────────────
if os.path.exists("web"):
    app.mount("/", StaticFiles(directory="web", html=True), name="static")
