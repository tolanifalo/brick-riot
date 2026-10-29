import { create } from 'zustand';
import { canStartBoard } from '../progress/progressStore';

export type Screen =
  | 'loading'
  | 'menu'
  | 'campaign'
  | 'solo'
  | 'multiplayer'
  | 'workshop'
  | 'account'
  | 'profile'
  | 'quickmatch'
  | 'leaderboards';

interface AppState {
  screen: Screen;
  /** Board for the solo screen; only ever set through startBoard. */
  boardId: string | null;
  /** Board highlighted on the campaign screen. */
  selectedBoardId: string | null;
  /** Which form the account screen opens with. */
  accountMode: 'signin' | 'register' | 'forgot' | 'reset';
  /** Password-reset token from an emailed link (kept in memory only). */
  resetToken: string | null;
  setScreen(screen: Exclude<Screen, 'solo'>): void;
  openAccount(mode: AppState['accountMode'], resetToken?: string | null): void;
  selectBoard(boardId: string): void;
  /** Starts a board if it is unlocked. Returns false (and stays put) otherwise. */
  startBoard(boardId: string): boolean;
}

/**
 * There is no URL routing to boards: the only entry point is startBoard,
 * which checks unlock status against recorded progress.
 */
export const useApp = create<AppState>((set) => ({
  screen: 'loading',
  boardId: null,
  selectedBoardId: null,
  accountMode: 'signin',
  resetToken: null,
  setScreen: (screen) => set({ screen }),
  openAccount: (accountMode, resetToken = null) => set({ screen: 'account', accountMode, resetToken }),
  selectBoard: (selectedBoardId) => set({ selectedBoardId }),
  startBoard: (boardId) => {
    if (!canStartBoard(boardId)) return false;
    set({ screen: 'solo', boardId, selectedBoardId: boardId });
    return true;
  },
}));
