import { useEffect, useMemo, useRef, useState } from "react";
import { doc, onSnapshot, serverTimestamp, setDoc } from "firebase/firestore";
import "./App.css";
import { db } from "./firebase";

const APP_VERSION = "hoola-score-v5";
const ACCESS_CODE = "hoola";
const ACCESS_UNLOCK_STORAGE_KEY = `${APP_VERSION}:access-unlocked`;

const DEFAULT_PLAYERS = [
  { id: "p1", name: "재우" },
  { id: "p2", name: "항미" },
  { id: "p3", name: "수현" },
  { id: "p4", name: "가현" },
  { id: "p5", name: "이름" },
];

const DEFAULT_ACTIVE_PLAYER_IDS = ["p1", "p2", "p3", "p4"];

const PLAYER_SORT_ORDER = Object.fromEntries(
  DEFAULT_PLAYERS.map((player, index) => [player.id, index])
);

const SCOREBOARD_REF = doc(db, "scoreboards", "family-card-score");

let hasAttemptedInitialScoreboardWrite = false;

const ROUND_MODES = [
  { value: "normal", label: "일반훌라", badge: "×1" },
  { value: "thankyou", label: "땡큐훌라", badge: "독박 ×2" },
  { value: "perfect", label: "퍼펙트훌라", badge: "×2" },
  { value: "hoolbak", label: "훌박", badge: "×2" },
  { value: "stop", label: "스톱", badge: "기본 ×1" },
  { value: "hand-stop", label: "족보 스톱", badge: "×4~×8" },
];

const HAND_TYPES = [
  {
    value: "straight-flush",
    label: "스트레이트 플러쉬",
    multiplier: 8,
    description: "미등록 상태에서 7장이 같은 무늬로 연속 숫자인 경우",
  },
  {
    value: "high",
    label: "하이",
    multiplier: 4,
    description: "미등록 상태에서 7장 카드 합이 80 이상인 경우",
  },
  {
    value: "low",
    label: "로우",
    multiplier: 4,
    description: "미등록 상태에서 7장 카드 합이 15 이하인 경우",
  },
  {
    value: "seven-four-card",
    label: "세븐 포카드",
    multiplier: 4,
    description: "손패에 7 카드가 4장 있는 경우",
  },
];

function createDefaultPlayerNames() {
  return Object.fromEntries(DEFAULT_PLAYERS.map((player) => [player.id, player.name]));
}

function createNewGame() {
  return {
    id: `game-${Date.now()}`,
    title: `게임 ${new Date().toLocaleString("ko-KR", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })}`,
    createdAt: new Date().toISOString(),
    playerNames: createDefaultPlayerNames(),
    activePlayerIds: DEFAULT_ACTIVE_PLAYER_IDS,
    rounds: [],
  };
}

function normalizeGame(game) {
  const playerNames = {
    ...createDefaultPlayerNames(),
    ...(game?.playerNames || {}),
  };

  const activePlayerIds =
    Array.isArray(game?.activePlayerIds) && game.activePlayerIds.length >= 2
      ? game.activePlayerIds.filter((id) => playerNames[id])
      : DEFAULT_ACTIVE_PLAYER_IDS;

  return {
    ...game,
    id: game?.id || `game-${Date.now()}`,
    title: game?.title || "게임",
    createdAt: game?.createdAt || new Date().toISOString(),
    playerNames,
    activePlayerIds,
    rounds: Array.isArray(game?.rounds) ? game.rounds : [],
  };
}

function normalizeGames(games) {
  if (!Array.isArray(games) || games.length === 0) {
    return [createNewGame()];
  }

  return games.map(normalizeGame);
}

function getPlayerName(playerNames, playerId) {
  return (
    playerNames?.[playerId] ||
    DEFAULT_PLAYERS.find((player) => player.id === playerId)?.name ||
    playerId
  );
}

function getPlayerBaseOrder(playerId) {
  return PLAYER_SORT_ORDER[playerId] ?? 999;
}

function getRankBaseScore(rank) {
  return -(Number(rank) - 1);
}

function getSevenMultiplier(sevenCount) {
  return 2 ** Number(sevenCount || 0);
}

function getHandType(handType) {
  return HAND_TYPES.find((item) => item.value === handType);
}

function getRoundMode(roundMode) {
  return ROUND_MODES.find((item) => item.value === roundMode);
}

function getRoundModeMultiplier(roundMode, handType) {
  if (roundMode === "perfect") return 2;
  if (roundMode === "hoolbak") return 2;

  if (roundMode === "hand-stop") {
    return getHandType(handType)?.multiplier || 1;
  }

  return 1;
}

function getSelectedModeDescription(roundMode, handType, bustTargetId) {
  if (!roundMode) {
    return "종료방식을 선택하면 적용 배수가 표시돼.";
  }

  if (roundMode === "normal") {
    return "일반훌라: 추가 종료 배수 없음 ×1";
  }

  if (roundMode === "thankyou") {
    return bustTargetId
      ? "땡큐훌라: 땡큐박 대상 자동 꼴등 + 전체 패자점수 독박 ×2"
      : "땡큐훌라: 땡큐박 대상 독박 ×2";
  }

  if (roundMode === "perfect") {
    return "퍼펙트훌라: 패자 전원 퍼펙트 ×2 + 자동 미등록 ×2";
  }

  if (roundMode === "hoolbak") {
    return "훌박: 패자 전원 훌박 ×2";
  }

  if (roundMode === "stop") {
    return bustTargetId
      ? "스톱박 적용: 대상자 자동 꼴등 + 전체 패자점수 독박 ×2"
      : "스톱: 기본 ×1 / 스톱박 발생 시 대상자 독박 ×2";
  }

  if (roundMode === "hand-stop") {
    const hand = getHandType(handType);

    return hand
      ? `족보 스톱: ${hand.label} ×${hand.multiplier}`
      : "족보 스톱: 족보를 선택하면 배수가 적용돼.";
  }

  return "";
}

function formatScore(score) {
  if (score > 0) return `+${score}`;
  return `${score}`;
}

