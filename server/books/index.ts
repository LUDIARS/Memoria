// books ドメインの公開口。 外からはこのファイル経由で使う。

export { ensureBooksSchema } from './schema.js';
export { makeBooksRouter } from './router.js';
export { startBooksScheduler, runWeeklyBooksJob } from './scheduler.js';
export { getBooksConfig, setBooksConfig, DEFAULT_BOOKS_CONFIG } from './config.js';
export { checkNewReleases } from './new-release.js';
export { generateSuggestions } from './suggest.js';
export { importReadingRecords, shouldRemindImport, markImportReminded } from './import.js';
export { booksJobCoordinator } from './coordinator.js';
export {
  countBooks, insertBook, listBooks, listNewReleases, listPendingNotifications,
  listSuggestions, markNotified,
} from './store.js';
export { deriveWatchTargets } from './watch.js';
export type {
  Book, BookInput, BooksConfig, NewRelease, Suggestion, WatchTarget,
} from './types.js';
