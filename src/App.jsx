import { useEffect, useMemo, useState } from "react";
import { doc, onSnapshot, serverTimestamp, setDoc } from "firebase/firestore";
import "./App.css";
import { db } from "./firebase";

const DEFAULT_PLAYERS = ["아빠", "엄마", "아들", "딸"];
const START_SCORE = 100;

const STORAGE_KEY = "family-card-score-games";
const STORAGE_INDEX_KEY = "family-card-score-current-index";

const SCOREBOARD_REF = doc(db, "scoreboards", "family-card-score");

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

const PLAYER_RENAMES = {
  동생: "딸",
};

function getMultiplierFromStack(stackCount) {
  return 2 ** Number(stackCount || 0);
}

function renamePlayerName(name) {
  return PLAYER_RENAMES[name] || name;
}

function migrateScores(scores = {}) {
  const nextScores = {};

  Object.entries(scores).forEach(([player, score]) => {
    const renamedPlayer = renamePlayerName(player);
    nextScores[renamedPlayer] = (nextScores[renamedPlayer] || 0) + score;
  });

  return nextScores;
}

function migrateGames(games = []) {
  return games.map((game) => ({
    ...game,
    rounds: (game.rounds || []).map((round) => ({
      ...round,
      ranks: {
        1: renamePlayerName(round.ranks?.[1] || ""),
        2: renamePlayerName(round.ranks?.[2] || ""),
        3: renamePlayerName(round.ranks?.[3] || ""),
        4: renamePlayerName(round.ranks?.[4] || ""),
      },
      scores: migrateScores(round.scores),
    })),
  }));
}

function createNewGame(gameNumber = 1) {
  return {
    id: Date.now(),
    gameNumber,
    startScore: START_SCORE,
    createdAt: new Date().toLocaleString(),
    rounds: [],
  };
}

function loadLocalGames() {
  try {
    const savedGames = localStorage.getItem(STORAGE_KEY);

    if (!savedGames) {
      return [createNewGame(1)];
    }

    const parsedGames = JSON.parse(savedGames);

    if (!Array.isArray(parsedGames) || parsedGames.length === 0) {
      return [createNewGame(1)];
    }

    return migrateGames(parsedGames);
  } catch {
    return [createNewGame(1)];
  }
}

function loadLocalCurrentGameIndex() {
  try {
    const savedIndex = localStorage.getItem(STORAGE_INDEX_KEY);

    if (savedIndex === null) {
      return 0;
    }

    const parsedIndex = Number(savedIndex);

    if (Number.isNaN(parsedIndex) || parsedIndex < 0) {
      return 0;
    }

    return parsedIndex;
  } catch {
    return 0;
  }
}

