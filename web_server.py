"""
Fusion Talk Web Server - Fully Self-Contained Backend
No imports from bot/ — works as a standalone upload to GitHub Codespaces.
"""
import asyncio
import os
import random
import string
import hashlib
from typing import Dict, List, Optional
from datetime import datetime, date

import aiosqlite
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Header, Depends, status
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# ── Database Path (self-contained, no bot/ import needed) ───────────────────
DB_PATH = os.path.join(os.path.dirname(__file__), "data", "fusion_talk.db")

_db: Optional[aiosqlite.Connection] = None

async def get_db() -> aiosqlite.Connection:
    global _db
    if _db is None:
        os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
        _db = await aiosqlite.connect(DB_PATH)
        _db.row_factory = aiosqlite.Row
        await _db.execute("PRAGMA journal_mode=WAL")
        await _db.execute("PRAGMA foreign_keys=ON")
    return _db

# ── Inline Schema Definition ─────────────────────────────────────────────────
WEB_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS web_users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    display_name  TEXT NOT NULL DEFAULT 'Anonymous',
    gender        TEXT DEFAULT 'unset',
    age_group     TEXT DEFAULT 'unset',
    interests     TEXT DEFAULT '',
    bio           TEXT DEFAULT '',
    gender_pref   TEXT DEFAULT 'any',
    karma_points  INTEGER DEFAULT 0,
    xp            INTEGER DEFAULT 0,
    level         INTEGER DEFAULT 1,
    total_chats   INTEGER DEFAULT 0,
    is_premium    INTEGER DEFAULT 0,
    premium_until TIMESTAMP,
    telegram_id   INTEGER,
    referral_tokens INTEGER DEFAULT 3,
    custom_premium_days TEXT DEFAULT '',
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS linking_tokens (
    token         TEXT PRIMARY KEY,
    web_user_id   INTEGER NOT NULL,
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (web_user_id) REFERENCES web_users(id)
);

