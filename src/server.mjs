import "dotenv/config";
import cors from "cors";
import express from "express";
import http from "node:http";
import process from "node:process";
import { createClient } from "@supabase/supabase-js";
import { customAlphabet } from "nanoid";
import { Server } from "socket.io";

const PORT = Number(process.env.PORT ?? 8080);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? "*";
const GAME_ENABLED = process.env.GAME_ENABLED ?? "true";
const MAX_ACTIVE_ROOMS = Number(process.env.MAX_ACTIVE_ROOMS ?? 50);

function normalizeOrigin(origin) {
  const value = String(origin ?? "").trim();
  if (!value || value === "*") return "*";
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

const CORS_ORIGIN = normalizeOrigin(ALLOWED_ORIGIN);

const MAX_PLAYERS = 4;
const GAME_DURATION_MS = 180_000;
const ROUND_DURATION_MS = 30_000;
const BASE_SCORE = 100;
const ROOM_CODE_LENGTH = 6;
const createRoomCode = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", ROOM_CODE_LENGTH);

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseSecretKey =
  process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = supabaseUrl && supabaseSecretKey ? createClient(supabaseUrl, supabaseSecretKey) : null;

const app = express();
app.use(cors({ origin: CORS_ORIGIN === "*" ? true : CORS_ORIGIN }));
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: CORS_ORIGIN === "*" ? true : CORS_ORIGIN,
    methods: ["GET", "POST"]
  }
});

const rooms = new Map();
let wordsCache = { expiresAt: 0, rows: [] };

function isGameEnabled() {
  return (process.env.GAME_ENABLED ?? GAME_ENABLED).toLowerCase() === "true";
}

function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeGuess(value) {
  return normalizeText(value).toLowerCase();
}

function toDisplayMask(word) {
  const chars = [...word];
  if (chars.length <= 1) {
    return chars.join("");
  }
  return chars
    .map((char, idx) => {
      if (idx === 0 || idx === chars.length - 1) return char.toUpperCase();
      return "_";
    })
    .join(" ");
}

function nowMs() {
  return Date.now();
}

function serializePlayers(room) {
  return [...room.players.values()].map((player) => ({
    id: player.id,
    nickname: player.nickname,
    score: player.score,
    connected: player.connected,
    isHost: room.hostPlayerId === player.id
  }));
}

function emitRoomState(room) {
  io.to(room.id).emit("room:state", {
    roomCode: room.id,
    status: room.status,
    players: serializePlayers(room)
  });
}

function emitServerError(socket, message) {
  socket.emit("server:error", { message });
}

function formatUnknownError(error) {
  if (error instanceof Error) {
    const maybeCause = error.cause;
    if (maybeCause instanceof Error) {
      return `${error.message} (cause: ${maybeCause.message})`;
    }
    if (maybeCause && typeof maybeCause === "object" && "message" in maybeCause) {
      return `${error.message} (cause: ${String(maybeCause.message)})`;
    }
    return error.message;
  }
  return String(error);
}

function clearTimers(room) {
  if (room.globalTimer) {
    clearInterval(room.globalTimer);
    room.globalTimer = null;
  }
  if (room.roundTimer) {
    clearTimeout(room.roundTimer);
    room.roundTimer = null;
  }
}

function countActiveRooms() {
  let total = 0;
  for (const room of rooms.values()) {
    if (room.status === "lobby" || room.status === "in_game" || room.status === "finished") {
      total += 1;
    }
  }
  return total;
}

function pickNextWord(room) {
  while (room.wordQueue.length > 0) {
    const next = room.wordQueue.shift();
    if (!room.usedWords.has(next.word)) {
      room.usedWords.add(next.word);
      return next;
    }
  }
  return null;
}

function shuffleRows(rows) {
  const copy = [...rows];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = copy[i];
    copy[i] = copy[j];
    copy[j] = temp;
  }
  return copy;
}