function getFirebaseErrorMessage(error, actionLabel) {
  const code = error?.code || "";

  if (code.includes("resource-exhausted")) {
    return `${actionLabel} 실패: Firebase 무료 사용량이 오늘 한도를 넘었어. 한국시간 오후 4시쯤 리셋된 뒤 다시 시도해줘.`;
  }

  if (code.includes("permission-denied")) {
    return `${actionLabel} 실패: Firestore 규칙 권한이 막혀 있어. Firebase 콘솔의 Rules를 확인해줘.`;
  }

  if (code.includes("unavailable")) {
    return `${actionLabel} 실패: Firebase 서버나 인터넷 연결이 잠시 불안정해. 잠깐 뒤 다시 시도해줘.`;
  }

  return `${actionLabel} 실패: ${error?.message || "알 수 없는 Firebase 오류가 발생했어."}`;
}

function createDefaultPlayerInputs(activePlayerIds, winnerId) {
  if (!winnerId) return {};

  const inputs = {};
  const loserIds = activePlayerIds.filter((id) => id !== winnerId);

  loserIds.forEach((playerId, index) => {
    inputs[playerId] = {
      rank: index + 2,
      isUnregistered: false,
      sevenCount: 0,
    };
  });

  return inputs;
}

function normalizePlayerInputs(previousInputs, activePlayerIds, winnerId) {
  if (!winnerId) return {};

  const nextInputs = {};
  const loserIds = activePlayerIds.filter((id) => id !== winnerId);

  loserIds.forEach((playerId, index) => {
    nextInputs[playerId] = {
      rank: index + 2,
      isUnregistered: false,
      sevenCount: 0,
      ...(previousInputs?.[playerId] || {}),
    };
  });

  return nextInputs;
}

function getRoundResultRank(playerId, winnerId, details = []) {
  if (playerId === winnerId) return 1;

  const detail = details.find((item) => item.playerId === playerId);

  return Number(detail?.rank || 99);
}

function sortPlayersForRoundResult(players, winnerId, details = []) {
  return [...players].sort((a, b) => {
    const rankA = getRoundResultRank(a.id, winnerId, details);
    const rankB = getRoundResultRank(b.id, winnerId, details);

    if (rankA !== rankB) return rankA - rankB;

    return getPlayerBaseOrder(a.id) - getPlayerBaseOrder(b.id);
  });
}

function sortScoreEntriesForRoundResult(scoreEntries, winnerId, details = []) {
  return [...scoreEntries].sort(([playerIdA], [playerIdB]) => {
    const rankA = getRoundResultRank(playerIdA, winnerId, details);
    const rankB = getRoundResultRank(playerIdB, winnerId, details);

    if (rankA !== rankB) return rankA - rankB;

    return getPlayerBaseOrder(playerIdA) - getPlayerBaseOrder(playerIdB);
  });
}

function calculateRoundScores({
  activePlayerIds,
  winnerId,
  playerInputs,
  roundMode,
  handType,
  bustTargetId,
}) {
  const scores = Object.fromEntries(activePlayerIds.map((playerId) => [playerId, 0]));
  const loserIds = activePlayerIds.filter((playerId) => playerId !== winnerId);
  const maxRank = activePlayerIds.length;
  const roundMultiplier = getRoundModeMultiplier(roundMode, handType);
  const isBustRound = ["thankyou", "stop"].includes(roundMode) && Boolean(bustTargetId);

  const autoLastCount = loserIds.filter((playerId) => {
    const input = playerInputs[playerId] || {};
  
    return (
      roundMode === "perfect" ||
      Boolean(input.isUnregistered) ||
      (isBustRound && playerId === bustTargetId)
    );
  }).length;
  
  const maxSelectableRank = Math.max(2, maxRank - autoLastCount);

  const details = loserIds.map((playerId) => {
    const input = playerInputs[playerId] || {};
    const isBustTarget = isBustRound && playerId === bustTargetId;
    const isPerfectMode = roundMode === "perfect";
    const isUnregistered = isPerfectMode || Boolean(input.isUnregistered);
    const selectedRank = Number(input.rank || 2);

    const rank =
    isUnregistered || isBustTarget
      ? maxRank
      : Math.min(selectedRank, maxSelectableRank);
      
    const baseScore = getRankBaseScore(rank);
    const sevenCount = Number(input.sevenCount || 0);
    const sevenMultiplier = getSevenMultiplier(sevenCount);

    let multiplier = roundMultiplier;
    const multiplierLabels = [];

    if (roundMode === "perfect") {
      multiplierLabels.push("퍼펙트 ×2");
    }

    if (roundMode === "hoolbak") {
      multiplierLabels.push("훌박 ×2");
    }

    if (roundMode === "hand-stop") {
      const hand = getHandType(handType);
      if (hand) {
        multiplierLabels.push(`${hand.label} ×${hand.multiplier}`);
      }
    }

    if (isUnregistered) {
      multiplier *= 2;
      multiplierLabels.push("미등록 ×2");
    }

    if (sevenCount > 0) {
      multiplier *= sevenMultiplier;
      multiplierLabels.push(`7 ${sevenCount}장 ×${sevenMultiplier}`);
    }

    const rawScore = baseScore * multiplier;

    return {
      playerId,
      rank,
      baseScore,
      multiplier,
      multiplierLabels,
      rawScore,
      finalScore: rawScore,
      isUnregistered,
      sevenCount,
      isBustTarget,
    };
  });

  if (isBustRound) {
    const loserTotal = details.reduce((sum, detail) => sum + detail.rawScore, 0);
    const bustScore = loserTotal * 2;

    details.forEach((detail) => {
      if (detail.playerId === bustTargetId) {
        detail.finalScore = bustScore;
        detail.multiplierLabels = [...detail.multiplierLabels, "독박 ×2"];
      } else {
        detail.finalScore = 0;
      }

      scores[detail.playerId] = detail.finalScore;
    });

    scores[winnerId] = -bustScore;

    return {
      scores,
      details,
      winnerScore: scores[winnerId],
      loserTotal,
      isBustRound: true,
    };
  }

  const loserTotal = details.reduce((sum, detail) => sum + detail.rawScore, 0);

  details.forEach((detail) => {
    scores[detail.playerId] = detail.rawScore;
  });

  scores[winnerId] = -loserTotal;

  return {
    scores,
    details,
    winnerScore: scores[winnerId],
    loserTotal,
    isBustRound: false,
  };
}

