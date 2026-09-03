// 本棚のスラッシュコマンド定義とハンドラ。
//   /book <title> [author] [rating] [memo]  — 良かった本を登録
//   /books [query]                          — 本棚を見る (引数なし = お気に入り)
//   /book-new                               — 新刊チェックを今すぐ回す
//   /book-suggest [refresh]                 — 人気の本サジェスト
//
// slash-commands.ts を膨らませないよう、 books 関連はこのファイルに閉じる。

import { type ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from 'discord.js';
import type BetterSqlite3 from 'better-sqlite3';
import {
  addFavoriteBook, listBooksMessage, runNewReleaseCheck, runSuggest, showSuggestions,
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
      await interaction.editReply(await addFavoriteBook(db, {
        title: interaction.options.getString('title', true),
        author: interaction.options.getString('author'),
        rating: interaction.options.getInteger('rating'),
        memo: interaction.options.getString('memo'),
      }));
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