function StackSelect({ value, onChange }) {
  return (
    <select value={value} onChange={(e) => onChange(Number(e.target.value))}>
      {STACK_OPTIONS.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

function App() {
  const [players] = useState(DEFAULT_PLAYERS);

  const [games, setGames] = useState(() => [createNewGame(1)]);
  const [currentGameIndex, setCurrentGameIndex] = useState(0);

  const [isLoading, setIsLoading] = useState(true);
  const [firebaseError, setFirebaseError] = useState("");

  const [roundStack, setRoundStack] = useState(0);

  const [rank1, setRank1] = useState("");
  const [rank2, setRank2] = useState("");
  const [rank3, setRank3] = useState("");
  const [rank4, setRank4] = useState("");

  const [rank2Stack, setRank2Stack] = useState(0);
  const [rank3Stack, setRank3Stack] = useState(0);
  const [rank4Stack, setRank4Stack] = useState(0);

  const safeCurrentGameIndex = Math.min(currentGameIndex, games.length - 1);
  const currentGame = games[safeCurrentGameIndex];

  useEffect(() => {
    const unsubscribe = onSnapshot(
      SCOREBOARD_REF,
      async (snapshot) => {
        if (!snapshot.exists()) {
          const initialGames = loadLocalGames();
          const initialIndex = Math.min(
            loadLocalCurrentGameIndex(),
            initialGames.length - 1
          );

          setGames(initialGames);
          setCurrentGameIndex(initialIndex);
          setIsLoading(false);

          await setDoc(SCOREBOARD_REF, {
            games: initialGames,
            currentGameIndex: initialIndex,
            updatedAt: serverTimestamp(),
          });

          return;
        }

        const data = snapshot.data();

        if (Array.isArray(data.games) && data.games.length > 0) {
          const migratedGames = migrateGames(data.games);
          const hasChanged =
            JSON.stringify(data.games) !== JSON.stringify(migratedGames);

          const nextIndex = Number(data.currentGameIndex || 0);
          const safeIndex = Number.isNaN(nextIndex)
            ? 0
            : Math.min(nextIndex, migratedGames.length - 1);

          setGames(migratedGames);
          setCurrentGameIndex(safeIndex);

          if (hasChanged) {
            await setDoc(
              SCOREBOARD_REF,
              {
                games: migratedGames,
                currentGameIndex: safeIndex,
                updatedAt: serverTimestamp(),
              },
              { merge: true }
            );
          }
        }

        setIsLoading(false);
        setFirebaseError("");
      },
      (error) => {
        console.error(error);
        setFirebaseError(
          "Firebase 연결에 실패했습니다. Firestore Rules를 확인해 주세요."
        );
        setIsLoading(false);
      }
    );

    return () => unsubscribe();
  }, []);

  const currentScores = useMemo(() => {
    const scores = {};

    players.forEach((player) => {
      scores[player] = currentGame.startScore;
    });

    currentGame.rounds.forEach((round) => {
      Object.entries(round.scores).forEach(([player, score]) => {
        if (scores[player] === undefined) {
          scores[player] = currentGame.startScore;
        }

        scores[player] += score;
      });
    });

    return scores;
  }, [players, currentGame]);

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
      setFirebaseError(
        "저장에 실패했습니다. 인터넷 연결 또는 Firestore Rules를 확인해 주세요."
      );
      alert("저장에 실패했습니다. Firebase 설정을 확인해 주세요.");
    }
  }

  function getAvailablePlayers(currentValue, blockedPlayers = []) {
    const blockedSet = new Set(blockedPlayers.filter(Boolean));

    return players.filter((player) => {
      return player === currentValue || !blockedSet.has(player);
    });
  }

  function calculateRoundScores() {
    const roundFactor = getMultiplierFromStack(roundStack);
    const rank2Factor = getMultiplierFromStack(rank2Stack);
    const rank3Factor = getMultiplierFromStack(rank3Stack);
    const rank4Factor = getMultiplierFromStack(rank4Stack);

    const secondScore = rank2 ? -1 * roundFactor * rank2Factor : 0;
    const thirdScore = rank3 ? -2 * roundFactor * rank3Factor : 0;
    const fourthScore = rank4 ? -3 * roundFactor * rank4Factor : 0;

    const firstScore = -(secondScore + thirdScore + fourthScore);

    const scoreData = {};

    if (rank1) scoreData[rank1] = firstScore;
    if (rank2) scoreData[rank2] = secondScore;
    if (rank3) scoreData[rank3] = thirdScore;
    if (rank4) scoreData[rank4] = fourthScore;

    return scoreData;
  }

  function resetRoundForm() {
    setRoundStack(0);

    setRank1("");
    setRank2("");
    setRank3("");
    setRank4("");

    setRank2Stack(0);
    setRank3Stack(0);
    setRank4Stack(0);
  }

  function addRound() {
    const selectedPlayers = [rank1, rank2, rank3, rank4].filter(Boolean);
    const uniquePlayers = new Set(selectedPlayers);

    if (!rank1 || !rank2) {
      alert("1등과 2등은 반드시 선택해야 합니다.");
      return;
    }

    if (rank4 && !rank3) {
      alert("4등을 선택하려면 3등도 먼저 선택해야 합니다.");
      return;
    }

    if (selectedPlayers.length !== uniquePlayers.size) {
      alert("같은 사람을 중복으로 선택할 수 없습니다.");
      return;
    }

    const scores = calculateRoundScores();

    const newRound = {
      roundNumber: currentGame.rounds.length + 1,
      roundStack,
      roundFactor: getMultiplierFromStack(roundStack),
      ranks: {
        1: rank1,
        2: rank2,
        3: rank3,
        4: rank4,
      },
      personalStacks: {
        2: rank2Stack,
        3: rank3Stack,
        4: rank4Stack,
      },
      personalFactors: {
        2: getMultiplierFromStack(rank2Stack),
        3: getMultiplierFromStack(rank3Stack),
        4: getMultiplierFromStack(rank4Stack),
      },
      scores,
      createdAt: new Date().toLocaleString(),
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
  }

  function resetToNewGame() {
    const confirmed = window.confirm(
      "현재 게임을 보관하고 새 게임을 100점부터 시작할까요?"
    );

    if (!confirmed) return;

    const newGame = createNewGame(games.length + 1);
    const updatedGames = [...games, newGame];
    const nextIndex = updatedGames.length - 1;

    saveScoreboard(updatedGames, nextIndex);
    resetRoundForm();
  }

  function deleteGameHistoryKeepCurrent() {
    const confirmed = window.confirm(
      "현재 선택된 게임만 남기고 이전 초기화 이력을 삭제할까요?"
    );

    if (!confirmed) return;

    const currentOnlyGame = {
      ...currentGame,
      id: Date.now(),
      gameNumber: 1,
    };

    saveScoreboard([currentOnlyGame], 0);
  }

  function formatScore(score) {
    if (score > 0) return `+${score}`;
    return `${score}`;
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
          <p className="eyebrow">가족 카드게임</p>
          <h1>점수판</h1>
        </div>

        <button className="reset-button" onClick={resetToNewGame}>
          100점 초기화
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
          {players.map((player) => (
            <div className="score-card" key={player}>
              <div className="player-name">{player}</div>
              <div className="player-score">{currentScores[player]}점</div>
            </div>
          ))}
        </div>
      </section>

      <section className="card">
        <div className="section-title">
          <h2>이번 라운드 결과</h2>
          <span>×2 중첩 방식</span>
        </div>

        <div className="round-form">
          <div className="form-row">
            <label>
              1등
              <select value={rank1} onChange={(e) => setRank1(e.target.value)}>
                <option value="">선택</option>
                {getAvailablePlayers(rank1, [rank2, rank3, rank4]).map(
                  (player) => (
                    <option key={player} value={player}>
                      {player}
                    </option>
                  )
                )}
              </select>
            </label>

            <label>
              전체 배수
              <StackSelect value={roundStack} onChange={setRoundStack} />
              <small>
                {roundStack === 0 ? "기본" : `${roundStack}배`} = ×
                {getMultiplierFromStack(roundStack)}
              </small>
            </label>
          </div>

          <div className="form-row">
            <label>
              2등
              <select value={rank2} onChange={(e) => setRank2(e.target.value)}>
                <option value="">선택</option>
                {getAvailablePlayers(rank2, [rank1, rank3, rank4]).map(
                  (player) => (
                    <option key={player} value={player}>
                      {player}
                    </option>
                  )
                )}
              </select>
            </label>

            <label>
              2등 배수
              <StackSelect value={rank2Stack} onChange={setRank2Stack} />
              <small>
                {rank2Stack === 0 ? "기본" : `${rank2Stack}배`} = ×
                {getMultiplierFromStack(rank2Stack)}
              </small>
            </label>
          </div>

          <div className="form-row">
            <label>
              3등
              <select value={rank3} onChange={(e) => setRank3(e.target.value)}>
                <option value="">없음</option>
                {getAvailablePlayers(rank3, [rank1, rank2, rank4]).map(
                  (player) => (
                    <option key={player} value={player}>
                      {player}
                    </option>
                  )
                )}
              </select>
            </label>

            <label>
              3등 배수
              <StackSelect value={rank3Stack} onChange={setRank3Stack} />
              <small>
                {rank3Stack === 0 ? "기본" : `${rank3Stack}배`} = ×
                {getMultiplierFromStack(rank3Stack)}
              </small>
            </label>
          </div>

          <div className="form-row">
            <label>
              4등
              <select value={rank4} onChange={(e) => setRank4(e.target.value)}>
                <option value="">없음</option>
                {getAvailablePlayers(rank4, [rank1, rank2, rank3]).map(
                  (player) => (
                    <option key={player} value={player}>
                      {player}
                    </option>
                  )
                )}
              </select>
            </label>

            <label>
              4등 배수
              <StackSelect value={rank4Stack} onChange={setRank4Stack} />
              <small>
                {rank4Stack === 0 ? "기본" : `${rank4Stack}배`} = ×
                {getMultiplierFromStack(rank4Stack)}
              </small>
            </label>
          </div>
        </div>

        <div className="action-buttons">
          <button className="primary-button" onClick={addRound}>
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
                  <span>전체 ×{round.roundFactor}</span>
                </div>

                <div className="history-detail">
                  <span>2등 ×{round.personalFactors[2]}</span>

                  {round.ranks[3] && (
                    <span>3등 ×{round.personalFactors[3]}</span>
                  )}

                  {round.ranks[4] && (
                    <span>4등 ×{round.personalFactors[4]}</span>
                  )}
                </div>

                <div className="history-scores">
                  {Object.entries(round.scores).map(([player, score]) => (
                    <span
                      key={player}
                      className={score > 0 ? "plus" : "minus"}
                    >
                      {player} {formatScore(score)}
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
          <span>초기화 이력</span>
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

        <button
          className="secondary-button"
          onClick={deleteGameHistoryKeepCurrent}
          disabled={games.length <= 1}
          style={{ marginTop: "12px" }}
        >
          초기화 이력 삭제
        </button>
      </section>
    </div>
  );
}

export default App;