function calculateGameTotalScores(game) {
  const activePlayerIds = game.activePlayerIds || DEFAULT_ACTIVE_PLAYER_IDS;
  const scores = Object.fromEntries(activePlayerIds.map((playerId) => [playerId, 0]));

  (game.rounds || []).forEach((round) => {
    Object.entries(round.scores || {}).forEach(([playerId, score]) => {
      scores[playerId] = (scores[playerId] || 0) + Number(score || 0);
    });
  });

  return scores;
}

function RuleBookModal({ onClose }) {
  return (
    <div className="rules-modal-backdrop" role="dialog" aria-modal="true">
      <div className="rules-modal">
        <div className="rules-modal-header">
          <div>
            <h2>우리집 전용 훌라 규칙 설명집</h2>
            <p>헷갈리는 규칙만 펼쳐서 확인할 수 있어.</p>
          </div>
          <button type="button" className="small-button" onClick={onClose}>
            닫기
          </button>
        </div>

        <div className="rules-accordion">
          <details open>
            <summary>기본 진행</summary>
            <div className="rule-content">
              <p>일반 트럼프 52장을 사용하고 조커는 사용하지 않는다.</p>
              <p>참가 인원은 2명부터 5명까지 가능하다.</p>
              <p>첫 번째 플레이어는 8장, 나머지 플레이어는 7장을 받는다.</p>
              <p>첫판 첫 번째 플레이어는 가위바위보로 정한다.</p>
              <p>이후에는 전판 1등이 다음 판 첫 번째 플레이어가 된다.</p>
              <p>자기 차례에는 카드 한 장을 가져오고, 등록 또는 붙이기 후 카드 한 장을 버린다.</p>
            </div>
          </details>

          <details>
            <summary>등록과 붙이기</summary>
            <div className="rule-content">
              <p>등록은 같은 숫자 3장 이상 또는 같은 무늬 연속 숫자 3장 이상으로 가능하다.</p>
              <p>예: 7♠ 7♥ 7♦처럼 같은 숫자 3장 이상이면 등록 가능하다.</p>
              <p>예: 5♣ 6♣ 7♣처럼 같은 무늬로 숫자가 이어지면 등록 가능하다.</p>
              <p>A는 연속 숫자 조합에서 자유롭게 연결 가능하다.</p>
              <p>예: A-2-3, Q-K-A, K-A-2 같은 식으로 사용할 수 있다.</p>
              <p>미등록 상태에서는 다른 사람이 등록한 카드에 붙일 수 없다.</p>
            </div>
          </details>

          <details>
            <summary>기본 점수와 등수</summary>
            <div className="rule-content">
              <p>1등은 점수를 잃지 않고, 패자들의 마이너스 합계를 플러스로 가져간다.</p>
              <p>2등은 -1점, 3등은 -2점, 4등은 -3점, 5등은 -4점이다.</p>
              <p>공동 등수도 가능하다.</p>
              <p>예: 공동 3등이 2명이면 두 사람 모두 3등 기본 점수인 -2점을 적용한다.</p>
              <p>미등록자가 여러 명이면 공동 꼴등으로 처리한다.</p>
            </div>
          </details>

          <details>
            <summary>미등록</summary>
            <div className="rule-content">
              <p>게임 종료 시 아직 등록하지 못한 사람은 미등록으로 처리한다.</p>
              <p>차례가 오지 않았더라도 게임이 끝났을 때 등록하지 못했다면 미등록이다.</p>
              <p>미등록자는 등록자보다 후순위이며 자동 꼴등이다.</p>
              <p>미등록자는 기본 점수에 미등록 ×2배가 적용된다.</p>
              <p>예: 4인 게임에서 미등록이면 4등 -3점에 ×2가 적용되어 -6점이다.</p>
            </div>
          </details>

          <details>
            <summary>7 보유</summary>
            <div className="rule-content">
              <p>게임 종료 시 손패에 7 카드가 있으면 7 보유 배수가 적용된다.</p>
              <p>7 보유 1장은 ×2, 2장은 ×4, 3장은 ×8, 4장은 ×16이다.</p>
              <p>미등록, 훌박, 퍼펙트훌라, 족보 배수와 중복 적용된다.</p>
              <p>예: 4등 -3점, 미등록 ×2, 7 보유 1장 ×2라면 -3 ×2 ×2 = -12점이다.</p>
            </div>
          </details>

          <details>
            <summary>일반훌라</summary>
            <div className="rule-content">
              <p>본인 차례에 손패를 모두 없애면 일반훌라로 종료된다.</p>
              <p>추가 종료 배수는 없다.</p>
              <p>패자들은 입력한 등수, 미등록 여부, 7 보유 장수에 따라 점수가 계산된다.</p>
            </div>
          </details>

          <details>
            <summary>땡큐훌라 / 땡큐박</summary>
            <div className="rule-content">
              <p>땡큐훌라는 다른 사람이 버린 카드를 받아 바로 훌라하는 경우다.</p>
              <p>카드를 버린 사람은 반드시 땡큐박 대상이 된다.</p>
              <p>땡큐박 대상자는 자동 꼴등 처리된다.</p>
              <p>전체 패자 점수를 먼저 계산한 뒤, 그 합계의 2배를 땡큐박 대상자가 혼자 부담한다.</p>
              <p>독박 대상자가 아닌 다른 패자는 최종 0점 처리된다.</p>
              <p>예: 패자 원래 합계가 -6점이면 땡큐박 대상자는 -12점, 다른 패자는 0점이다.</p>
            </div>
          </details>

          <details>
            <summary>훌박</summary>
            <div className="rule-content">
              <p>훌박은 특정 플레이어가 미등록 상태에서 한 턴에 패를 모두 없앤 경우다.</p>
              <p>훌박은 독박이 아니라 패자 전원에게 적용되는 종료 배수다.</p>
              <p>패자 전원에게 훌박 ×2가 적용된다.</p>
              <p>패자가 미등록이면 미등록 ×2도 함께 적용된다.</p>
              <p>패자가 7을 가지고 있으면 7 보유 배수도 함께 적용된다.</p>
            </div>
          </details>

          <details>
            <summary>퍼펙트훌라</summary>
            <div className="rule-content">
              <p>퍼펙트훌라는 전체 플레이어가 미등록 상태일 때, 본인이 자신의 패만으로 훌라한 경우다.</p>
              <p>땡큐훌라는 퍼펙트훌라로 인정하지 않는다.</p>
              <p>패자 전원에게 퍼펙트 ×2가 적용된다.</p>
              <p>퍼펙트훌라에서는 패자 전원이 자동 미등록이므로 미등록 ×2도 함께 적용된다.</p>
              <p>즉, 기본적으로 패자에게 퍼펙트 ×2와 미등록 ×2가 같이 적용된다.</p>
            </div>
          </details>

          <details>
            <summary>스톱 / 스톱박</summary>
            <div className="rule-content">
              <p>스톱은 본인 차례에 선언할 수 있다.</p>
              <p>성공하면 스톱한 사람이 1등이다.</p>
              <p>다른 등록자의 패 점수가 스톱한 사람보다 같거나 낮으면 스톱박이 발생한다.</p>
              <p>미등록자는 스톱박 비교 대상에서 제외한다.</p>
              <p>스톱박 대상자는 자동 꼴등 처리된다.</p>
              <p>전체 패자 점수를 먼저 계산한 뒤, 그 합계의 2배를 스톱박 대상자가 혼자 부담한다.</p>
              <p>독박 대상자가 아닌 다른 패자는 최종 0점 처리된다.</p>
            </div>
          </details>

          <details>
            <summary>족보 스톱</summary>
            <div className="rule-content">
              <p>족보 스톱은 본인 차례에 특정 족보를 완성했을 때 선언할 수 있다.</p>
              <p>스트레이트 플러쉬 ×8: 미등록 상태에서 7장이 같은 무늬로 연속 숫자인 경우다.</p>
              <p>예: 3♠ 4♠ 5♠ 6♠ 7♠ 8♠ 9♠처럼 같은 무늬로 이어진 7장이다.</p>
              <p>하이 ×4: 미등록 상태에서 7장 카드 합이 80 이상인 경우다.</p>
              <p>로우 ×4: 미등록 상태에서 7장 카드 합이 15 이하인 경우다.</p>
              <p>세븐 포카드 ×4: 손패에 7 카드가 4장 있는 경우다.</p>
              <p>족보 배수는 미등록, 7 보유 배수와 중복 적용된다.</p>
            </div>
          </details>

          <details>
            <summary>카드 점수</summary>
            <div className="rule-content">
              <p>A는 1점이다.</p>
              <p>2부터 10까지는 숫자 그대로 계산한다.</p>
              <p>J는 11점, Q는 12점, K는 13점이다.</p>
              <p>하이와 로우 족보를 판단할 때 이 카드 점수를 기준으로 합계를 계산한다.</p>
            </div>
          </details>
        </div>
      </div>
    </div>
  );
}

