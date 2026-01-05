const el = (id) => document.getElementById(id);

let ws = null;
let roomCode = "";
let playerId = crypto.randomUUID();

let answered = false;
let questionActive = false;
let timerInterval = null;

let tools = {
  livramento: 0,
  me_ajuda_senhor: 0,
  revelacao_divina: 0,
  dica_santa: 0
};

function setStatus(msg) { el("status").textContent = msg; }

function renderPlayers(players, hostId) {
  const ul = el("playersList");
  ul.innerHTML = "";
  players.forEach(p => {
    const li = document.createElement("li");
    const hostMark = (p.id === hostId) ? " (host)" : "";
    li.textContent = `${p.name}${hostMark} (${p.score})`;
    ul.appendChild(li);
  });
}

function updateScoreboard(scoreboard) {
  const ul = el("scoreboard");
  ul.innerHTML = "";
  scoreboard
    .slice()
    .sort((a, b) => b.score - a.score)
    .forEach(p => {
      const li = document.createElement("li");
      li.textContent = `${p.name}: ${p.score}`;
      ul.appendChild(li);
    });
}

function startTimer(seconds) {
  let remaining = seconds;
  el("timer").textContent = remaining;

  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    remaining -= 1;
    el("timer").textContent = Math.max(0, remaining);
    if (remaining <= 0) clearInterval(timerInterval);
  }, 1000);
}

function renderChoices(options) {
  const container = el("choices");
  container.innerHTML = "";

  options.forEach((text, idx) => {
    const btn = document.createElement("button");
    btn.className = "choice";
    btn.textContent = `${idx + 1}) ${text}`;
    btn.onclick = () => answer(idx);
    btn.dataset.choice = String(idx);
    btn.disabled = !(questionActive && !answered);
    container.appendChild(btn);
  });
}

function disableAllChoices() {
  document.querySelectorAll(".choice").forEach(b => b.disabled = true);
}

function highlightCorrect(correctIdx) {
  const btn = [...document.querySelectorAll(".choice")].find(b => b.dataset.choice === String(correctIdx));
  if (btn) btn.textContent += " ✅";
}

function hideChoice(idx) {
  const btn = [...document.querySelectorAll(".choice")].find(b => b.dataset.choice === String(idx));
  if (btn) btn.style.display = "none";
}

function refreshToolButtons() {
  document.querySelectorAll(".tool").forEach(btn => {
    const key = btn.dataset.tool;
    const remaining = tools[key] ?? 0;
    btn.disabled = !(questionActive && !answered && remaining > 0);

    const base = btn.textContent.replace(/\s\(\d\)$/, "");
    btn.textContent = `${base} (${remaining})`;
  });
}

function answer(choiceIdx) {
  if (!ws || ws.readyState !== 1) return;
  if (!questionActive || answered) return;

  answered = true;
  refreshToolButtons();
  disableAllChoices();

  ws.send(JSON.stringify({ type: "answer", choice: choiceIdx }));
}

function useTool(toolName) {
  if (!ws || ws.readyState !== 1) return;
  if (!questionActive || answered) return;
  if ((tools[toolName] ?? 0) <= 0) return;

  ws.send(JSON.stringify({ type: "tool", tool: toolName }));
}

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
      renderPlayers(msg.players, msg.host_id);
      const isHost = (msg.host_id === playerId);
      el("startBtn").disabled = !(isHost && !msg.started);
      setStatus(msg.started ? "Jogo iniciado." : (isHost ? "Você é o host. Pode iniciar." : "Aguardando o host iniciar."));
    }

    if (msg.type === "tools_state") {
      tools = msg.tools;
      refreshToolButtons();
    }

    if (msg.type === "game_started") {
      setStatus("O jogo começou!");
    }

    if (msg.type === "question") {
      el("lobby").classList.add("hidden");
      el("game").classList.remove("hidden");

      answered = false;
      questionActive = true;

      el("toolOutput").textContent = "";
      el("roundInfo").textContent = "";

      el("levelBadge").textContent = msg.nivel;
      el("questionText").textContent = msg.pergunta;

      renderChoices(msg.opcoes);
      startTimer(msg.tempo);

      refreshToolButtons();
    }

    if (msg.type === "tool_result") {
      if (msg.tool === "revelacao_divina") {
        const idx = msg.auto_answer;

        el("toolOutput").textContent =
          `✨ Revelação Divina: resposta enviada automaticamente (opção ${idx + 1}).`;

        answered = true;
        questionActive = false;

        highlightCorrect(idx);
        disableAllChoices();
        refreshToolButtons();

      } else if (msg.tool === "me_ajuda_senhor") {
        el("toolOutput").textContent =
          `🙏 Me Ajuda Senhor (50/50): eliminadas opções ${msg.eliminadas.map(x => x + 1).join(", ")}.`;

        msg.eliminadas.forEach(i => hideChoice(i));

      } else if (msg.tool === "dica_santa") {
        el("toolOutput").textContent = `📖 Dica Santa (Capítulo): ${msg.capitulo}`;

      } else if (msg.tool === "livramento") {
        el("toolOutput").textContent = "✝️ Livramento: você pulou esta pergunta.";
        answered = true;
        questionActive = false;
        refreshToolButtons();
        disableAllChoices();
      }
    }

    if (msg.type === "round_result") {
      questionActive = false;

      const correct = msg.correta;
      highlightCorrect(correct);
      disableAllChoices();

      const ref = msg.referencia || "—";

      // mensagem do bônus
      let bonusLine = "Bônus: ninguém ganhou o bônus.";
      if (msg.first_correct && msg.first_correct.name) {
        bonusLine = `Bônus: ${msg.first_correct.name} ganhou +1 por responder primeiro e acertar.`;
      } else if (msg.first_answer_player) {
        bonusLine = "Bônus: o primeiro a responder errou, então ninguém ganhou +1.";
      }

      el("roundInfo").textContent =
        `Correta: opção ${correct + 1}. Referência: ${ref}. ${bonusLine}`;

      updateScoreboard(msg.scoreboard);
      refreshToolButtons();
    }
  };

  ws.onclose = () => setStatus("Desconectado.");
  ws.onerror = () => setStatus("Erro na conexão WebSocket.");
}

el("createRoomBtn").onclick = async () => {
  setStatus("Criando sala...");
  const res = await fetch("/create-room", { method: "POST" });
  const data = await res.json();
  el("roomCode").textContent = data.room_code;
  setStatus("Sala criada. Digite PIN + nome e clique Entrar.");
};

el("joinBtn").onclick = () => {
  const code = el("roomInput").value.trim().toUpperCase();
  const name = el("nameInput").value.trim();
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

document.querySelectorAll(".tool").forEach(btn => {
  btn.onclick = () => useTool(btn.dataset.tool);
});

refreshToolButtons();

