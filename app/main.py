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

BONUS_TIE_THRESHOLD_S = 0.150  # 150ms


# -------------------------
# Utilitários
# -------------------------

def make_room_code() -> str:
    return secrets.token_hex(2).upper()

def load_questions():
    with open("app/questions.json", "r", encoding="utf-8") as f:
        return json.load(f)

QUESTIONS = load_questions()


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


async def broadcast_room_state(room_code: str):
    room = ROOMS[room_code]
    players = room["players"]

    payload = {
        "type": "room_state",
        "host_id": room["host_id"],
        "started": room["started"],
        "players": [
            {"id": pid, "name": p["name"], "score": p["score"]}
            for pid, p in players.items()
        ]
    }
    await send_to_all(room_code, payload)


def pick_next_question(room: dict) -> dict:
    idx = room["q_index"] % len(QUESTIONS)
    room["q_index"] += 1
    return QUESTIONS[idx]


def in_time(room: dict, now: float, limit_s: int = 20) -> bool:
    started_at = room.get("question_started_at")
    if started_at is None:
        return False
    return (now - started_at) <= limit_s


def everyone_done(room: dict) -> bool:
    # Feito = respondeu OU pulou
    return (len(room["answers"]) + len(room["skipped"])) >= len(room["players"])


def manual_answers_sorted(room: dict):
    """
    Retorna lista de tuples (pid, answer_dict) somente de respostas manuais (auto=False),
    ordenadas por timestamp.
    answer_dict contém: choice, ts, auto
    """
    items = [(pid, ans) for pid, ans in room["answers"].items() if not ans.get("auto", False)]
    items.sort(key=lambda x: x[1]["ts"])
    return items


async def start_round(room_code: str):
    room = ROOMS[room_code]

    q = pick_next_question(room)
    room["current_question"] = q
    room["question_started_at"] = time.time()

    # answers: player_id -> {"choice": int, "ts": float, "auto": bool}
    room["answers"] = {}
    room["skipped"] = set()

    await send_to_all(room_code, {
        "type": "question",
        "id": q["id"],
        "nivel": q.get("nivel", "—"),
        "pergunta": q["pergunta"],
        "opcoes": q["opcoes"],
        "tempo": 20
    })

    started_at = room["question_started_at"]
    asyncio.create_task(auto_close_round(room_code, started_at))


async def auto_close_round(room_code: str, started_at: float):
    await asyncio.sleep(20.2)
    room = ROOMS.get(room_code)
    if not room:
        return
    if room.get("question_started_at") == started_at and room.get("current_question"):
        await finish_round(room_code)


async def finish_round(room_code: str):
    room = ROOMS[room_code]
    q = room.get("current_question")
    if not q:
        return

    correct = int(q["correta"])
    players = room["players"]

    # +1 por acerto (vale para manual e auto)
    for pid, ans in room["answers"].items():
        if ans["choice"] == correct:
            players[pid]["score"] += 1

    # -------------------------
    # BÔNUS REFINADO (todas as regras)
    # -------------------------
    manual = manual_answers_sorted(room)  # somente respostas manuais, ordenadas por ts

    bonus = {
        "awarded": False,
        "winner": None,
        "reason": ""
    }

    # Regra 2: precisa de disputa real -> pelo menos 2 respostas manuais
    if len(manual) < 2:
        bonus["reason"] = "Sem bônus: é necessário ao menos 2 respostas manuais na rodada."
    else:
        (first_pid, first_ans) = manual[0]
        (second_pid, second_ans) = manual[1]

        # Regra 4: empate técnico se diferença < 150ms
        if (second_ans["ts"] - first_ans["ts"]) < BONUS_TIE_THRESHOLD_S:
            bonus["reason"] = f"Sem bônus: empate técnico (diferença < {int(BONUS_TIE_THRESHOLD_S*1000)}ms)."
        else:
            # Regra 1: resposta automática não entra aqui porque manual já filtra auto=False
            # Regra 3: livramento não é resposta, então também não entra aqui
            if first_ans["choice"] == correct:
                players[first_pid]["score"] += 1
                bonus["awarded"] = True
                bonus["winner"] = {"id": first_pid, "name": players[first_pid]["name"]}
                bonus["reason"] = "Bônus concedido: primeiro a responder manualmente acertou."
            else:
                bonus["reason"] = "Sem bônus: o primeiro a responder manualmente errou."

    await send_to_all(room_code, {
        "type": "round_result",
        "correta": correct,
        "referencia": q.get("referencia"),
        "bonus": bonus,
        "scoreboard": [
            {"id": pid, "name": p["name"], "score": p["score"]}
            for pid, p in players.items()
        ]
    })

    await send_to_all(room_code, {"type": "next_in", "seconds": 3})
    await asyncio.sleep(3)
    await start_round(room_code)


# -------------------------
# Rotas HTTP
# -------------------------

@app.get("/")
def home():
    with open("static/index.html", "r", encoding="utf-8") as f:
        return HTMLResponse(f.read())


@app.post("/create-room")
def create_room():
    code = make_room_code()
    ROOMS[code] = {
        "players": {},      # player_id -> {name, score, tools}
        "host_id": None,
        "started": False,

        # jogo
        "q_index": 0,
        "current_question": None,
        "question_started_at": None,
        "answers": {},
        "skipped": set(),
    }
    SOCKETS[code] = {}
    return {"room_code": code}


