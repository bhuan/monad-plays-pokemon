import type { GameState } from "../hooks/useSocket";
import "./GameStatusPanel.css";

interface GameStatusPanelProps {
  gameState: GameState | null;
}

// Badge data with PokeAPI sprite URLs
const BADGES = [
  { key: "boulder", name: "Boulder Badge", num: 1 },
  { key: "cascade", name: "Cascade Badge", num: 2 },
  { key: "thunder", name: "Thunder Badge", num: 3 },
  { key: "rainbow", name: "Rainbow Badge", num: 4 },
  { key: "soul", name: "Soul Badge", num: 5 },
  { key: "marsh", name: "Marsh Badge", num: 6 },
  { key: "volcano", name: "Volcano Badge", num: 7 },
  { key: "earth", name: "Earth Badge", num: 8 },
] as const;

// Get badge sprite URL from PokeAPI
function getBadgeUrl(badgeNum: number): string {
  return `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/badges/${badgeNum}.png`;
}

export function GameStatusPanel({ gameState }: GameStatusPanelProps) {
  if (!gameState) {
    return (
      <div className="game-status-bar loading">
        <span>Loading...</span>
      </div>
    );
  }

  return (
    <div className="game-status-bar">
      <div className="status-row">
        <span className="status-location">{gameState.location}</span>
        <span className="status-money">
          <span className="pokemon-dollar">₽</span>
          {gameState.money.toLocaleString()}
        </span>
      </div>
      <div className="status-badges">
        {BADGES.map((badge) => {
          const earned = gameState.badges[badge.key as keyof typeof gameState.badges];
          return (
            <img
              key={badge.key}
              src={getBadgeUrl(badge.num)}
              alt={badge.name}
              title={`${badge.name}${earned ? " (Earned)" : ""}`}
              className={`badge-img ${earned ? "earned" : "unearned"}`}
            />
          );
        })}
      </div>
    </div>
  );
}
