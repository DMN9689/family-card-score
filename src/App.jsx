import { useEffect, useMemo, useState } from "react";
import { doc, onSnapshot, serverTimestamp, setDoc } from "firebase/firestore";
import "./App.css";
import { db } from "./firebase";

const APP_VERSION = "hoola-score-v1";

const DEFAULT_PLAYERS = [
  { id: "p1", name: "재우" },
  { id: "p2", name: "항미" },
  { id: "p3", name: "수현" },
  { id: "p4", name: "가현" },
  { id: "p5", name: "이름" },
];

const DEFAULT_ACTIVE_PLAYER_IDS = ["p1", "p2", "p3", "p4"];

const SCOREBOARD_REF = doc(db, "scoreboards", "family-card-score");

const ROUND_MODES = [
  { id: "normal", label: "일반훌라" },
  { id: "thankyou", label: "땡큐훌라" },
  { id: "perfect", label: "퍼펙트훌라" },
  { id: "hoolbak", label: "훌박" },
  { id: "stop", label: "스톱" },
  { id: "hand", label: "족보 스톱" },
];

const HAND_TYPES = [
  { id: "straightFlush", label: "스트레이트 플러쉬", multiplier: 8 },
  { id: "high", label: "하이", multiplier: 4 },
  { id: "low", label: "로우", multiplier: 4 },
  { id: "sevenFourCard", label: "세븐 포카드", multiplier: 4 },
];

const STACK_OPTIONS = [
  { value: 0, label: "기본 = ×1" },
  { value: 1, label: "1배 = ×2" },
  { value: 2, label: "2배 = ×4" },
  { value: 3, label: "3배 = ×8" },
  { value: 4, label: "4배 = ×16" },
  { value: 5, label: "5배 = ×32" },
  { value: 6, label: "6배 = ×64" },
  { value: 7, label: "7배 = ×128" },
  { value: 8, label: "8배 = ×256" },
];

const SEVEN_OPTIONS = [0, 1, 2, 3, 4];

function getMultiplierFromStack(stackCount) {
  return 2 ** Number(stackCount || 0);
}

function getSevenMultiplier(sevenCount) {
  return 2 ** Number(sevenCount || 0);
}

function getRankBaseScore(rank) {
  const numberRank = Number(rank);

  if (numberRank <= 1) return 0;

  return -(numberRank - 1);
}

function getRoundModeLabel(mode) {
  return ROUND_MODES.find((item) => item.id === mode)?.label || "일반훌라";
}

function getHandTypeLabel(handType) {
  return HAND_TYPES.find((item) => item.id === handType)?.label || "";
}

function getRoundMultiplier(roundMode, handType) {
  if (roundMode === "perfect") return 4;
  if (roundMode === "hoolbak") return 2;

  if (roundMode === "hand") {
    return HAND_TYPES.find((item) => item.id === handType)?.multiplier || 1;
  }

  return 1;
}

function formatScore(score) {
  if (score > 0) return `+${score}`;
  return `${score}`;
}

function createNewGame(gameNumber = 1, players = DEFAULT_PLAYERS, activePlayerIds = DEFAULT_ACTIVE_PLAYER_IDS) {
  return {
    id: Date.now(),
    version: APP_VERSION,
    gameNumber,
    createdAt: new Date().toLocaleString(),
    players,
    activePlayerIds,
    rounds: [],
  };
}

function normalizeGame(game, index) {
  if (!game || game.version !== APP_VERSION || !Array.isArray(game.players)) {
    return createNewGame(index + 1);
  }

  const normalizedPlayers = DEFAULT_PLAYERS.map((defaultPlayer) => {
    const savedPlayer = game.players.find((player) => player.id === defaultPlayer.id);

    return {
      ...defaultPlayer,
      name: savedPlayer?.name || defaultPlayer.name,
    };
  });

  const normalizedActivePlayerIds = Array.isArray(game.activePlayerIds)
    ? game.activePlayerIds.filter((id) =>
        normalizedPlayers.some((player) => player.id === id)
      )
    : DEFAULT_ACTIVE_PLAYER_IDS;

  return {
    ...game,
    version: APP_VERSION,
    gameNumber: game.gameNumber || index + 1,
    players: normalizedPlayers,
    activePlayerIds:
      normalizedActivePlayerIds.length >= 2
        ? normalizedActivePlayerIds
        : DEFAULT_ACTIVE_PLAYER_IDS,
    rounds: Array.isArray(game.rounds) ? game.rounds : [],
  };
}