# -------------------------
# WebSocket
# -------------------------

@app.websocket("/ws/{room_code}/{player_id}")
async def ws_room(ws: WebSocket, room_code: str, player_id: str):
    await ws.accept()

    if room_code not in ROOMS:
        await ws.send_json({"type": "error", "message": "Sala não existe."})
        await ws.close()
        return

    SOCKETS[room_code][player_id] = ws

    try:
        while True:
            msg = await ws.receive_json()
            mtype = msg.get("type")

            # -------------------------
            # Entrar na sala
            # -------------------------
            if mtype == "join":
                name = (msg.get("name") or "").strip()
                if not name:
                    await ws.send_json({"type": "error", "message": "Nome inválido."})
                    continue

                room = ROOMS[room_code]
                players = room["players"]

                if player_id not in players and len(players) >= 4:
                    await ws.send_json({"type": "error", "message": "Sala cheia (máx. 4)."})
                    continue

                if player_id not in players:
                    players[player_id] = {
                        "name": name,
                        "score": 0,
                        "tools": {
                            "livramento": 1,
                            "me_ajuda_senhor": 1,
                            "revelacao_divina": 1,
                            "dica_santa": 1
                        }
                    }

                if room["host_id"] is None:
                    room["host_id"] = player_id

                await broadcast_room_state(room_code)

                await send_to_one(room_code, player_id, {
                    "type": "tools_state",
                    "tools": players[player_id]["tools"]
                })

            # -------------------------
            # Iniciar jogo (host)
            # -------------------------
            elif mtype == "start":
                room = ROOMS[room_code]
                if player_id != room["host_id"]:
                    await ws.send_json({"type": "error", "message": "Apenas o host pode iniciar."})
                    continue

                if room["started"]:
                    continue

                room["started"] = True
                await send_to_all(room_code, {"type": "game_started"})
                await broadcast_room_state(room_code)
                await start_round(room_code)

            # -------------------------
            # Responder (MANUAL)
            # -------------------------
            elif mtype == "answer":
                room = ROOMS[room_code]
                q = room.get("current_question")
                if not q:
                    continue

                now = time.time()
                if not in_time(room, now, 20):
                    continue

                if player_id in room["answers"] or player_id in room["skipped"]:
                    continue

                choice = msg.get("choice")
                if choice not in [0, 1, 2, 3]:
                    continue

                room["answers"][player_id] = {"choice": int(choice), "ts": now, "auto": False}

                if everyone_done(room):
                    await finish_round(room_code)

            # -------------------------
            # Ferramentas
            # -------------------------
            elif mtype == "tool":
                tool = msg.get("tool")

                room = ROOMS[room_code]
                q = room.get("current_question")
                if not q:
                    await send_to_one(room_code, player_id, {"type": "error", "message": "Não há pergunta ativa."})
                    continue

                now = time.time()
                if not in_time(room, now, 20):
                    await send_to_one(room_code, player_id, {"type": "error", "message": "Tempo encerrado."})
                    continue

                # não pode usar se já respondeu/pulou
                if player_id in room["answers"] or player_id in room["skipped"]:
                    await send_to_one(room_code, player_id, {"type": "error", "message": "Você já finalizou nesta rodada."})
                    continue

                player = room["players"].get(player_id)
                if not player:
                    continue

                tools = player["tools"]
                if tool not in tools or tools[tool] <= 0:
                    await send_to_one(room_code, player_id, {"type": "error", "message": "Ferramenta indisponível."})
                    continue

                # consome ferramenta
                tools[tool] -= 1

                correct = int(q["correta"])

                if tool == "revelacao_divina":
                    # Responde automaticamente (auto=True) e NÃO entra no bônus
                    room["answers"][player_id] = {"choice": correct, "ts": now, "auto": True}

                    await send_to_one(room_code, player_id, {
                        "type": "tool_result",
                        "tool": tool,
                        "auto_answer": correct
                    })

                    if everyone_done(room):
                        await finish_round(room_code)

                elif tool == "me_ajuda_senhor":
                    wrongs = [i for i in range(4) if i != correct]
                    keep_wrong = random.choice(wrongs)
                    eliminated = [i for i in wrongs if i != keep_wrong]
                    await send_to_one(room_code, player_id, {
                        "type": "tool_result",
                        "tool": tool,
                        "eliminadas": eliminated
                    })

                elif tool == "dica_santa":
                    cap = q.get("capitulo") or q.get("referencia") or "—"
                    await send_to_one(room_code, player_id, {
                        "type": "tool_result",
                        "tool": tool,
                        "capitulo": cap
                    })

                elif tool == "livramento":
                    # Regra 3: não é resposta e não concorre ao bônus
                    room["skipped"].add(player_id)
                    await send_to_one(room_code, player_id, {
                        "type": "tool_result",
                        "tool": tool,
                        "status": "pulou"
                    })

                    if everyone_done(room):
                        await finish_round(room_code)

                # tools_state atualizado
                await send_to_one(room_code, player_id, {
                    "type": "tools_state",
                    "tools": tools
                })

    except WebSocketDisconnect:
        SOCKETS[room_code].pop(player_id, None)
