import { useEffect, useRef } from "react";
import type { Vote } from "../hooks/useSocket";
import "./VoteChat.css";

interface VoteChatProps {
  votes: Vote[];
  userAddress?: string;
}

// Generate a persistent color for a wallet address using a hash
function getWalletColor(address: string): string {
  // Vibrant colors that work well on dark backgrounds
  const colors = [
    "#FF6B6B", // coral red
    "#4ECDC4", // teal
    "#FFE66D", // yellow
    "#95E1D3", // mint
    "#F38181", // salmon
    "#AA96DA", // lavender
    "#FCBAD3", // pink
    "#A8D8EA", // sky blue
    "#FF9F43", // orange
    "#6BCB77", // green
    "#4D96FF", // blue
    "#FFD93D", // gold
    "#C9F4AA", // lime
    "#F2A154", // peach
    "#B983FF", // purple
    "#00D9FF", // cyan
  ];

  // Simple hash function to get consistent color from address
  let hash = 0;
  for (let i = 0; i < address.length; i++) {
    hash = address.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}

export function VoteChat({ votes, userAddress }: VoteChatProps) {
  const chatRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new votes arrive
  useEffect(() => {
    if (chatRef.current) {
      chatRef.current.scrollTop = chatRef.current.scrollHeight;
    }
  }, [votes]);

  return (
    <div className="vote-chat">
      <div className="chat-header">
        <span className="chat-title">Live Votes</span>
      </div>
      <div className="chat-messages" ref={chatRef}>
        {votes.length === 0 ? (
          <div className="chat-empty">No votes yet. Be the first!</div>
        ) : (
          votes.map((vote, idx) => {
            const isUser = userAddress &&
              vote.player.toLowerCase() === userAddress.toLowerCase();
            const walletColor = getWalletColor(vote.player);

            return (
              <div
                key={`${vote.txHash}-${idx}`}
                className={`chat-message ${isUser ? 'user-message' : ''}`}
              >
                <a
                  href={`https://testnet.monadvision.com/block/${vote.blockNumber}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="message-block"
                  title={`Block ${vote.blockNumber}`}
                >
                  {vote.blockNumber}
                </a>
                <a
                  href={`https://testnet.monadvision.com/tx/${vote.txHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="message-username"
                  style={{ color: walletColor }}
                  title={vote.player}
                >
                  {isUser ? 'You' : `${vote.player.slice(0, 6)}...${vote.player.slice(-4)}`}
                </a>
                <span className="message-action">{vote.action}</span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