async function fetchWords() {
  if (!supabase) {
    throw new Error("Supabase env is missing.");
  }

  const current = nowMs();
  if (wordsCache.rows.length > 0 && wordsCache.expiresAt > current) {
    return wordsCache.rows;
  }

  let data;
  let error;
  try {
    const response = await supabase
      .schema("worddash")
      .from("words")
      .select("word,hint,length")
      .order("word", { ascending: true });
    data = response.data;
    error = response.error;
  } catch (unknownError) {
    throw new Error(`Failed to fetch words: ${formatUnknownError(unknownError)}`);
  }

  if (error) {
    throw new Error(`Failed to fetch words: ${error.message}`);
  }

  if (!data || data.length === 0) {
    throw new Error("Word list is empty in database.");
  }

  wordsCache = {
    rows: data.map((row) => ({
      word: normalizeGuess(row.word),
      hint: normalizeText(row.hint),
      length: Number(row.length)
    })),
    expiresAt: current + 60_000
  };

  return wordsCache.rows;
}

function getConnectedPlayers(room) {
  return [...room.players.values()].filter((player) => player.connected);
}

function maybeDeleteRoom(room) {
  const connectedPlayers = getConnectedPlayers(room);
  if (connectedPlayers.length === 0) {
    clearTimers(room);
    rooms.delete(room.id);
  }
}

function endGame(room, reason = "time_up") {
  room.status = "finished";
  room.gameEndsAt = null;
  room.currentRound = null;
  clearTimers(room);

  io.to(room.id).emit("game:ended", {
    reason,
    rankings: serializePlayers(room).sort((a, b) => b.score - a.score),
    winners: serializePlayers(room)
      .sort((a, b) => b.score - a.score)
      .filter((player, _, arr) => arr[0] && player.score === arr[0].score)
      .map((player) => player.id)
  });

  emitRoomState(room);
  maybeDeleteRoom(room);
}

function getRoundTimeRemainingMs(room) {
  if (!room.currentRound) return 0;
  return Math.max(0, room.currentRound.endsAt - nowMs());
}

function computePoints(remainingMs) {
  return Math.max(0, Math.round(BASE_SCORE * (remainingMs / ROUND_DURATION_MS)));
}

function startGlobalTicker(room) {
  room.globalTimer = setInterval(() => {
    if (!room.gameEndsAt) return;
    const remainingMs = Math.max(0, room.gameEndsAt - nowMs());
    io.to(room.id).emit("game:tick", {
      remainingMs,
      remainingSeconds: Math.ceil(remainingMs / 1000)
    });
    if (remainingMs <= 0) {
      endGame(room, "time_up");
    }
  }, 1000);
}

function finalizeRoundNoGuess(room) {
  if (!room.currentRound || room.status !== "in_game") return;
  const result = {
    reason: "time_up",
    word: room.currentRound.word,
    winnerPlayerId: null,
    pointsAwarded: 0
  };
  room.currentRound = null;
  io.to(room.id).emit("game:roundEnded", result);
  startNextRound(room);
}

function startNextRound(room) {
  if (room.status !== "in_game") return;

  const gameRemainingMs = Math.max(0, room.gameEndsAt - nowMs());
  if (gameRemainingMs <= 0) {
    endGame(room, "time_up");
    return;
  }

  const nextWord = pickNextWord(room);
  if (!nextWord) {
    endGame(room, "word_pool_exhausted");
    return;
  }

  const roundDuration = Math.min(ROUND_DURATION_MS, gameRemainingMs);
  const startedAt = nowMs();
  const endsAt = startedAt + roundDuration;

  room.currentRound = {
    word: nextWord.word,
    hint: nextWord.hint,
    display: toDisplayMask(nextWord.word),
    startedAt,
    endsAt,
    winnerPlayerId: null
  };

  io.to(room.id).emit("game:round", {
    display: room.currentRound.display,
    hint: room.currentRound.hint,
    roundDurationMs: roundDuration,
    roundEndsAt: endsAt
  });

  room.roundTimer = setTimeout(() => {
    finalizeRoundNoGuess(room);
  }, roundDuration);
}

async function beginGame(room) {
  if (!isGameEnabled()) {
    throw new Error("Game is currently paused by server.");
  }
  const words = await fetchWords();

  room.status = "in_game";
  room.usedWords.clear();
  room.wordQueue = shuffleRows(words);
  room.gameEndsAt = nowMs() + GAME_DURATION_MS;
  room.currentRound = null;

  for (const player of room.players.values()) {
    player.score = 0;
  }

  emitRoomState(room);
  io.to(room.id).emit("game:started", {
    gameDurationMs: GAME_DURATION_MS
  });
  startGlobalTicker(room);
  startNextRound(room);
}

