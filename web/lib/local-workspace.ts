'use client';
import { useSyncExternalStore } from 'react';
import { emptyBook, parseBook, type PracticeBook } from './practice';
type Snapshot = {
  book: PracticeBook;
  dark: boolean;
  notice: string;
  loaded: boolean;
};
export type BookUpdate =
  | PracticeBook
  | ((previous: PracticeBook) => PracticeBook);
const server: Snapshot = {
  book: emptyBook(),
  dark: false,
  notice: '',
  loaded: false,
};
let cached: Snapshot | null = null;
const listeners = new Set<() => void>();
function snapshot(): Snapshot {
  if (typeof window === 'undefined') return server;
  if (cached) return cached;
  try {
    const raw = localStorage.getItem('domino-practice-v1');
    cached = {
      book: raw ? parseBook(JSON.parse(raw)) : emptyBook(),
      dark: localStorage.getItem('domino-appearance') === 'dark',
      notice: '',
      loaded: true,
    };
  } catch {
    cached = {
      book: emptyBook(),
      dark: false,
      notice:
        'Saved practice data could not be read. Changes will use a fresh local practice session.',
      loaded: true,
    };
  }
  return cached;
}
function notify() {
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  const storage = (event: StorageEvent) => {
    if (
      event.key === null ||
      event.key === 'domino-practice-v1' ||
      event.key === 'domino-appearance'
    ) {
      cached = null;
      notify();
    }
  };
  window.addEventListener('storage', storage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', storage);
  };
}
function saveBook(update: BookUpdate) {
  const current = snapshot(),
    book = typeof update === 'function' ? update(current.book) : update;
  parseBook(book);
  let notice = '';
  try {
    localStorage.setItem('domino-practice-v1', JSON.stringify(book));
  } catch {
    notice =
      'Browser storage is unavailable. Changes will last only for this session.';
  }
  cached = { ...current, book, notice };
  notify();
}
function setDark(dark: boolean) {
  const current = snapshot();
  let notice = current.notice;
  try {
    localStorage.setItem('domino-appearance', dark ? 'dark' : 'light');
  } catch {
    notice = 'Appearance could not be saved on this browser.';
  }
  cached = { ...current, dark, notice };
  notify();
}
function setNotice(notice: string) {
  cached = { ...snapshot(), notice };
  notify();
}
export function useLocalWorkspace() {
  const state = useSyncExternalStore(subscribe, snapshot, () => server);
  return { ...state, saveBook, setDark, setNotice };
}