CREATE TABLE IF NOT EXISTS confessions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL,
    content       TEXT NOT NULL,
    style         TEXT DEFAULT '1',
    status        TEXT DEFAULT 'approved',
    likes         INTEGER DEFAULT 0,
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES web_users(id)
);
"""

async def init_web_db():
    """Create all web tables if they do not exist."""
    db = await get_db()
    await db.executescript(WEB_SCHEMA_SQL)
    await db.commit()

# ── Password Hashing ─────────────────────────────────────────────────────────
def hash_password(password: str) -> str:
    salt = "incognito_fusion_salt_984"
    return hashlib.sha256((password + salt).encode()).hexdigest()

# ── In-Memory Session Store: token -> user_id ────────────────────────────────
active_sessions: Dict[str, int] = {}

# ── Pydantic Request Models ───────────────────────────────────────────────────
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
    style: str = "1"

# ── Auth Dependency ───────────────────────────────────────────────────────────
async def get_current_user_id(authorization: str = Header(None)) -> int:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid token")
    token = authorization.split(" ")[1]
    user_id = active_sessions.get(token)
    if not user_id:
        raise HTTPException(status_code=401, detail="Session expired. Please log in again")
    return user_id

# ── FastAPI App ───────────────────────────────────────────────────────────────
app = FastAPI(title="Fusion Talk Gateway")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Startup: Init DB ──────────────────────────────────────────────────────────
@app.on_event("startup")
async def on_startup():
    await init_web_db()
    asyncio.create_task(room_background_chatter_loop())

# ═══════════════════════════════════════════════════════════════════════════════
# REST API
# ═══════════════════════════════════════════════════════════════════════════════

# ── Auth: Signup ──────────────────────────────────────────────────────────────
@app.post("/api/signup")
async def signup(data: AuthModel):
    username = data.username.strip().lower()
    password = data.password

    if len(username) < 3:
        raise HTTPException(status_code=400, detail="Username must be at least 3 characters")
    if len(password) < 4:
        raise HTTPException(status_code=400, detail="Password must be at least 4 characters")

    db = await get_db()
    cursor = await db.execute("SELECT id FROM web_users WHERE username = ?", (username,))
    if await cursor.fetchone():
        raise HTTPException(status_code=400, detail="Username already taken. Choose another.")

    password_hash = hash_password(password)
    display_name = f"User_{username[:6].capitalize()}"

    await db.execute(
        "INSERT INTO web_users (username, password_hash, display_name) VALUES (?, ?, ?)",
        (username, password_hash, display_name)
    )
    await db.commit()
    return {"message": "Account created successfully!"}

# ── Auth: Login ───────────────────────────────────────────────────────────────
@app.post("/api/login")
async def login(data: AuthModel):
    username = data.username.strip().lower()
    password = data.password

    db = await get_db()
    cursor = await db.execute(
        "SELECT id, password_hash FROM web_users WHERE username = ?", (username,)
    )
    row = await cursor.fetchone()
    if not row:
        raise HTTPException(status_code=400, detail="Invalid username or password")

    user_id, stored_hash = row
    if hash_password(password) != stored_hash:
        raise HTTPException(status_code=400, detail="Invalid username or password")

    token = "".join(random.choices(string.ascii_letters + string.digits, k=32))
    active_sessions[token] = user_id
    return {"token": token}

# ── Profile: Get ──────────────────────────────────────────────────────────────
@app.get("/api/profile")
async def get_profile(user_id: int = Depends(get_current_user_id)):
    db = await get_db()
    cursor = await db.execute("SELECT * FROM web_users WHERE id = ?", (user_id,))
    row = await cursor.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Profile not found")

    user_dict = dict(row)

    # Check custom premium days
    today_str = date.today().isoformat()
    days_str = user_dict.get("custom_premium_days", "") or ""
    active_days = [d.strip() for d in days_str.split(",") if d.strip()]
    if today_str in active_days:
        user_dict["is_premium"] = 1

    user_dict.pop("password_hash", None)
    return user_dict

# ── Profile: Update ───────────────────────────────────────────────────────────
@app.post("/api/profile")
async def update_profile(data: ProfileUpdateModel, user_id: int = Depends(get_current_user_id)):
    db = await get_db()
    await db.execute(
        "UPDATE web_users SET display_name=?, gender=?, age_group=?, bio=? WHERE id=?",
        (data.displayName, data.gender, data.ageGroup, data.bio, user_id)
    )
    await db.commit()
    return {"message": "Profile updated!"}

# ── Profile: Preferences ──────────────────────────────────────────────────────
@app.post("/api/profile/preferences")
async def update_preferences(data: PrefUpdateModel, user_id: int = Depends(get_current_user_id)):
    db = await get_db()

    if data.genderPref != "any":
        cur = await db.execute("SELECT is_premium FROM web_users WHERE id=?", (user_id,))
        row = await cur.fetchone()
        if not row or not row[0]:
            raise HTTPException(status_code=403, detail="Gender filter requires Premium membership")

    interests_str = ",".join(data.interests)
    await db.execute(
        "UPDATE web_users SET gender_pref=?, interests=? WHERE id=?",
        (data.genderPref, interests_str, user_id)
    )
    await db.commit()
    return {"message": "Preferences saved!"}

# ── Confessions ───────────────────────────────────────────────────────────────
@app.get("/api/confessions")
async def get_confessions():
    db = await get_db()
    cursor = await db.execute(
        "SELECT id, content, style, likes, created_at FROM confessions WHERE status='approved' ORDER BY id DESC LIMIT 50"
    )
    rows = await cursor.fetchall()
    result = []
    for r in rows:
        d = dict(r)
        # Friendly time label
        try:
            created = datetime.fromisoformat(d["created_at"])
            delta = datetime.utcnow() - created
            if delta.seconds < 3600:
                d["time"] = f"{delta.seconds // 60}m ago"
            elif delta.days == 0:
                d["time"] = f"{delta.seconds // 3600}h ago"
            else:
                d["time"] = f"{delta.days}d ago"
        except Exception:
            d["time"] = "Recently"
        result.append(d)
    return result

@app.post("/api/confession")
async def post_confession(data: ConfessionModel, user_id: int = Depends(get_current_user_id)):
    content = data.content.strip()
    if not content:
        raise HTTPException(status_code=400, detail="Content cannot be empty")

    db = await get_db()
    await db.execute(
        "INSERT INTO confessions (user_id, content, style, status, likes) VALUES (?, ?, ?, 'approved', 0)",
        (user_id, content, data.style)
    )
    await db.execute(
        "UPDATE web_users SET xp=xp+15, karma_points=karma_points+5 WHERE id=?", (user_id,)
    )
    await db.commit()
    return {"message": "Confession posted!"}

@app.post("/api/confession/{conf_id}/like")
async def like_confession(conf_id: int, user_id: int = Depends(get_current_user_id)):
    db = await get_db()
    await db.execute("UPDATE confessions SET likes=likes+1 WHERE id=?", (conf_id,))
    cur = await db.execute("SELECT user_id FROM confessions WHERE id=?", (conf_id,))
    author_row = await cur.fetchone()
    if author_row:
        await db.execute(
            "UPDATE web_users SET xp=xp+5, karma_points=karma_points+3 WHERE id=?",
            (author_row[0],)
        )
    await db.commit()
    return {"message": "Liked!"}

# ── Leaderboard ───────────────────────────────────────────────────────────────
@app.get("/api/leaderboard")
async def get_leaderboard(category: str = "karma"):
    db = await get_db()
    col_map = {"karma": "karma_points", "xp": "xp", "chats": "total_chats"}
    column = col_map.get(category, "karma_points")

    cursor = await db.execute(
        f"SELECT display_name, {column} as score, level FROM web_users ORDER BY {column} DESC LIMIT 15"
    )
    rows = await cursor.fetchall()
    result = []
    for r in rows:
        d = dict(r)
        lvl = d.get("level", 1)
        if lvl >= 20: d["avatar"] = "🔥"
        elif lvl >= 15: d["avatar"] = "👑"
        elif lvl >= 10: d["avatar"] = "💎"
        elif lvl >= 5: d["avatar"] = "⭐"
        elif lvl >= 3: d["avatar"] = "🌳"
        elif lvl >= 2: d["avatar"] = "🌿"
        else: d["avatar"] = "🌱"
        result.append(d)
    return result

# ── Premium ───────────────────────────────────────────────────────────────────
@app.post("/api/premium/buy")
async def buy_premium(user_id: int = Depends(get_current_user_id)):
    db = await get_db()
    await db.execute(
        "UPDATE web_users SET is_premium=1, xp=xp+50 WHERE id=?", (user_id,)
    )
    await db.commit()
    return {"message": "Premium activated!"}

@app.post("/api/premium/activate-dates")
async def activate_dates(dates: List[str], user_id: int = Depends(get_current_user_id)):
    db = await get_db()
    cur = await db.execute(
        "SELECT referral_tokens, custom_premium_days FROM web_users WHERE id=?", (user_id,)
    )
    row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="User not found")

    tokens, days_str = row
    if tokens < len(dates):
        raise HTTPException(status_code=400, detail="Not enough referral tokens")

    current = [d.strip() for d in (days_str or "").split(",") if d.strip()]
    for d in dates:
        if d not in current:
            current.append(d)

    await db.execute(
        "UPDATE web_users SET referral_tokens=?, custom_premium_days=? WHERE id=?",
        (tokens - len(dates), ",".join(current), user_id)
    )
    await db.commit()
    return {"message": "Dates activated!"}

# ── Telegram Link Code ────────────────────────────────────────────────────────
@app.get("/api/telegram/link-code")
async def get_link_code(user_id: int = Depends(get_current_user_id)):
    db = await get_db()
    cur = await db.execute(
        "SELECT token FROM linking_tokens WHERE web_user_id=?", (user_id,)
    )
    row = await cur.fetchone()
    if row:
        return {"code": row[0]}

    code = "".join(random.choices(string.digits, k=6))
    await db.execute(
        "INSERT OR REPLACE INTO linking_tokens (token, web_user_id) VALUES (?, ?)",
        (code, user_id)
    )
    await db.commit()
    return {"code": code}

# ═══════════════════════════════════════════════════════════════════════════════
# WebSocket Real-Time Engine
# ═══════════════════════════════════════════════════════════════════════════════
class ConnectionManager:
    def __init__(self):
        self.active_connections: Dict[WebSocket, int] = {}
        self.user_websockets: Dict[int, WebSocket] = {}
        self.matching_queue: List[int] = []
        self.active_matches: Dict[int, int] = {}
        self.websocket_pairs: Dict[WebSocket, WebSocket] = {}
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
            if user_id in self.matching_queue:
                self.matching_queue.remove(user_id)
            partner_id = self.active_matches.pop(user_id, None)
            if partner_id:
                self.active_matches.pop(partner_id, None)
                pws = self.user_websockets.get(partner_id)
                if pws:
                    try:
                        await pws.send_json({"type": "disconnected", "reason": "Partner left"})
                    except Exception:
                        pass
            pws2 = self.websocket_pairs.pop(websocket, None)
            if pws2:
                self.websocket_pairs.pop(pws2, None)

        for r_id in list(self.room_connections.keys()):
            if websocket in self.room_connections[r_id]:
                self.room_connections[r_id].remove(websocket)
                await self.broadcast_room_stats(r_id)
        await self.broadcast_global_stats()

    async def request_match(self, websocket: WebSocket):
        user_id = self.active_connections.get(websocket)
        if not user_id or user_id in self.matching_queue:
            return
        self.matching_queue.append(user_id)
        await self.broadcast_global_stats()
        asyncio.create_task(self.process_match(user_id))

    async def process_match(self, user_id: int):
        await asyncio.sleep(0.5)
        ws = self.user_websockets.get(user_id)
        if not ws or user_id not in self.matching_queue:
            return

        candidates = [uid for uid in self.matching_queue if uid != user_id]
        if candidates:
            partner_id = candidates[0]
            self.matching_queue.remove(user_id)
            self.matching_queue.remove(partner_id)
            self.active_matches[user_id] = partner_id
            self.active_matches[partner_id] = user_id
            pws = self.user_websockets.get(partner_id)
            self.websocket_pairs[ws] = pws
            self.websocket_pairs[pws] = ws

            db = await get_db()
            cur_u = await db.execute("SELECT gender, age_group FROM web_users WHERE id=?", (user_id,))
            cur_p = await db.execute("SELECT gender, age_group FROM web_users WHERE id=?", (partner_id,))
            u_row = await cur_u.fetchone()
            p_row = await cur_p.fetchone()

            try:
                await ws.send_json({
                    "type": "matched",
                    "partner_name": "Stranger",
                    "gender": p_row[0] if p_row else "unset",
                    "age": p_row[1] if p_row else "unset"
                })
            except Exception:
                pass
            try:
                await pws.send_json({
                    "type": "matched",
                    "partner_name": "Stranger",
                    "gender": u_row[0] if u_row else "unset",
                    "age": u_row[1] if u_row else "unset"
                })
            except Exception:
                pass
            await self.broadcast_global_stats()
            return

        # Fallback: bot companion after 4s
        await asyncio.sleep(3.5)
        ws = self.user_websockets.get(user_id)
        if ws and user_id in self.matching_queue:
            self.matching_queue.remove(user_id)
            preset = random.choice([
                {"name": "Alex", "gender": "male", "age": "18-24",
                 "bio": "React dev and gamer.", "interests": ["Gaming 🎮", "Tech 💻"]},
                {"name": "Sophia", "gender": "female", "age": "25-34",
                 "bio": "Coffee and Camus.", "interests": ["Philosophy 🧠", "Art 🎨"]},
                {"name": "Mia", "gender": "female", "age": "18-24",
                 "bio": "Indie music lover.", "interests": ["Music 🎵", "Memes 😂"]},
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
        pws = self.websocket_pairs.get(websocket)
        if pws:
            try:
                await pws.send_json({"type": "msg", "text": text})
            except Exception:
                pass

    async def relay_typing(self, websocket: WebSocket, active: bool):
        pws = self.websocket_pairs.get(websocket)
        if pws:
            try:
                await pws.send_json({"type": "typing", "active": active})
            except Exception:
                pass

    async def cancel_match(self, websocket: WebSocket):
        user_id = self.active_connections.get(websocket)
        if user_id in self.matching_queue:
            self.matching_queue.remove(user_id)
        await self.broadcast_global_stats()

    async def join_room(self, websocket: WebSocket, room_id: int):
        if room_id not in self.room_connections:
            self.room_connections[room_id] = []
        if websocket not in self.room_connections[room_id]:
            self.room_connections[room_id].append(websocket)
        await self.broadcast_room_stats(room_id)

    async def broadcast_room_message(self, room_id: int, sender: str, text: str):
        dead = []
        for ws in self.room_connections.get(room_id, []):
            try:
                await ws.send_json({"type": "room_msg", "sender": sender, "text": text, "room_id": room_id})
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.room_connections[room_id].remove(ws)

    async def broadcast_global_stats(self):
        online = len(self.active_connections)
        matching = len(self.matching_queue) + len(self.active_matches)
        dead = []
        for ws in list(self.active_connections.keys()):
            try:
                await ws.send_json({"type": "stats", "online": max(online, 1), "matching": matching})
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.active_connections.pop(ws, None)

    async def broadcast_room_stats(self, room_id: int):
        count = len(self.room_connections.get(room_id, []))
        dead = []
        for ws in list(self.active_connections.keys()):
            try:
                await ws.send_json({"type": "room_stats", "room_id": room_id, "online": max(count + 2, 3)})
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.active_connections.pop(ws, None)


manager = ConnectionManager()

BOT_CHATTERS = [
    ("MemeLord 🦖", "Me when the compiler throws 82 errors: *closes laptop*"),
    ("CoffeeBrain ☕", "Highly recommend trying cold brew with oat milk today."),
    ("RetroVibe 🌙", "Anyone listening to the synthwave playlist? It hits different."),
    ("TechExplorer 💻", "Just finished upgrading my SQLite schema — works flawlessly!"),
    ("GamerX 🎮", "Who is down for Elden Ring? DM me."),
    ("NightOwl 🦉", "3am and I'm still here. The internet never sleeps."),
    ("ArtVibes 🎨", "Just painted something surreal tonight. Life is wild."),
]

async def room_background_chatter_loop():
    while True:
        await asyncio.sleep(random.randint(7, 15))
        active_rooms = [r for r, ws_list in manager.room_connections.items() if ws_list]
        if active_rooms:
            room_id = random.choice(active_rooms)
            name, text = random.choice(BOT_CHATTERS)
            await manager.broadcast_room_message(room_id, name, text)


# ── WebSocket Endpoint ────────────────────────────────────────────────────────
@app.websocket("/ws")
async def websocket_gateway(websocket: WebSocket, token: str = ""):
    user_id = active_sessions.get(token)
    if not user_id:
        await websocket.close(code=1008)
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
                await manager.join_room(websocket, int(data.get("room_id", 0)))
            elif msg_type == "room_msg":
                room_id = int(data.get("room_id", 0))
                db = await get_db()
                cur = await db.execute("SELECT display_name FROM web_users WHERE id=?", (user_id,))
                row = await cur.fetchone()
                sender = row[0] if row else "Anonymous"
                await manager.broadcast_room_message(room_id, sender, data.get("text", ""))
            elif msg_type == "stop":
                pws = manager.websocket_pairs.get(websocket)
                if pws:
                    try:
                        await pws.send_json({"type": "disconnected", "reason": "Stranger stopped chatting"})
                    except Exception:
                        pass
                await manager.disconnect(websocket)
                await manager.connect(websocket, user_id)

    except WebSocketDisconnect:
        await manager.disconnect(websocket)
    except Exception as e:
        print(f"WS Error: {e}")
        await manager.disconnect(websocket)


# ── Serve static frontend files last ─────────────────────────────────────────
if os.path.exists("web"):
    app.mount("/", StaticFiles(directory="web", html=True), name="static")
