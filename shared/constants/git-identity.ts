export const CYCLOID_GIT_COMMITTER_NAME = "Cycloid";
// Verified with `curl https://api.github.com/users/cycloid%5Bbot%5D`; GitHub noreply bot attribution needs the bot account id.
const CYCLOID_GITHUB_BOT_ID = "268249142";
const CYCLOID_GITHUB_BOT_LOGIN = "cycloid[bot]";
export const CYCLOID_GIT_COMMITTER_EMAIL = `${CYCLOID_GITHUB_BOT_ID}+${CYCLOID_GITHUB_BOT_LOGIN}@users.noreply.github.com`;
export const CYCLOID_CO_AUTHOR_TRAILER = `Co-authored-by: ${CYCLOID_GIT_COMMITTER_NAME} <${CYCLOID_GIT_COMMITTER_EMAIL}>`;
