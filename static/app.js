const el = (id) => document.getElementById(id);

let ws = null;
let roomCode = "";
let playerId = crypto.randomUUID();

let answered = false;
let questionActive = false;
let timerInterval = null;
let selectedChoiceIdx = null;

let tools = {
  livramento: 0,
  me_ajuda_senhor: 0,
  revelacao_divina: 0,
  dica_santa: 0
};

const LETTERS = ["A", "B", "C", "D"];
let soundEnabled = true;
let timerTotal = 20;

// ----------------------
// Fluxo de telas: Início -> Lobby -> Jogo
// ----------------------
function showLanding() {
  el("screenLanding")?.classList.remove("hidden");
  el("appShell")?.classList.add("hidden");
  showScreen("lobby");
}

function showLobby() {
  el("screenLanding")?.classList.add("hidden");
  el("appShell")?.classList.remove("hidden");
  showScreen("lobby");
}

function showScreen(screen) {
  el("lobby")?.classList.toggle("hidden", screen !== "lobby");
  el("game")?.classList.toggle("hidden", screen !== "game");
  el("end")?.classList.toggle("hidden", screen !== "end");
}

function disconnectWS() {
  try {
    if (ws && ws.readyState === 1) ws.close();
  } catch {}
  ws = null;

  clearInterval(timerInterval);
  timerInterval = null;

  answered = false;
  questionActive = false;
  selectedChoiceIdx = null;

  setStatus("Aguardando...");
  setTimeFill(0);
  setTimerText("—");
}

// ----------------------
// UI helpers
// ----------------------
function setStatus(msg) {
  const s = el("status");
  if (s) s.textContent = msg;
}

function setTimerText(value) {
  const t = el("timer");
  if (t) t.textContent = String(value);
}

function setTimeFill(remaining) {
  const fill = el("timeFill");
  if (!fill) return;
  const pct = Math.max(0, Math.min(100, (remaining / timerTotal) * 100));
  fill.style.width = `${pct}%`;
}

function startTimer(seconds) {
  timerTotal = Number(seconds ?? 20);
  if (!Number.isFinite(timerTotal) || timerTotal <= 0) timerTotal = 20;

  let remaining = timerTotal;
  setTimerText(remaining);
  setTimeFill(remaining);

  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    remaining -= 1;
    if (remaining < 0) remaining = 0;
    setTimerText(remaining);
    setTimeFill(remaining);
    if (remaining <= 0) clearInterval(timerInterval);
  }, 1000);
}

function renderChoices(options) {
  const container = el("choices");
  if (!container) return;
  container.innerHTML = "";

  (options || []).forEach((text, idx) => {
    const btn = document.createElement("button");
    btn.className = "choice-card";
    btn.dataset.choice = String(idx);
    btn.disabled = !(questionActive && !answered);

    btn.innerHTML = `
      <div class="choice-letter">${LETTERS[idx] ?? "?"}</div>
      <div class="choice-text">${text}</div>
    `;

    btn.onclick = () => answer(idx);
    container.appendChild(btn);
  });
}

function refreshToolButtons() {
  document.querySelectorAll(".tool").forEach((btn) => {
    const key = btn.dataset.tool;
    const remaining = tools[key] ?? 0;
    btn.disabled = !(questionActive && !answered && remaining > 0);

    const base = btn.textContent.replace(/\s\(\d+\)$/, "");
    btn.textContent = `${base} (${remaining})`;
  });
}

// ----------------------
// Avatar upload
// ----------------------
async function fileToAvatarDataURL(file, maxSize = 160, quality = 0.72) {
  const dataURL = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });

  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = reject;
    i.src = dataURL;
  });

  const scale = Math.min(maxSize / img.width, maxSize / img.height, 1);
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;

  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, w, h);

  return canvas.toDataURL("image/jpeg", quality);
}

function sendAvatar(dataURL) {
  if (!ws || ws.readyState !== 1) {
    setStatus("Conecte na sala antes de enviar a foto.");
    return;
  }
  ws.send(JSON.stringify({ type: "set_avatar", image: dataURL }));
}

// ----------------------
// Game actions
// ----------------------
function answer(choiceIdx) {
  if (!ws || ws.readyState !== 1) return;
  if (!questionActive || answered) return;

  selectedChoiceIdx = choiceIdx;
  answered = true;
  refreshToolButtons();

  ws.send(JSON.stringify({ type: "answer", choice: choiceIdx }));
}

function useTool(toolName) {
  if (!ws || ws.readyState !== 1) return;
  if (!questionActive || answered) return;
  if ((tools[toolName] ?? 0) <= 0) return;

  ws.send(JSON.stringify({ type: "tool", tool: toolName }));
}

