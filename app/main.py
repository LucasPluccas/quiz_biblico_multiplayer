 from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
import secrets
import json
import time
import asyncio
import random

app = FastAPI()
app.mount("/static", StaticFiles(directory="static"), name="static")

ROOMS = {}     # room_code -> dict room
SOCKETS = {}   # room_code -> {player_id: websocket}

# UX/Game constants
BONUS_TIE_THRESHOLD_S = 0.150  # 150ms
TOTAL_ROUNDS_DEFAULT = 10

# Avatar limits
MAX_AVATAR_CHARS = 120_000

# Tempo por nível (segundos)
LEVEL_TIME_LIMITS = {
    "facil": 20,
    "medio": 12,
    "apocalipse": 7,
    "mediano": 12,
    "dificil": 10,
}
DEFAULT_TIME_LIMIT = 20


# -------------------------
# Utilitários
# -------------------------

def make_room_code() -> str:
    return secrets.token_hex(2).upper()

def load_questions():
    with open("app/questions.json", "r", encoding="utf-8") as f:
        return json.load(f)

QUESTIONS = load_questions()

def time_limit_for_level(level: str) -> int:
    if not level:
        return DEFAULT_TIME_LIMIT
    return int(LEVEL_TIME_LIMITS.get(level, DEFAULT_TIME_LIMIT))

async def send_to_all(room_code: str, payload: dict):
    dead = []
    for pid, ws in SOCKETS.get(room_code, {}).items():
        try:
            await ws.send_json(payload)
        except Exception:
            dead.append(pid)
    for pid in dead:
        SOCKETS[room_code].pop(pid, None)

async def send_to_one(room_code: str, player_id: str, payload: dict):
    ws = SOCKETS.get(room_code, {}).get(player_id)
    if ws:
        await ws.send_json(payload)

def build_players_public(players: dict):
    return [
        {"id": pid, "name": p["name"], "score": p["score"], "avatar": p.get("avatar")}
        for pid, p in players.items()
    ]

def build_ranking(players: dict):
    lst = [
        {"id": pid, "name": p["name"], "score": p["score"], "avatar": p.get("avatar")}
        for pid, p in players.items()
    ]
    lst.sort(key=lambda x: (-x["score"], x["name"].lower()))
    return lst

async def broadcast_room_state(room_code: str):
    room = ROOMS[room_code]
    payload = {
        "type": "room_state",
        "host_id": room["host_id"],
        "started": room["started"],
        "players": build_players_public(room["players"]),
        "round": room.get("round", 0),
        "total_rounds": room.get("total_rounds", TOTAL_ROUNDS_DEFAULT),
    }
    await send_to_all(room_code, payload)

def pick_next_question(room: dict) -> dict:
    idx = room["q_index"] % len(QUESTIONS)
    room["q_index"] += 1
    return QUESTIONS[idx]

def in_time(room: dict, now: float) -> bool:
    started_at = room.get("question_started_at")
    limit_s = room.get("time_limit_s", DEFAULT_TIME_LIMIT)
    if started_at is None:
        return False
    return (now - started_at) <= limit_s

def everyone_done(room: dict) -> bool:
    return (len(room["answers"]) + len(room["skipped"])) >= len(room["players"])

def manual_answers_sorted(room: dict):
    items = [(pid, ans) for pid, ans in room["answers"].items() if not ans.get("auto", False)]
    items.sort(key=lambda x: x[1]["ts"])
    return items


def reset_game_state(room: dict):
    # Reseta apenas o "estado do jogo", mantendo jogadores (e avatares)
    room["started"] = False
    room["round"] = 0
    room["q_index"] = 0
    room["current_question"] = None
    room["question_started_at"] = None
    room["time_limit_s"] = DEFAULT_TIME_LIMIT
    room["answers"] = {}
    room["skipped"] = set()

    # Reseta pontuação e ferramentas
    for p in room["players"].values():
        p["score"] = 0
        p["tools"] = {
            "livramento": 1,
            "me_ajuda_senhor": 1,
            "revelacao_divina": 1,
            "dica_santa": 1
        }


async def start_round(room_code: str):
    room = ROOMS[room_code]

    if room["round"] >= room["total_rounds"]:
        await end_game(room_code)
        return

    q = pick_next_question(room)
    level = q.get("nivel", "facil")
    limit_s = time_limit_for_level(level)

    room["current_question"] = q
    room["question_started_at"] = time.time()
    room["time_limit_s"] = limit_s
    room["answers"] = {}
    room["skipped"] = set()

    room["round"] += 1

    await send_to_all(room_code, {
        "type": "question",
        "id": q.get("id"),
        "nivel": level,
        "pergunta": q["pergunta"],
        "opcoes": q["opcoes"],
        "tempo": limit_s,
        "round": room["round"],
        "total_rounds": room["total_rounds"],
    })

    started_at = room["question_started_at"]
    asyncio.create_task(auto_close_round(room_code, started_at, limit_s))

async def auto_close_round(room_code: str, started_at: float, limit_s