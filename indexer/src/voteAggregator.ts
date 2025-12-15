import { Actions, Action } from "./config";

interface Vote {
  player: string;
  action: number;
  blockNumber: number;
}

interface WindowResult {
  windowId: number;
  startBlock: number;
  endBlock: number;
  winningAction: Action;
  votes: Record<Action, number>;
  totalVotes: number;
}

export class VoteAggregator {
  private windowSize: number;
  private currentWindow: number = -1;
  private votes: Map<number, Vote[]> = new Map();
  private onWindowComplete: (result: WindowResult) => void;

  constructor(
    windowSize: number,
    onWindowComplete: (result: WindowResult) => void
  ) {
    this.windowSize = windowSize;
    this.onWindowComplete = onWindowComplete;
  }

  getWindowId(blockNumber: number): number {
    return Math.floor(blockNumber / this.windowSize);
  }

  addVote(player: string, action: number, blockNumber: number): void {
    const windowId = this.getWindowId(blockNumber);

    // Initialize window if first vote
    if (this.currentWindow === -1) {
      this.currentWindow = windowId;
    }

    // Check if we've moved to a new window
    if (windowId > this.currentWindow) {
      // Finalize all completed windows
      for (let w = this.currentWindow; w < windowId; w++) {
        this.finalizeWindow(w);
      }
      this.currentWindow = windowId;
    }

    // Store vote for current window
    if (!this.votes.has(windowId)) {
      this.votes.set(windowId, []);
    }
    this.votes.get(windowId)!.push({ player, action, blockNumber });

    console.log(
      `Vote: ${player.slice(0, 8)}... voted ${Actions[action]} in block ${blockNumber} (window ${windowId})`
    );
  }

  private finalizeWindow(windowId: number): void {
    const windowVotes = this.votes.get(windowId) || [];

    // Skip windows with no votes
    if (windowVotes.length === 0) {
      this.votes.delete(windowId);
      return;
    }

    // Count votes per action
    const voteCounts: Record<Action, number> = {
      UP: 0,
      DOWN: 0,
      LEFT: 0,
      RIGHT: 0,
      A: 0,
      B: 0,
      START: 0,
      SELECT: 0,
    };

    for (const vote of windowVotes) {
      const actionName = Actions[vote.action];
      if (actionName) {
        voteCounts[actionName]++;
      }
    }

    // Find winning action (most votes, ties broken by first in enum order)
    let winningAction: Action = "UP";
    let maxVotes = 0;

    for (const action of Actions) {
      if (voteCounts[action] > maxVotes) {
        maxVotes = voteCounts[action];
        winningAction = action;
      }
    }

    const result: WindowResult = {
      windowId,
      startBlock: windowId * this.windowSize,
      endBlock: (windowId + 1) * this.windowSize - 1,
      winningAction,
      votes: voteCounts,
      totalVotes: windowVotes.length,
    };

    console.log(
      `\nWindow ${windowId} complete: ${winningAction} wins with ${maxVotes}/${result.totalVotes} votes`
    );
    console.log(`Vote breakdown:`, voteCounts);

    // Emit result
    this.onWindowComplete(result);

    // Clean up old window data
    this.votes.delete(windowId);
  }

  // Called on each new block to check if window should be finalized
  onBlock(blockNumber: number): void {
    const windowId = this.getWindowId(blockNumber);

    // Initialize if first block
    if (this.currentWindow === -1) {
      this.currentWindow = windowId;
      return;
    }

    // Check if we've moved to a new window
    if (windowId > this.currentWindow) {
      // Finalize all completed windows
      for (let w = this.currentWindow; w < windowId; w++) {
        this.finalizeWindow(w);
      }
      this.currentWindow = windowId;
    }
  }

  // Force finalize current window (useful for testing)
  forceFinalize(): void {
    if (this.currentWindow >= 0) {
      this.finalizeWindow(this.currentWindow);
      this.currentWindow++;
    }
  }
}