function resetForPlayAgain(room) {
  clearTimers(room);
  room.status = "lobby";
  room.gameEndsAt = null;
  room.currentRound = null;
  room.usedWords.clear();
  room.wordQueue = [];

  for (const player of [...room.players.values()]) {
    if (!player.connected) {
      room.players.delete(player.id);
      continue;
    }
    player.score = 0;
  }

  if (!room.players.has(room.hostPlayerId)) {
    const first = room.players.values().next().value;
    room.hostPlayerId = first ? first.id : null;
  }
}

function createRoomWithHost(socket, nickname) {
  const roomCode = createRoomCode();
  const playerId = socket.id;
  const room = {
    id: roomCode,
    status: "lobby",
    hostPlayerId: playerId,
    players: new Map(),
    usedWords: new Set(),
    wordQueue: [],
    currentRound: null,
    gameEndsAt: null,
    globalTimer: null,
    roundTimer: null
  };

  room.players.set(playerId, {
    id: playerId,
    socketId: socket.id,
    nickname,
    score: 0,
    connected: true
  });
  rooms.set(roomCode, room);
  socket.join(roomCode);
  socket.data.roomCode = roomCode;
  socket.data.playerId = playerId;
  return room;
}

function joinRoom(socket, room, nickname) {
  if (room.status !== "lobby") {
    throw new Error("Game already started. Joining is closed.");
  }
  if (room.players.size >= MAX_PLAYERS) {
    throw new Error("Room is full.");
  }

  const duplicate = [...room.players.values()].find(
    (player) => normalizeGuess(player.nickname) === normalizeGuess(nickname)
  );
  if (duplicate) {
    throw new Error("Nickname already used in this room.");
  }

  const playerId = socket.id;
  room.players.set(playerId, {
    id: playerId,
    socketId: socket.id,
    nickname,
    score: 0,
    connected: true
  });
  socket.join(room.id);
  socket.data.roomCode = room.id;
  socket.data.playerId = playerId;
}

function handleDisconnect(socket) {
  const roomCode = socket.data.roomCode;
  const playerId = socket.data.playerId;
  if (!roomCode || !playerId) return;

  const room = rooms.get(roomCode);
  if (!room) return;

  const player = room.players.get(playerId);
  if (!player) return;

  if (room.status === "in_game") {
    player.connected = false;
    emitRoomState(room);
    if (getConnectedPlayers(room).length === 0) {
      endGame(room, "all_players_left");
    }
    return;
  }

  room.players.delete(playerId);
  if (room.hostPlayerId === playerId) {
    const first = room.players.values().next().value;
    room.hostPlayerId = first ? first.id : null;
  }

  if (room.players.size === 0) {
    clearTimers(room);
    rooms.delete(room.id);
    return;
  }
  emitRoomState(room);
}