function createDefaultPlayerInputs(activePlayerIds = DEFAULT_ACTIVE_PLAYER_IDS) {
  const inputs = {};
  const maxRank = activePlayerIds.length;

  activePlayerIds.forEach((playerId, index) => {
    inputs[playerId] = {
      rank: Math.min(index + 2, maxRank),
      registered: true,
      sevenCount: 0,
      personalStack: 0,
    };
  });

  return inputs;
}

function StackSelect({ value, onChange }) {
  return (
    <select value={value} onChange={(event) => onChange(Number(event.target.value))}>
      {STACK_OPTIONS.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

function App() {
  const [games, setGames] = useState(() => [createNewGame(1)]);
  const [currentGameIndex, setCurrentGameIndex] = useState(0);

  const [isLoading, setIsLoading] = useState(true);
  const [firebaseError, setFirebaseError] = useState("");

  const [setupPlayers, setSetupPlayers] = useState(DEFAULT_PLAYERS);
  const [setupActivePlayerIds, setSetupActivePlayerIds] = useState(DEFAULT_ACTIVE_PLAYER_IDS);
  const [isEditingNames, setIsEditingNames] = useState(false);

  const [winnerId, setWinnerId] = useState("");
  const [roundMode, setRoundMode] = useState("normal");
  const [handType, setHandType] = useState("straightFlush");
  const [bustTargetId, setBustTargetId] = useState("");
  const [playerInputs, setPlayerInputs] = useState(() =>
    createDefaultPlayerInputs(DEFAULT_ACTIVE_PLAYER_IDS)
  );

  const safeCurrentGameIndex = Math.min(currentGameIndex, games.length - 1);
  const currentGame = games[safeCurrentGameIndex] || createNewGame(1);

  const currentPlayers = currentGame.players || DEFAULT_PLAYERS;
  const activePlayerIds = currentGame.activePlayerIds || DEFAULT_ACTIVE_PLAYER_IDS;

  const activePlayers = useMemo(() => {
    return activePlayerIds
      .map((id) => currentPlayers.find((player) => player.id === id))
      .filter(Boolean);
  }, [activePlayerIds, currentPlayers]);

  useEffect(() => {
    const unsubscribe = onSnapshot(
      SCOREBOARD_REF,
      async (snapshot) => {
        if (!snapshot.exists()) {
          const initialGame = createNewGame(1);

          setGames([initialGame]);
          setCurrentGameIndex(0);
          setIsLoading(false);

          await setDoc(SCOREBOARD_REF, {
            games: [initialGame],
            currentGameIndex: 0,
            updatedAt: serverTimestamp(),
          });

          return;
        }

        const data = snapshot.data();
        const rawGames = Array.isArray(data.games) && data.games.length > 0
          ? data.games
          : [createNewGame(1)];

        const normalizedGames = rawGames.map((game, index) => normalizeGame(game, index));
        const nextIndex = Number(data.currentGameIndex || 0);
        const safeIndex = Number.isNaN(nextIndex)
          ? 0
          : Math.min(nextIndex, normalizedGames.length - 1);

        setGames(normalizedGames);
        setCurrentGameIndex(safeIndex);
        setIsLoading(false);
        setFirebaseError("");

        if (JSON.stringify(rawGames) !== JSON.stringify(normalizedGames)) {
          await setDoc(
            SCOREBOARD_REF,
            {
              games: normalizedGames,
              currentGameIndex: safeIndex,
              updatedAt: serverTimestamp(),
            },
            { merge: true }
          );
        }
      },
      (error) => {
        console.error(error);
        setFirebaseError("Firebase 연결에 실패했습니다. Firestore Rules를 확인해 주세요.");
        setIsLoading(false);
      }
    );

    return () => unsubscribe();
  }, []);

  useEffect(() => {
    setSetupPlayers(currentPlayers);
    setSetupActivePlayerIds(activePlayerIds);
    setPlayerInputs(createDefaultPlayerInputs(activePlayerIds));
    setWinnerId("");
    setBustTargetId("");
  }, [currentGame.id]);

  useEffect(() => {
    if (winnerId === bustTargetId) {
      setBustTargetId("");
    }
  }, [winnerId, bustTargetId]);

  useEffect(() => {
    setPlayerInputs((previousInputs) => {
      const nextInputs = { ...previousInputs };

      activePlayerIds.forEach((playerId, index) => {
        if (!nextInputs[playerId]) {
          nextInputs[playerId] = {
            rank: Math.min(index + 2, activePlayerIds.length),
            registered: true,
            sevenCount: 0,
            personalStack: 0,
          };
        }
      });

      return nextInputs;
    });
  }, [activePlayerIds]);

  const currentScores = useMemo(() => {
    const scores = {};

    activePlayers.forEach((player) => {
      scores[player.id] = 0;
    });

    currentGame.rounds.forEach((round) => {
      Object.entries(round.scores || {}).forEach(([playerId, score]) => {
        if (scores[playerId] === undefined) {
          scores[playerId] = 0;
        }

        scores[playerId] += score;
      });
    });

    return scores;
  }, [activePlayers, currentGame.rounds]);

  const roundPreview = useMemo(() => {
    return calculateRoundScores();
  }, [activePlayers, winnerId, roundMode, handType, bustTargetId, playerInputs]);

  async function saveScoreboard(nextGames, nextIndex) {
    setGames(nextGames);
    setCurrentGameIndex(nextIndex);

    try {
      await setDoc(
        SCOREBOARD_REF,
        {
          games: nextGames,
          currentGameIndex: nextIndex,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );

      setFirebaseError("");
    } catch (error) {
      console.error(error);
      setFirebaseError("저장에 실패했습니다. 인터넷 연결 또는 Firestore Rules를 확인해 주세요.");
      alert("저장에 실패했습니다. Firebase 설정을 확인해 주세요.");
    }
  }

  function getPlayerName(playerId, players = currentPlayers) {
    return players.find((player) => player.id === playerId)?.name || playerId;
  }

  function getPlayerInput(playerId) {
    return (
      playerInputs[playerId] || {
        rank: 2,
        registered: true,
        sevenCount: 0,
        personalStack: 0,
      }
    );
  }

  function updatePlayerInput(playerId, changes) {
    setPlayerInputs((previousInputs) => ({
      ...previousInputs,
      [playerId]: {
        ...getPlayerInput(playerId),
        ...previousInputs[playerId],
        ...changes,
      },
    }));
  }

  function calculateRoundScores() {
    const scores = {};
    const details = [];

    activePlayers.forEach((player) => {
      scores[player.id] = 0;
    });

    if (!winnerId || activePlayers.length < 2) {
      return { scores, details, hasBust: false, totalWinnerScore: 0 };
    }

    const maxRank = activePlayers.length;
    const roundMultiplier = getRoundMultiplier(roundMode, handType);
    const losers = activePlayers.filter((player) => player.id !== winnerId);
    const rawLoserScores = {};
    const canUseBust = roundMode === "thankyou" || roundMode === "stop";
    const hasBust = canUseBust && Boolean(bustTargetId) && bustTargetId !== winnerId;

    losers.forEach((player) => {
      const input = getPlayerInput(player.id);
      const isBustTarget = hasBust && bustTargetId === player.id;

      const effectiveRegistered =
        roundMode === "perfect" ? false : Boolean(input.registered);

      const effectiveRank =
        !effectiveRegistered || isBustTarget ? maxRank : Number(input.rank || 2);

      const baseScore = getRankBaseScore(effectiveRank);
      const personalMultiplier = getMultiplierFromStack(input.personalStack);
      const unregisteredMultiplier = effectiveRegistered ? 1 : 2;
      const sevenMultiplier = getSevenMultiplier(input.sevenCount);

      const finalMultiplier =
        roundMultiplier *
        personalMultiplier *
        unregisteredMultiplier *
        sevenMultiplier;

      const rawScore = baseScore * finalMultiplier;
      rawLoserScores[player.id] = rawScore;

      details.push({
        playerId: player.id,
        name: player.name,
        rank: effectiveRank,
        baseScore,
        registered: effectiveRegistered,
        sevenCount: Number(input.sevenCount || 0),
        personalStack: Number(input.personalStack || 0),
        roundMultiplier,
        personalMultiplier,
        unregisteredMultiplier,
        sevenMultiplier,
        finalMultiplier,
        originalScore: rawScore,
        finalScore: rawScore,
        isBustTarget,
      });
    });

    if (hasBust) {
      const loserTotal = Object.values(rawLoserScores).reduce(
        (sum, score) => sum + score,
        0
      );
      const bustScore = loserTotal * 2;

      losers.forEach((player) => {
        scores[player.id] = player.id === bustTargetId ? bustScore : 0;
      });

      scores[winnerId] = -bustScore;

      const updatedDetails = details.map((detail) => ({
        ...detail,
        finalScore: detail.playerId === bustTargetId ? bustScore : 0,
      }));

      return {
        scores,
        details: updatedDetails,
        hasBust: true,
        totalWinnerScore: scores[winnerId],
      };
    }

    const loserTotal = Object.values(rawLoserScores).reduce(
      (sum, score) => sum + score,
      0
    );

    losers.forEach((player) => {
      scores[player.id] = rawLoserScores[player.id];
    });

    scores[winnerId] = -loserTotal;

    return {
      scores,
      details,
      hasBust: false,
      totalWinnerScore: scores[winnerId],
    };
  }

  function resetRoundForm() {
    setWinnerId("");
    setRoundMode("normal");
    setHandType("straightFlush");
    setBustTargetId("");
    setPlayerInputs(createDefaultPlayerInputs(activePlayerIds));
  }

  function validateGameSetup(playerIds = setupActivePlayerIds, players = setupPlayers) {
    if (playerIds.length < 2) {
      alert("참가자는 최소 2명 이상 선택해야 합니다.");
      return false;
    }

    if (playerIds.length > 5) {
      alert("참가자는 최대 5명까지 선택할 수 있습니다.");
      return false;
    }

    const hasEmptyName = playerIds.some((playerId) => {
      const player = players.find((item) => item.id === playerId);
      return !player?.name?.trim();
    });

    if (hasEmptyName) {
      alert("참가자 이름은 비워둘 수 없습니다.");
      return false;
    }

    return true;
  }

  function startNewGame() {
    if (!validateGameSetup()) return;

    const confirmed = window.confirm("새로운 게임을 0점부터 시작할까요? 이전 게임 기록은 보관됩니다.");

    if (!confirmed) return;

    const newGame = createNewGame(
      games.length + 1,
      setupPlayers,
      setupActivePlayerIds
    );

    const updatedGames = [...games, newGame];
    const nextIndex = updatedGames.length - 1;

    saveScoreboard(updatedGames, nextIndex);
    resetRoundForm();

    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function applyCurrentGameSettings() {
    if (!validateGameSetup()) return;

    if (currentGame.rounds.length > 0) {
      const confirmed = window.confirm(
        "현재 게임에 이미 라운드 이력이 있습니다. 참가자 설정을 변경하면 표시되는 점수가 달라질 수 있습니다. 계속할까요?"
      );

      if (!confirmed) return;
    }

    const updatedGames = games.map((game, index) => {
      if (index !== safeCurrentGameIndex) return game;

      return {
        ...game,
        players: setupPlayers,
        activePlayerIds: setupActivePlayerIds,
      };
    });

    saveScoreboard(updatedGames, safeCurrentGameIndex);
    resetRoundForm();
    setIsEditingNames(false);
  }

  function deleteCurrentRoundHistory() {
    if (currentGame.rounds.length === 0) {
      alert("삭제할 라운드 이력이 없습니다.");
      return;
    }

    const confirmed = window.confirm("현재 게임의 라운드 이력과 점수를 모두 삭제할까요?");

    if (!confirmed) return;

    const updatedGames = games.map((game, index) => {
      if (index !== safeCurrentGameIndex) return game;

      return {
        ...game,
        rounds: [],
      };
    });

    saveScoreboard(updatedGames, safeCurrentGameIndex);
    resetRoundForm();

    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function toggleSetupActivePlayer(playerId) {
    setSetupActivePlayerIds((previousIds) => {
      if (previousIds.includes(playerId)) {
        if (previousIds.length <= 2) {
          alert("참가자는 최소 2명 이상이어야 합니다.");
          return previousIds;
        }

        return previousIds.filter((id) => id !== playerId);
      }

      if (previousIds.length >= 5) {
        alert("참가자는 최대 5명까지 선택할 수 있습니다.");
        return previousIds;
      }

      return DEFAULT_PLAYERS.map((player) => player.id).filter(
        (id) => previousIds.includes(id) || id === playerId
      );
    });
  }

  function updateSetupPlayerName(playerId, name) {
    setSetupPlayers((previousPlayers) =>
      previousPlayers.map((player) =>
        player.id === playerId ? { ...player, name } : player
      )
    );
  }

  function changeRoundMode(nextMode) {
    setRoundMode(nextMode);
    setBustTargetId("");

    if (nextMode !== "hand") {
      setHandType("straightFlush");
    }

    if (nextMode === "perfect") {
      const nextInputs = {};

      activePlayerIds.forEach((playerId, index) => {
        nextInputs[playerId] = {
          ...getPlayerInput(playerId),
          rank: Math.min(index + 2, activePlayerIds.length),
          registered: false,
        };
      });

      setPlayerInputs(nextInputs);
    }
  }

  function handleRegisteredChange(playerId, value) {
    const isRegistered = value === "registered";
    const maxRank = activePlayers.length;

    updatePlayerInput(playerId, {
      registered: isRegistered,
      rank: isRegistered ? Math.min(getPlayerInput(playerId).rank || 2, maxRank) : maxRank,
    });
  }

  function saveRound() {
    if (activePlayers.length < 2) {
      alert("참가자는 최소 2명 이상이어야 합니다.");
      return;
    }

    if (!winnerId) {
      alert("1등을 선택해 주세요.");
      return;
    }

    if (roundMode === "hand" && !handType) {
      alert("족보 종류를 선택해 주세요.");
      return;
    }

    if ((roundMode === "thankyou" || roundMode === "stop") && bustTargetId === winnerId) {
      alert("독박 대상자는 1등이 될 수 없습니다.");
      return;
    }

    const scores = roundPreview.scores;

    const newRound = {
      roundNumber: currentGame.rounds.length + 1,
      createdAt: new Date().toLocaleString(),
      mode: roundMode,
      modeLabel: getRoundModeLabel(roundMode),
      handType: roundMode === "hand" ? handType : "",
      handTypeLabel: roundMode === "hand" ? getHandTypeLabel(handType) : "",
      winnerId,
      bustTargetId,
      hasBust: roundPreview.hasBust,
      activePlayerIds,
      playersSnapshot: currentPlayers,
      inputs: playerInputs,
      details: roundPreview.details,
      scores,
    };

    const updatedGames = games.map((game, index) => {
      if (index !== safeCurrentGameIndex) return game;

      return {
        ...game,
        rounds: [...game.rounds, newRound],
      };
    });

    saveScoreboard(updatedGames, safeCurrentGameIndex);
    resetRoundForm();

    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function undoLastRound() {
    if (currentGame.rounds.length === 0) {
      alert("취소할 라운드가 없습니다.");
      return;
    }

    const confirmed = window.confirm("마지막 라운드를 취소할까요?");

    if (!confirmed) return;

    const updatedGames = games.map((game, index) => {
      if (index !== safeCurrentGameIndex) return game;

      return {
        ...game,
        rounds: game.rounds.slice(0, -1),
      };
    });

    saveScoreboard(updatedGames, safeCurrentGameIndex);
    resetRoundForm();

    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  if (isLoading) {
    return (
      <div className="app">
        <section className="card">
          <h2>점수판 불러오는 중...</h2>
        </section>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="header">
        <div>
          <p className="eyebrow">우리집 훌라</p>
          <h1>점수 자동계산기</h1>
        </div>

        <button className="reset-button" onClick={startNewGame}>
          새로운 게임 시작
        </button>
      </header>

      {firebaseError && (
        <section className="card">
          <p className="empty">{firebaseError}</p>
        </section>
      )}

      <section className="card">
        <div className="section-title">
          <h2>현재 점수</h2>
          <span>게임 #{currentGame.gameNumber}</span>
        </div>

        <div className="score-grid">
          {activePlayers.map((player) => (
            <div className="score-card" key={player.id}>
              <div className="player-name">{player.name}</div>
              <div className="player-score">{currentScores[player.id] || 0}점</div>
            </div>
          ))}
        </div>
      </section>

      <section className="card">
        <div className="section-title">
          <h2>게임 설정</h2>
          <span>{setupActivePlayerIds.length}명 참가</span>
        </div>

        <div className="game-tabs" style={{ marginBottom: "12px" }}>
          <button
            className={isEditingNames ? "active" : ""}
            onClick={() => setIsEditingNames(!isEditingNames)}
          >
            이름 변경
          </button>

          <button onClick={applyCurrentGameSettings}>
            현재 게임 설정 적용
          </button>

          <button onClick={deleteCurrentRoundHistory}>
            라운드 이력 삭제
          </button>
        </div>

        <div className="history-list">
          {setupPlayers.map((player) => (
            <div className="history-item" key={player.id}>
              <label
                style={{
                  display: "flex",
                  flexDirection: "row",
                  alignItems: "center",
                  gap: "10px",
                  marginBottom: isEditingNames ? "10px" : 0,
                }}
              >
                <input
                  type="checkbox"
                  checked={setupActivePlayerIds.includes(player.id)}
                  onChange={() => toggleSetupActivePlayer(player.id)}
                  style={{ width: "18px", height: "18px" }}
                />
                참가
              </label>

              {isEditingNames ? (
                <label>
                  {player.id.replace("p", "")}번 이름
                  <input
                    value={player.name}
                    onChange={(event) =>
                      updateSetupPlayerName(player.id, event.target.value)
                    }
                  />
                </label>
              ) : (
                <div className="history-head" style={{ marginBottom: 0 }}>
                  <strong>{player.name}</strong>
                  <span>
                    {setupActivePlayerIds.includes(player.id) ? "참가" : "미참여"}
                  </span>
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      <section className="card">
        <div className="section-title">
          <h2>이번 라운드 결과</h2>
          <span>훌라 규칙 v1.0</span>
        </div>

        <div className="round-form">
          <div className="form-row">
            <label>
              1등
              <select
                value={winnerId}
                onChange={(event) => {
                  setWinnerId(event.target.value);
                  if (event.target.value === bustTargetId) {
                    setBustTargetId("");
                  }
                }}
              >
                <option value="">선택</option>
                {activePlayers.map((player) => (
                  <option key={player.id} value={player.id}>
                    {player.name}
                  </option>
                ))}
              </select>
            </label>

            <label>
              종료 방식
              <select
                value={roundMode}
                onChange={(event) => changeRoundMode(event.target.value)}
              >
                {ROUND_MODES.map((mode) => (
                  <option key={mode.id} value={mode.id}>
                    {mode.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="game-tabs">
            {ROUND_MODES.map((mode) => (
              <button
                key={mode.id}
                className={roundMode === mode.id ? "active" : ""}
                onClick={() => changeRoundMode(mode.id)}
              >
                {mode.label}
              </button>
            ))}
          </div>

          {roundMode === "hand" && (
            <div className="form-row">
              <label>
                족보 종류
                <select
                  value={handType}
                  onChange={(event) => setHandType(event.target.value)}
                >
                  {HAND_TYPES.map((type) => (
                    <option key={type.id} value={type.id}>
                      {type.label} ×{type.multiplier}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                족보 배수
                <input
                  value={`×${getRoundMultiplier(roundMode, handType)}`}
                  readOnly
                />
              </label>
            </div>
          )}

          {(roundMode === "thankyou" || roundMode === "stop") && (
            <p className="empty">
              {roundMode === "thankyou"
                ? "땡큐박 대상자가 있으면 아래 패자 카드에서 선택하세요."
                : "스톱박이 발생했으면 아래 패자 카드에서 대상자를 선택하세요."}
            </p>
          )}

          {winnerId && (
            <div className="history-list">
              {activePlayers
                .filter((player) => player.id !== winnerId)
                .map((player) => {
                  const input = getPlayerInput(player.id);
                  const isPerfect = roundMode === "perfect";
                  const effectiveRegistered = isPerfect ? false : input.registered;
                  const isBustTarget = bustTargetId === player.id;
                  const effectiveRank =
                    !effectiveRegistered || isBustTarget
                      ? activePlayers.length
                      : input.rank;

                  const previewDetail = roundPreview.details.find(
                    (detail) => detail.playerId === player.id
                  );

                  return (
                    <div className="history-item" key={player.id}>
                      <div className="history-head">
                        <strong>{player.name}</strong>
                        <span>
                          이번 점수 {formatScore(previewDetail?.finalScore || 0)}
                        </span>
                      </div>

                      <div className="form-row">
                        <label>
                          등수
                          <select
                            value={effectiveRank}
                            disabled={!effectiveRegistered || isBustTarget}
                            onChange={(event) =>
                              updatePlayerInput(player.id, {
                                rank: Number(event.target.value),
                              })
                            }
                          >
                            {Array.from(
                              { length: activePlayers.length - 1 },
                              (_, index) => index + 2
                            ).map((rank) => (
                              <option key={rank} value={rank}>
                                {rank}등
                              </option>
                            ))}
                          </select>
                          {(!effectiveRegistered || isBustTarget) && (
                            <small>
                              {!effectiveRegistered
                                ? "미등록자는 자동 꼴등 처리"
                                : "독박 대상자는 자동 꼴등 처리"}
                            </small>
                          )}
                        </label>

                        <label>
                          등록 상태
                          <select
                            value={effectiveRegistered ? "registered" : "unregistered"}
                            disabled={isPerfect}
                            onChange={(event) =>
                              handleRegisteredChange(player.id, event.target.value)
                            }
                          >
                            <option value="registered">등록</option>
                            <option value="unregistered">미등록</option>
                          </select>
                          {isPerfect && <small>퍼펙트훌라는 미등록 자동 적용</small>}
                        </label>
                      </div>

                      <div className="form-row">
                        <label>
                          7 보유
                          <select
                            value={input.sevenCount}
                            onChange={(event) =>
                              updatePlayerInput(player.id, {
                                sevenCount: Number(event.target.value),
                              })
                            }
                          >
                            {SEVEN_OPTIONS.map((count) => (
                              <option key={count} value={count}>
                                {count}장 = ×{getSevenMultiplier(count)}
                              </option>
                            ))}
                          </select>
                        </label>

                        <label>
                          개인 배수
                          <StackSelect
                            value={input.personalStack}
                            onChange={(value) =>
                              updatePlayerInput(player.id, {
                                personalStack: value,
                              })
                            }
                          />
                        </label>
                      </div>

                      {(roundMode === "thankyou" || roundMode === "stop") && (
                        <div className="game-tabs">
                          <button
                            className={isBustTarget ? "active" : ""}
                            onClick={() =>
                              setBustTargetId(isBustTarget ? "" : player.id)
                            }
                          >
                            {roundMode === "thankyou" ? "땡큐박 대상" : "스톱박 대상"}
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
            </div>
          )}
        </div>

        {winnerId && (
          <div className="history-item" style={{ marginBottom: "14px" }}>
            <div className="history-head">
              <strong>이번 라운드 예상 점수</strong>
              <span>{roundPreview.hasBust ? "독박 적용" : "일반 계산"}</span>
            </div>

            <div className="history-scores">
              {activePlayers.map((player) => (
                <span
                  key={player.id}
                  className={(roundPreview.scores[player.id] || 0) > 0 ? "plus" : "minus"}
                >
                  {player.name} {formatScore(roundPreview.scores[player.id] || 0)}
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="action-buttons">
          <button className="primary-button" onClick={saveRound}>
            라운드 저장
          </button>

          <button
            className="secondary-button"
            onClick={undoLastRound}
            disabled={currentGame.rounds.length === 0}
          >
            마지막 라운드 취소
          </button>
        </div>
      </section>

      <section className="card">
        <div className="section-title">
          <h2>라운드 이력</h2>
          <span>{currentGame.rounds.length}판 진행</span>
        </div>

        {currentGame.rounds.length === 0 ? (
          <p className="empty">아직 저장된 라운드가 없습니다.</p>
        ) : (
          <div className="history-list">
            {[...currentGame.rounds].reverse().map((round) => (
              <div className="history-item" key={round.roundNumber}>
                <div className="history-head">
                  <strong>{round.roundNumber}라운드</strong>
                  <span>
                    {round.modeLabel}
                    {round.handTypeLabel ? ` / ${round.handTypeLabel}` : ""}
                    {round.hasBust ? " / 독박" : ""}
                  </span>
                </div>

                <div className="history-scores">
                  {Object.entries(round.scores || {}).map(([playerId, score]) => (
                    <span key={playerId} className={score > 0 ? "plus" : "minus"}>
                      {getPlayerName(playerId, round.playersSnapshot || currentPlayers)}{" "}
                      {formatScore(score)}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="card">
        <div className="section-title">
          <h2>게임 기록</h2>
          <span>새 게임 이력</span>
        </div>

        <div className="game-tabs">
          {games.map((game, index) => (
            <button
              key={game.id}
              className={index === safeCurrentGameIndex ? "active" : ""}
              onClick={() => setCurrentGameIndex(index)}
            >
              게임 #{game.gameNumber}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

export default App;