function App() {
  const [games, setGames] = useState([]);
  const [currentGameIndex, setCurrentGameIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [firebaseError, setFirebaseError] = useState("");
  const isMountedRef = useRef(false);
  const [isUnlocked, setIsUnlocked] = useState(() => {
    return localStorage.getItem(ACCESS_UNLOCK_STORAGE_KEY) === "true";
  });
  const [accessCodeInput, setAccessCodeInput] = useState("");
  const [accessError, setAccessError] = useState("");

  const currentGame = games[currentGameIndex] || games[0] || createNewGame();
  const playerNames = currentGame?.playerNames || createDefaultPlayerNames();
  const activePlayerIds = currentGame?.activePlayerIds || DEFAULT_ACTIVE_PLAYER_IDS;

  const [showSettings, setShowSettings] = useState(true);
  const [showRules, setShowRules] = useState(false);
  const [draftPlayerNames, setDraftPlayerNames] = useState(createDefaultPlayerNames());
  const [draftActivePlayerIds, setDraftActivePlayerIds] = useState(DEFAULT_ACTIVE_PLAYER_IDS);

  const [winnerId, setWinnerId] = useState("");
  const [roundMode, setRoundMode] = useState("");
  const [handType, setHandType] = useState("");
  const [bustTargetId, setBustTargetId] = useState("");
  const [playerInputs, setPlayerInputs] = useState({});

  const activePlayers = useMemo(() => {
    return activePlayerIds.map((playerId) => ({
      id: playerId,
      name: getPlayerName(playerNames, playerId),
    }));
  }, [activePlayerIds, playerNames]);

  const canShowRoundPreview =
    Boolean(winnerId) &&
    Boolean(roundMode) &&
    !(roundMode === "thankyou" && !bustTargetId) &&
    !(roundMode === "hand-stop" && !handType);

  const roundPreview = useMemo(() => {
    if (!canShowRoundPreview) return null;

    return calculateRoundScores({
      activePlayerIds,
      winnerId,
      playerInputs,
      roundMode,
      handType,
      bustTargetId,
    });
  }, [activePlayerIds, winnerId, playerInputs, roundMode, handType, bustTargetId, canShowRoundPreview]);

  const totalScores = useMemo(() => {
    return calculateGameTotalScores(currentGame || createNewGame());
  }, [currentGame]);

  useEffect(() => {
    if (!isUnlocked) {
      setIsLoading(false);
      return undefined;
    }

    isMountedRef.current = true;
    setIsLoading(true);

    const unsubscribe = onSnapshot(
      SCOREBOARD_REF,
      async (snapshot) => {
        try {
          if (!snapshot.exists()) {
            const initialGame = createNewGame();

            setGames([initialGame]);
            setCurrentGameIndex(0);
            setIsLoading(false);

            if (hasAttemptedInitialScoreboardWrite) {
              return;
            }

            hasAttemptedInitialScoreboardWrite = true;

            await setDoc(
              SCOREBOARD_REF,
              {
                appVersion: APP_VERSION,
                games: [initialGame],
                currentGameIndex: 0,
                updatedAt: serverTimestamp(),
              },
              { merge: true }
            );

            if (isMountedRef.current) {
              setFirebaseError("");
            }

            return;
          }

          const data = snapshot.data();
          const nextGames = normalizeGames(data.games);
          const nextIndex =
            Number.isInteger(data.currentGameIndex) &&
            data.currentGameIndex >= 0 &&
            data.currentGameIndex < nextGames.length
              ? data.currentGameIndex
              : 0;

          setGames(nextGames);
          setCurrentGameIndex(nextIndex);
          setIsLoading(false);
          setFirebaseError("");
        } catch (error) {
          console.error("Firestore 초기화 실패:", error);
          setFirebaseError(getFirebaseErrorMessage(error, "공유 점수판 준비"));
          setIsLoading(false);
        }
      },
      (error) => {
        console.error("Firestore 구독 실패:", error);
        setGames((currentGames) => (currentGames.length ? currentGames : [createNewGame()]));
        setCurrentGameIndex(0);
        setFirebaseError(getFirebaseErrorMessage(error, "공유 점수판 불러오기"));
        setIsLoading(false);
      }
    );

    return () => {
      isMountedRef.current = false;
      unsubscribe();
    };
  }, [isUnlocked]);

  useEffect(() => {
    if (!currentGame) return;

    setDraftPlayerNames({
      ...createDefaultPlayerNames(),
      ...(currentGame.playerNames || {}),
    });

    setDraftActivePlayerIds(
      Array.isArray(currentGame.activePlayerIds) && currentGame.activePlayerIds.length >= 2
        ? currentGame.activePlayerIds
        : DEFAULT_ACTIVE_PLAYER_IDS
    );
  }, [currentGame?.id]);

  useEffect(() => {
    if (!winnerId) {
      setPlayerInputs({});
      setBustTargetId("");
      return;
    }

    if (!activePlayerIds.includes(winnerId)) {
      setWinnerId("");
      setPlayerInputs({});
      setBustTargetId("");
      return;
    }

    setPlayerInputs((previousInputs) =>
      normalizePlayerInputs(previousInputs, activePlayerIds, winnerId)
    );
  }, [activePlayerIds.join("|"), winnerId]);

  async function saveData(nextGames, nextCurrentGameIndex = currentGameIndex) {
    const normalizedGames = normalizeGames(nextGames);
    const safeIndex = Math.min(
      Math.max(Number(nextCurrentGameIndex) || 0, 0),
      normalizedGames.length - 1
    );

    setGames(normalizedGames);
    setCurrentGameIndex(safeIndex);

    try {
      await setDoc(
        SCOREBOARD_REF,
        {
          appVersion: APP_VERSION,
          games: normalizedGames,
          currentGameIndex: safeIndex,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );

      setFirebaseError("");
    } catch (error) {
      console.error("Firestore 저장 실패:", error);
      setFirebaseError(getFirebaseErrorMessage(error, "공유 점수판 저장"));
      alert("공유 점수판 저장에 실패했어. 화면 상단의 안내를 확인해줘.");
    }
  }

  async function updateCurrentGame(nextGame) {
    const nextGames = games.map((game, index) =>
      index === currentGameIndex ? normalizeGame(nextGame) : game
    );

    await saveData(nextGames, currentGameIndex);
  }

  function scrollToTop() {
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;

    requestAnimationFrame(() => {
      window.scrollTo(0, 0);
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
    });
  }

  function resetRoundForm() {
    setWinnerId("");
    setRoundMode("");
    setHandType("");
    setBustTargetId("");
    setPlayerInputs({});
  }

  function handleUnlock(event) {
    event.preventDefault();

    if (accessCodeInput.trim() !== ACCESS_CODE) {
      setAccessError("비밀번호가 맞지 않아.");
      return;
    }

    localStorage.setItem(ACCESS_UNLOCK_STORAGE_KEY, "true");
    setIsUnlocked(true);
    setAccessCodeInput("");
    setAccessError("");
  }

  function handleLock() {
    localStorage.removeItem(ACCESS_UNLOCK_STORAGE_KEY);
    setIsUnlocked(false);
    setGames([]);
    setCurrentGameIndex(0);
    setFirebaseError("");
    resetRoundForm();
    scrollToTop();
  }

  async function handleApplySettings() {
    if (draftActivePlayerIds.length < 2) {
      alert("참가자는 최소 2명 이상 선택해야 해.");
      return;
    }

    setShowSettings(false);

    const nextGame = {
      ...currentGame,
      playerNames: draftPlayerNames,
      activePlayerIds: draftActivePlayerIds,
    };

    resetRoundForm();
    await updateCurrentGame(nextGame);
  }

  async function handleCreateNewGame() {
    const nextGame = createNewGame();
    const nextGames = [...games, nextGame];
    const nextIndex = nextGames.length - 1;

    setShowSettings(true);
    resetRoundForm();
    scrollToTop();

    await saveData(nextGames, nextIndex);
  }

  async function handleDeleteGame(gameIndex) {
    if (!confirm("이 게임 기록을 삭제할까?")) return;

    if (games.length <= 1) {
      const nextGame = createNewGame();

      setShowSettings(true);
      resetRoundForm();

      await saveData([nextGame], 0);
      return;
    }

    const nextGames = games.filter((_, index) => index !== gameIndex);

    let nextIndex = currentGameIndex;

    if (gameIndex === currentGameIndex) {
      nextIndex = Math.max(0, gameIndex - 1);
    } else if (gameIndex < currentGameIndex) {
      nextIndex = currentGameIndex - 1;
    }

    nextIndex = Math.min(nextIndex, nextGames.length - 1);

    resetRoundForm();
    await saveData(nextGames, nextIndex);
  }

  async function handleDeleteAllGames() {
    if (!confirm("전체 게임 기록을 모두 삭제할까? 이 작업은 되돌릴 수 없어.")) return;

    const nextGame = createNewGame();

    setShowSettings(true);
    resetRoundForm();
    scrollToTop();

    await saveData([nextGame], 0);
  }

  async function handleClearRounds() {
    if (!confirm("현재 게임의 라운드 이력을 모두 삭제할까?")) return;

    resetRoundForm();

    await updateCurrentGame({
      ...currentGame,
      rounds: [],
    });
  }

  async function handleUndoLastRound() {
    if (!currentGame.rounds?.length) return;

    resetRoundForm();

    await updateCurrentGame({
      ...currentGame,
      rounds: currentGame.rounds.slice(0, -1),
    });
  }

  function handleWinnerChange(nextWinnerId) {
    setWinnerId(nextWinnerId);
    setBustTargetId("");

    if (!nextWinnerId) {
      setPlayerInputs({});
      return;
    }

    setPlayerInputs((previousInputs) =>
      normalizePlayerInputs(previousInputs, activePlayerIds, nextWinnerId)
    );
  }

  function handleRoundModeChange(nextRoundMode) {
    setRoundMode(nextRoundMode);
    setBustTargetId("");
    setHandType("");

    if (!winnerId) {
      setPlayerInputs({});
    }
  }

  function updatePlayerInput(playerId, field, value) {
    setPlayerInputs((previousInputs) => ({
      ...previousInputs,
      [playerId]: {
        ...(previousInputs[playerId] || {}),
        [field]: value,
      },
    }));
  }

  function handleToggleActivePlayer(playerId) {
    setDraftActivePlayerIds((previousIds) => {
      if (previousIds.includes(playerId)) {
        if (previousIds.length <= 2) return previousIds;
        return previousIds.filter((id) => id !== playerId);
      }

      return [...previousIds, playerId].sort(
        (a, b) => getPlayerBaseOrder(a) - getPlayerBaseOrder(b)
      );
    });
  }

  async function handleSelectGame(gameIndex) {
    resetRoundForm();
    setShowSettings(false);
    scrollToTop();

    await saveData(games, gameIndex);
  }

  async function handleSaveRound() {
    if (!winnerId) {
      alert("1등을 선택해야 해.");
      return;
    }

    if (!roundMode) {
      alert("종료방식을 선택해야 해.");
      return;
    }

    if (roundMode === "thankyou" && !bustTargetId) {
      alert("땡큐박 대상을 선택해야 해.");
      return;
    }

    if (roundMode === "hand-stop" && !handType) {
      alert("족보 종류를 선택해야 해.");
      return;
    }

    const preview = calculateRoundScores({
      activePlayerIds,
      winnerId,
      playerInputs,
      roundMode,
      handType,
      bustTargetId,
    });

    const roundNumber = (currentGame.rounds || []).length + 1;
    const mode = getRoundMode(roundMode);

    const newRound = {
      id: `round-${Date.now()}`,
      roundNumber,
      createdAt: new Date().toISOString(),
      winnerId,
      roundMode,
      roundModeLabel: mode?.label || "",
      handType: roundMode === "hand-stop" ? handType : "",
      handTypeLabel: roundMode === "hand-stop" ? getHandType(handType)?.label || "" : "",
      bustTargetId,
      scores: preview.scores,
      details: preview.details,
      modeDescription: getSelectedModeDescription(roundMode, handType, bustTargetId),
    };

    const nextGame = {
      ...currentGame,
      rounds: [...(currentGame.rounds || []), newRound],
    };

    const nextGames = games.map((game, index) =>
      index === currentGameIndex ? normalizeGame(nextGame) : game
    );

    resetRoundForm();
    scrollToTop();

    await saveData(nextGames, currentGameIndex);
  }

  if (isLoading) {
    return (
      <main className="app-shell">
        <section className="panel">
          <p>점수판 불러오는 중...</p>
        </section>
      </main>
    );
  }

  if (!isUnlocked) {
    return (
      <main className="app-shell lock-shell">
        <section className="panel lock-panel">
          <p className="eyebrow">우리집 전용</p>
          <h1>훌라 점수 계산기</h1>
          <p>비밀번호를 입력하면 점수판을 볼 수 있어.</p>

          <form className="lock-form" onSubmit={handleUnlock}>
            <label>
              <span>비밀번호</span>
              <input
                type="password"
                value={accessCodeInput}
                autoFocus
                onChange={(event) => {
                  setAccessCodeInput(event.target.value);
                  setAccessError("");
                }}
              />
            </label>

            {accessError && <p className="lock-error">{accessError}</p>}

            <button type="submit" className="primary-button">
              열기
            </button>
          </form>
        </section>
      </main>
    );
  }

  const loserPlayers = winnerId
    ? activePlayers.filter((player) => player.id !== winnerId)
    : [];

  const selectedModeDescription = getSelectedModeDescription(roundMode, handType, bustTargetId);

  return (
    <main className="app-shell">
      {showRules && <RuleBookModal onClose={() => setShowRules(false)} />}

      <header className="app-header">
        <div>
          <p className="eyebrow">우리집 전용</p>
          <h1>훌라 점수 계산기</h1>
          <p>게임별 기록 저장 · 자동 점수 계산 · 모바일 입력 최적화</p>
        </div>
        <button type="button" className="small-button" onClick={handleLock}>
          잠그기
        </button>
      </header>

      {firebaseError && (
        <section className="panel sync-error" role="alert">
          <strong>공유 저장 상태 확인 필요</strong>
          <p>{firebaseError}</p>
        </section>
      )}

      <section className="panel">
        <div className="section-title-row">
          <div>
            <h2>현재 점수</h2>
            <p>{currentGame.title}</p>
          </div>
          <button
            type="button"
            className="small-button"
            onClick={() => setShowSettings((value) => !value)}
          >
            {showSettings ? "게임 설정 닫기" : "게임 설정 변경"}
          </button>
        </div>

        <div className="score-grid">
          {activePlayers.map((player) => (
            <div key={player.id} className="score-card">
              <span>{player.name}</span>
              <strong
                className={
                  totalScores[player.id] > 0
                    ? "positive"
                    : totalScores[player.id] < 0
                      ? "negative"
                      : ""
                }
              >
                {formatScore(totalScores[player.id] || 0)}
              </strong>
            </div>
          ))}
        </div>

        <div className="button-row">
          <button type="button" className="primary-button" onClick={handleCreateNewGame}>
            새로운 게임 시작
          </button>
        </div>
      </section>

      {showSettings && (
        <section className="panel">
          <h2>게임 설정</h2>

          <div className="settings-block">
            <h3>참가자 선택</h3>
            <div className="toggle-grid">
              {DEFAULT_PLAYERS.map((player) => (
                <button
                  key={player.id}
                  type="button"
                  className={
                    draftActivePlayerIds.includes(player.id)
                      ? "toggle-button active"
                      : "toggle-button"
                  }
                  onClick={() => handleToggleActivePlayer(player.id)}
                >
                  {draftPlayerNames[player.id] || player.name}
                </button>
              ))}
            </div>
          </div>

          <div className="settings-block">
            <h3>이름 변경</h3>
            <div className="name-grid">
              {DEFAULT_PLAYERS.map((player) => (
                <label key={player.id}>
                  <span>{player.name}</span>
                  <input
                    value={draftPlayerNames[player.id] || ""}
                    onChange={(event) =>
                      setDraftPlayerNames((previousNames) => ({
                        ...previousNames,
                        [player.id]: event.target.value,
                      }))
                    }
                  />
                </label>
              ))}
            </div>
          </div>

          <div className="button-row">
            <button type="button" className="primary-button" onClick={handleApplySettings}>
              현재 게임 설정 적용
            </button>
          </div>
        </section>
      )}

      <section className="panel">
        <h2>이번 라운드 입력</h2>

        <div className="choice-section">
          <h3>1등 선택</h3>
          <div className="winner-button-grid">
            {activePlayers.map((player) => (
              <button
                key={player.id}
                type="button"
                className={winnerId === player.id ? "choice-button active" : "choice-button"}
                onClick={() => handleWinnerChange(winnerId === player.id ? "" : player.id)}
              >
                {player.name}
              </button>
            ))}
          </div>
        </div>

        <div className="mode-header">
          <div>
            <h3>종료 방식</h3>
            <p>{selectedModeDescription}</p>
          </div>
          <button type="button" className="small-button" onClick={() => setShowRules(true)}>
            규칙 설명집
          </button>
        </div>

        <div className="mode-button-grid">
          {ROUND_MODES.map((mode) => (
            <button
              key={mode.value}
              type="button"
              className={roundMode === mode.value ? "mode-button active" : "mode-button"}
              onClick={() => handleRoundModeChange(roundMode === mode.value ? "" : mode.value)}
            >
              <span>{mode.label}</span>
              <strong>{mode.badge}</strong>
            </button>
          ))}
        </div>

        {roundMode === "hand-stop" && (
          <div className="hand-type-section">
            <h3>족보 선택</h3>
            <div className="hand-button-grid">
              {HAND_TYPES.map((hand) => (
                <button
                  key={hand.value}
                  type="button"
                  className={handType === hand.value ? "hand-button active" : "hand-button"}
                  onClick={() => setHandType(handType === hand.value ? "" : hand.value)}
                >
                  <span>{hand.label}</span>
                  <strong>×{hand.multiplier}</strong>
                  <small>{hand.description}</small>
                </button>
              ))}
            </div>
          </div>
        )}

        {!winnerId && (
          <p className="helper-text">1등을 선택하면 패자 입력칸이 표시돼.</p>
        )}

        {winnerId && !roundMode && (
          <p className="helper-text">종료방식을 선택하면 예상점수를 계산할 수 있어.</p>
        )}

        <div className="player-input-list">
          {loserPlayers.map((player) => {
            const input = playerInputs[player.id] || {};
            const isBustSelectable = ["thankyou", "stop"].includes(roundMode);
            const isBustTarget = bustTargetId === player.id;
            const isPerfectMode = roundMode === "perfect";
            const isUnregistered = isPerfectMode || Boolean(input.isUnregistered);
            const isRankLocked = isUnregistered || isBustTarget;
            const maxRank = activePlayerIds.length;

            const autoLastCount = loserPlayers.filter((loser) => {
              const loserInput = playerInputs[loser.id] || {};
            
              return (
                roundMode === "perfect" ||
                Boolean(loserInput.isUnregistered) ||
                bustTargetId === loser.id
              );
            }).length;
            
            const maxSelectableRank = Math.max(2, maxRank - autoLastCount);
            
            const selectedRank = Number(input.rank || 2);
            const displayRank = isRankLocked
              ? maxRank
              : Math.min(selectedRank, maxSelectableRank);
            
            const rankOptions = Array.from(
              { length: maxSelectableRank - 1 },
              (_, index) => index + 2
            );

            return (
              <div key={player.id} className="player-input-card">
                <div className="player-input-header">
                  <strong>{player.name}</strong>
                  <span
                    className={
                      isBustTarget || isUnregistered ? "status-badge active" : "status-badge"
                    }
                  >
                    {isBustTarget
                      ? `${roundMode === "thankyou" ? "땡큐박" : "스톱박"} 대상`
                      : isUnregistered
                        ? "미등록 ×2 적용중"
                        : "등록"}
                  </span>
                </div>

                <div className="rank-section">
                  <span className="field-label">등수</span>
                  {isRankLocked ? (
                    <div className="auto-rank-box">자동 {maxRank}등</div>
                  ) : (
                    <div className="rank-button-grid">
                      {rankOptions.map((rank) => (
                        <button
                          key={rank}
                          type="button"
                          className={displayRank === rank ? "choice-button active" : "choice-button"}
                          onClick={() => updatePlayerInput(player.id, "rank", rank)}
                        >
                          {rank}등
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <div className="form-grid">
                  <label>
                    <span>7 보유</span>
                    <select
                      value={Number(input.sevenCount || 0)}
                      onChange={(event) =>
                        updatePlayerInput(player.id, "sevenCount", Number(event.target.value))
                      }
                    >
                      {[0, 1, 2, 3, 4].map((count) => (
                        <option key={count} value={count}>
                          {count}장 {count > 0 ? `×${2 ** count}` : "×1"}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <div className="button-row compact">
                  <button
                    type="button"
                    className={isUnregistered ? "toggle-button active" : "toggle-button"}
                    disabled={isPerfectMode}
                    onClick={() =>
                      updatePlayerInput(
                        player.id,
                        "isUnregistered",
                        !Boolean(input.isUnregistered)
                      )
                    }
                  >
                    {isPerfectMode
                      ? "자동 미등록 ×2 적용중"
                      : isUnregistered
                        ? "미등록 ×2 적용중"
                        : "미등록이면 선택"}
                  </button>

                  {isBustSelectable && (
                    <button
                      type="button"
                      className={
                        isBustTarget
                          ? "toggle-button active danger-toggle"
                          : "toggle-button"
                      }
                      onClick={() => setBustTargetId(isBustTarget ? "" : player.id)}
                    >
                      {roundMode === "thankyou" ? "땡큐박 대상" : "스톱박 대상"}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="panel">
        <div className="section-title-row">
          <div>
            <h2>이번 라운드 예상 점수</h2>
            <p>{selectedModeDescription}</p>
          </div>
        </div>

        {!canShowRoundPreview && (
          <p className="helper-text">
            1등, 종료방식, 필요한 추가 선택값을 모두 입력하면 예상점수가 표시돼.
          </p>
        )}

        {roundPreview && (
          <>
            <div className="round-score-list">
              {sortPlayersForRoundResult(activePlayers, winnerId, roundPreview.details).map(
                (player) => {
                  const detail = roundPreview.details.find((item) => item.playerId === player.id);
                  const score = roundPreview.scores[player.id] || 0;

                  return (
                    <div key={player.id} className="round-score-row">
                      <div>
                        <strong>{player.name}</strong>
                        <span>
                          {player.id === winnerId
                            ? "1등"
                            : `${detail?.rank || "-"}등${
                                detail?.multiplierLabels?.length
                                  ? ` · ${detail.multiplierLabels.join(" · ")}`
                                  : ""
                              }`}
                        </span>
                      </div>
                      <strong className={score > 0 ? "positive" : score < 0 ? "negative" : ""}>
                        {formatScore(score)}
                      </strong>
                    </div>
                  );
                }
              )}
            </div>

            <div className="save-round-area">
              <button type="button" onClick={handleSaveRound}>
                라운드 저장
              </button>
            </div>
          </>
        )}
      </section>

      <section className="panel">
        <div className="section-title-row">
          <div>
            <h2>라운드 이력</h2>
            <p>최근 라운드가 위에 표시돼.</p>
          </div>
          <div className="button-row compact">
            <button type="button" className="secondary-button" onClick={handleUndoLastRound}>
              마지막 라운드 취소
            </button>
            <button type="button" className="danger-button" onClick={handleClearRounds}>
              라운드 이력 삭제
            </button>
          </div>
        </div>

        {currentGame.rounds?.length ? (
          <div className="history-list">
            {[...currentGame.rounds].reverse().map((round) => (
              <article key={round.id} className="history-card">
                <div className="history-header">
                  <strong>{round.roundNumber}라운드</strong>
                  <span>{round.modeDescription || round.roundModeLabel}</span>
                </div>

                <p>
                  1등: {getPlayerName(playerNames, round.winnerId)}
                  {round.bustTargetId
                    ? ` / 독박: ${getPlayerName(playerNames, round.bustTargetId)}`
                    : ""}
                </p>

                <div className="round-score-list small">
                  {sortScoreEntriesForRoundResult(
                    Object.entries(round.scores || {}),
                    round.winnerId,
                    round.details || []
                  ).map(([playerId, score]) => (
                    <div key={playerId} className="round-score-row">
                      <span>{getPlayerName(playerNames, playerId)}</span>
                      <strong className={score > 0 ? "positive" : score < 0 ? "negative" : ""}>
                        {formatScore(score)}
                      </strong>
                    </div>
                  ))}
                </div>
              </article>
            ))}
          </div>
        ) : (
          <p className="empty-text">아직 저장된 라운드가 없어.</p>
        )}
      </section>

      <section className="panel">
        <div className="section-title-row">
          <div>
            <h2>게임 기록</h2>
            <p>게임별 점수와 라운드 기록을 관리해.</p>
          </div>
          <button type="button" className="danger-button" onClick={handleDeleteAllGames}>
            전체 게임 삭제
          </button>
        </div>

        <div className="history-list">
          {games.map((game, index) => {
            const gameScores = calculateGameTotalScores(game);
            const gameActivePlayers = (game.activePlayerIds || DEFAULT_ACTIVE_PLAYER_IDS).map(
              (playerId) => ({
                id: playerId,
                name: getPlayerName(game.playerNames, playerId),
              })
            );

            return (
              <article
                key={game.id}
                className={index === currentGameIndex ? "history-card selected" : "history-card"}
              >
                <div className="history-header">
                  <strong>{game.title}</strong>
                  <span>{game.rounds?.length || 0}라운드</span>
                </div>

                <div className="mini-score-grid">
                  {gameActivePlayers.map((player) => (
                    <span key={player.id}>
                      {player.name} {formatScore(gameScores[player.id] || 0)}
                    </span>
                  ))}
                </div>

                <div className="button-row compact">
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => handleSelectGame(index)}
                  >
                    이 게임 보기
                  </button>
                  <button
                    type="button"
                    className="danger-button"
                    onClick={() => handleDeleteGame(index)}
                  >
                    삭제
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      </section>
    </main>
  );
}

export default App;