// ----------------------
// WebSocket
// ----------------------
function connectAndJoin(code, name) {
  roomCode = code;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const url = `${proto}://${location.host}/ws/${roomCode}/${playerId}`;
  ws = new WebSocket(url);

  ws.onopen = () => {
    setStatus("Conectado. Entrando na sala...");
    ws.send(JSON.stringify({ type: "join", name }));
  };

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);

    if (msg.type === "error") {
      setStatus(msg.message);
      return;
    }

    if (msg.type === "room_state") {
      const isHost = msg.host_id === playerId;
      el("startBtn").disabled = !(isHost && !msg.started);

      setStatus(
        msg.started
          ? "Jogo iniciado."
          : isHost
          ? "Você é o host. Pode iniciar."
          : "Aguardando o host iniciar."
      );

      // Lista de jogadores simples
      const ul = el("playersList");
      if (ul) {
        ul.innerHTML = "";
        (msg.players || []).forEach((p) => {
          const li = document.createElement("li");
          li.className = "playerRow";
          li.textContent = `${p.name}${p.id === msg.host_id ? " (host)" : ""} — ${p.score} pts`;
          ul.appendChild(li);
        });
      }

      // Prévia do meu avatar (se existir)
      const me = (msg.players || []).find(p => p.id === playerId);
      if (me && me.avatar) {
        const prev = el("myAvatarPreview");
        prev.src = me.avatar;
        prev.classList.remove("hidden");
      }

      // NÃO vai pro jogo aqui. Somente em "game_started".
      return;
    }

    if (msg.type === "tools_state") {
      tools = msg.tools || tools;
      refreshToolButtons();
      return;
    }

    if (msg.type === "game_started") {
      showScreen("game");
      return;
    }

    if (msg.type === "question") {
      answered = false;
      questionActive = true;

      el("roundNum").textContent = String(msg.round ?? 0);
      el("roundTotal").textContent = String(msg.total_rounds ?? 10);
      el("levelBadge").textContent = `Nível: ${msg.nivel || "—"}`;

      el("questionText").textContent = msg.pergunta || "";
      renderChoices(msg.opcoes || []);
      startTimer(msg.tempo);

      refreshToolButtons();
      return;
    }

    if (msg.type === "round_result") {
      questionActive = false;
      refreshToolButtons();
      return;
    }

    if (msg.type === "game_over") {
      showScreen("end");
      el("endRounds").textContent = String(msg.total_rounds ?? 10);

      const ol = el("finalRanking");
      ol.innerHTML = "";
      (msg.ranking || []).forEach((p, i) => {
        const li = document.createElement("li");
        li.textContent = `#${i + 1} ${p.name} — ${p.score} pts`;
        ol.appendChild(li);
      });
      return;
    }
  };

  ws.onclose = () => setStatus("Desconectado.");
  ws.onerror = () => setStatus("Erro na conexão WebSocket.");
}

// ----------------------
// Wiring
// ----------------------
el("goToLobbyBtn").onclick = () => showLobby();

el("howBtn").onclick = () => {
  el("howPanel").classList.toggle("hidden");
};

el("backToHomeBtn").onclick = () => {
  disconnectWS();
  showLanding();
};

el("soundToggle").onclick = () => {
  soundEnabled = !soundEnabled;
  el("soundToggle").textContent = `Som: ${soundEnabled ? "ON" : "OFF"}`;
};

el("createRoomBtn").onclick = async () => {
  setStatus("Criando sala...");
  const res = await fetch("/create-room", { method: "POST" });
  const data = await res.json();
  el("roomCode").textContent = data.room_code;
  setStatus("Sala criada. Digite PIN + nome e clique Entrar.");
};

el("joinBtn").onclick = () => {
  const code = (el("roomInput").value || "").trim().toUpperCase();
  const name = (el("nameInput").value || "").trim();

  if (!code || !name) {
    setStatus("Informe PIN e nome.");
    return;
  }

  el("roomCode").textContent = code;
  connectAndJoin(code, name);
};

el("startBtn").onclick = () => {
  if (!ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify({ type: "start" }));
};

document.querySelectorAll(".tool").forEach((btn) => {
  btn.onclick = () => useTool(btn.dataset.tool);
});

el("avatarInput").addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;

  try {
    setStatus("Processando foto...");
    const avatar = await fileToAvatarDataURL(file, 160, 0.72);

    const prev = el("myAvatarPreview");
    prev.src = avatar;
    prev.classList.remove("hidden");

    sendAvatar(avatar);
    setStatus("Foto enviada. Atualizando sala...");
  } catch (err) {
    console.error(err);
    setStatus("Não foi possível processar a foto. Tente outra imagem.");
  } finally {
    el("avatarInput").value = "";
  }
});

// init
showLanding();
showScreen("lobby");
refreshToolButtons();
setTimeFill(0);