io.on("connection", (socket) => {
  socket.on("room:create", ({ nickname } = {}, callback) => {
    try {
      if (!isGameEnabled()) {
        throw new Error("Game is paused by admin.");
      }
      if (countActiveRooms() >= MAX_ACTIVE_ROOMS) {
        throw new Error("Server busy. Room limit reached.");
      }
      const safeNickname = normalizeText(nickname);
      if (!safeNickname) {
        throw new Error("Nickname is required.");
      }

      const room = createRoomWithHost(socket, safeNickname);
      emitRoomState(room);
      callback?.({ ok: true, roomCode: room.id, playerId: socket.id });
    } catch (error) {
      callback?.({ ok: false, message: error.message });
      emitServerError(socket, error.message);
    }
  });

  socket.on("room:join", ({ roomCode, nickname } = {}, callback) => {
    try {
      if (!isGameEnabled()) {
        throw new Error("Game is paused by admin.");
      }
      const code = normalizeText(roomCode).toUpperCase();
      const safeNickname = normalizeText(nickname);
      if (!code || !safeNickname) {
        throw new Error("Room code and nickname are required.");
      }

      const room = rooms.get(code);
      if (!room) {
        throw new Error("Room not found.");
      }
      joinRoom(socket, room, safeNickname);
      emitRoomState(room);
      callback?.({ ok: true, roomCode: room.id, playerId: socket.id });
    } catch (error) {
      callback?.({ ok: false, message: error.message });
      emitServerError(socket, error.message);
    }
  });

  socket.on("game:start", async (_payload, callback) => {
    try {
      const roomCode = socket.data.roomCode;
      const playerId = socket.data.playerId;
      const room = rooms.get(roomCode);
      if (!room || !playerId) {
        throw new Error("Room not found.");
      }
      if (room.status !== "lobby") {
        throw new Error("Game already started.");
      }
      if (room.hostPlayerId !== playerId) {
        throw new Error("Only host can start the game.");
      }
      await beginGame(room);
      callback?.({ ok: true });
    } catch (error) {
      const message = formatUnknownError(error);
      console.error(`[game:start] room=${socket.data.roomCode ?? "unknown"} player=${socket.data.playerId ?? "unknown"} error=${message}`);
      callback?.({ ok: false, message });
      emitServerError(socket, message);
    }
  });

  socket.on("game:guess", ({ guess } = {}) => {
    const roomCode = socket.data.roomCode;
    const playerId = socket.data.playerId;
    const room = rooms.get(roomCode);
    if (!room || !playerId || room.status !== "in_game" || !room.currentRound) return;

    const player = room.players.get(playerId);
    if (!player || !player.connected) return;

    const normalizedGuess = normalizeGuess(guess);
    if (!normalizedGuess) return;
    if (room.currentRound.winnerPlayerId) return;

    if (normalizedGuess === room.currentRound.word) {
      room.currentRound.winnerPlayerId = player.id;
      const remainingMs = getRoundTimeRemainingMs(room);
      const points = computePoints(remainingMs);
      player.score += points;
      if (room.roundTimer) {
        clearTimeout(room.roundTimer);
        room.roundTimer = null;
      }

      io.to(room.id).emit("game:roundEnded", {
        reason: "guessed",
        word: room.currentRound.word,
        winnerPlayerId: player.id,
        winnerNickname: player.nickname,
        pointsAwarded: points,
        remainingMs
      });

      emitRoomState(room);
      room.currentRound = null;
      startNextRound(room);
    }
  });

  socket.on("game:playAgain", (_payload, callback) => {
    try {
      const roomCode = socket.data.roomCode;
      const playerId = socket.data.playerId;
      const room = rooms.get(roomCode);
      if (!room || !playerId) {
        throw new Error("Room not found.");
      }
      if (room.status !== "finished") {
        throw new Error("Game is not finished yet.");
      }
      if (room.hostPlayerId !== playerId) {
        throw new Error("Only host can restart.");
      }
      resetForPlayAgain(room);
      emitRoomState(room);
      callback?.({ ok: true });
    } catch (error) {
      callback?.({ ok: false, message: error.message });
      emitServerError(socket, error.message);
    }
  });

  socket.on("disconnect", () => {
    handleDisconnect(socket);
  });
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    gameEnabled: isGameEnabled(),
    activeRooms: countActiveRooms(),
    maxActiveRooms: MAX_ACTIVE_ROOMS
  });
});

app.get("/health/db", async (_req, res) => {
  if (!supabase) {
    res.status(500).json({
      ok: false,
      error: "Supabase env is missing."
    });
    return;
  }

  try {
    const { count, error } = await supabase
      .schema("worddash")
      .from("words")
      .select("*", { count: "exact", head: true });

    if (error) {
      res.status(500).json({
        ok: false,
        error: `Supabase query failed: ${error.message}`
      });
      return;
    }

    res.json({
      ok: true,
      wordsCount: count ?? 0
    });
  } catch (unknownError) {
    res.status(500).json({
      ok: false,
      error: formatUnknownError(unknownError)
    });
  }
});

app.get("/", (_req, res) => {
  res.json({
    service: "worddash-realtime",
    status: "running"
  });
});

server.listen(PORT, () => {
  console.log(`worddash-realtime listening on :${PORT}`);
});
