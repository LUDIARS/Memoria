// 本棚のスラッシュコマンド定義とハンドラ。
//   /book <title> [author] [rating] [memo]  — 良かった本を登録
//   /books [query]                          — 本棚を見る (引数なし = お気に入り)
//   /book-new                               — 新刊チェックを今すぐ回す
//   /book-suggest [refresh]                 — 人気の本サジェスト
//
// slash-commands.ts を膨らませないよう、 books 関連はこのファイルに閉じる。

import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, type ButtonInteraction,
  type ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder,
} from 'discord.js';
import type BetterSqlite3 from 'better-sqlite3';
import {
  addFavoriteBook, listBooksMessage, rateBook, runNewReleaseCheck, runSuggest, showSuggestions,
} from './actions/book.js';

type Db = BetterSqlite3.Database;

export const BOOK_COMMANDS = [
  new SlashCommandBuilder().setName('book').setDescription('良かった本を登録する')
    .addStringOption((o) => o.setName('title').setDescription('タイトル').setRequired(true).setMaxLength(300))
    .addStringOption((o) => o.setName('author').setDescription('著者').setMaxLength(120))
    .addIntegerOption((o) => o.setName('rating').setDescription('評価 (1〜5)').setMinValue(1).setMaxValue(5))
    .addStringOption((o) => o.setName('memo').setDescription('感想').setMaxLength(4_000)),
  new SlashCommandBuilder().setName('books').setDescription('本棚を見る (引数なし = お気に入り)')
    .addStringOption((o) => o.setName('query').setDescription('タイトル / 著者 / タグ').setMaxLength(200)),
  new SlashCommandBuilder().setName('book-new').setDescription('新刊チェックを今すぐ実行する'),
  new SlashCommandBuilder().setName('book-suggest').setDescription('人気の本サジェスト')
    .addBooleanOption((o) => o.setName('refresh').setDescription('生成し直す (時間がかかります)')),
];

export const BOOK_COMMAND_NAMES = new Set(BOOK_COMMANDS.map((c) => c.name));

/**
 * books コマンドを処理する。 担当外なら false を返して呼び元の分岐に戻す。
 * 生成系は数十秒かかるので defer してから編集する。
 */
export async function handleBookCommand(
  interaction: ChatInputCommandInteraction,
  db: Db,
): Promise<boolean> {
  switch (interaction.commandName) {
    case 'book': {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const added = await addFavoriteBook(db, {
        title: interaction.options.getString('title', true),
        author: interaction.options.getString('author'),
        rating: interaction.options.getInteger('rating'),
        memo: interaction.options.getString('memo'),
      });
      // 評価を省いたときは★ボタンで訊く (コマンド引数より押しやすい)。
      await interaction.editReply({
        content: added.message,
        components: added.needsRating ? [ratingRow(added.book.id)] : [],
      });
      return true;
    }
    case 'books': {
      await interaction.reply({
        content: listBooksMessage(db, interaction.options.getString('query')),
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }
    case 'book-new': {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await interaction.editReply(await runNewReleaseCheck(db));
      return true;
    }
    case 'book-suggest': {
      if (interaction.options.getBoolean('refresh')) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await interaction.editReply(await runSuggest(db));
        return true;
      }
      await interaction.reply({ content: showSuggestions(db), flags: MessageFlags.Ephemeral });
      return true;
    }
    default:
      return false;
  }
}


const RATING_PREFIX = 'book-rate';

/** ★1〜5 のボタン列。 customId に book id を埋める。 */
export function ratingRow(bookId: number): ActionRowBuilder<ButtonBuilder> {
  const buttons = [1, 2, 3, 4, 5].map((value) => new ButtonBuilder()
    .setCustomId(`${RATING_PREFIX}:${bookId}:${value}`)
    .setLabel('★'.repeat(value))
    .setStyle(value >= 4 ? ButtonStyle.Primary : ButtonStyle.Secondary));
  return new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons);
}

/** customId を (bookId, rating) に戻す。 books のボタンでなければ null。 */
export function parseRatingCustomId(customId: string): { bookId: number; rating: number } | null {
  const parts = customId.split(':');
  if (parts.length !== 3 || parts[0] !== RATING_PREFIX) return null;
  const bookId = Number(parts[1]);
  const rating = Number(parts[2]);
  if (!Number.isInteger(bookId) || bookId <= 0) return null;
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return null;
  return { bookId, rating };
}

export function isBookRatingButton(customId: string): boolean {
  return parseRatingCustomId(customId) !== null;
}

/** ★ボタンの押下を反映する。 担当外なら false。 */
export async function handleBookRatingButton(interaction: ButtonInteraction, db: Db): Promise<boolean> {
  const parsed = parseRatingCustomId(interaction.customId);
  if (!parsed) return false;
  const result = rateBook(db, parsed.bookId, parsed.rating);
  await interaction.update({
    content: result?.message ?? 'その本は見つかりませんでした (削除された可能性があります)。',
    components: [],
  });
  return true;
}
