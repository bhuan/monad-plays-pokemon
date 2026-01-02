import type { GameState } from "../hooks/useSocket";
import "./PartyPanel.css";

interface PartyPanelProps {
  gameState: GameState | null;
}

// Get Pokemon sprite URL - using original Red/Blue sprites for classic 8-bit look
function getSpriteUrl(pokedexNum: number): string {
  if (pokedexNum <= 0 || pokedexNum > 151) return "";
  return `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/versions/generation-i/red-blue/transparent/${pokedexNum}.png`;
}

// Get HP bar color based on percentage
function getHpColor(percent: number): string {
  if (percent > 50) return "#2ecc71"; // Green
  if (percent > 20) return "#f1c40f"; // Yellow
  return "#e74c3c"; // Red
}

export function PartyPanel({ gameState }: PartyPanelProps) {
  // Create 6 slots (filled or empty)
  const slots = Array.from({ length: 6 }, (_, i) => {
    const pokedexNum = gameState?.partySpecies?.[i] || 0;
    const hp = gameState?.partyHp?.[i] || { current: 0, max: 0 };
    const level = gameState?.partyLevels?.[i] || 0;
    return { pokedexNum, hp, level };
  });

  return (
    <div className="party-panel">
      {slots.map((slot, index) => (
        <div key={index} className={`party-slot ${slot.pokedexNum > 0 ? "filled" : "empty"}`}>
          {slot.pokedexNum > 0 ? (
            <>
              <div className={`sprite-container ${slot.hp.current === 0 ? "fainted" : ""}`}>
                <span className="level-badge">L{slot.level}</span>
                <img
                  src={getSpriteUrl(slot.pokedexNum)}
                  alt={`Pokemon #${slot.pokedexNum}`}
                  className="party-sprite"
                  loading="lazy"
                />
              </div>
              <div className="hp-bar-container">
                <div
                  className="hp-bar-fill"
                  style={{
                    width: `${slot.hp.max > 0 ? (slot.hp.current / slot.hp.max) * 100 : 0}%`,
                    backgroundColor: getHpColor(slot.hp.max > 0 ? (slot.hp.current / slot.hp.max) * 100 : 0),
                  }}
                />
              </div>
            </>
          ) : (
            <div className="empty-slot" />
          )}
        </div>
      ))}
    </div>
  );
}
