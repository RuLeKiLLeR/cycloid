const DEFAULT_TITLE = "Cycloid";
const ATTENTION_PREFIX = "● ";

let baseTitle = DEFAULT_TITLE;
let baseTitleOwner: symbol | null = null;
let attentionActive = false;

function renderTitle() {
  document.title = `${attentionActive ? ATTENTION_PREFIX : ""}${baseTitle}`;
}

export function setAuthenticatedBaseTitle(owner: symbol, title: string) {
  baseTitleOwner = owner;
  baseTitle = title;
  renderTitle();
}

export function clearAuthenticatedBaseTitle(owner: symbol) {
  if (baseTitleOwner !== owner) return;
  baseTitleOwner = null;
  baseTitle = DEFAULT_TITLE;
  renderTitle();
}

export function setAuthenticatedTitleAttention(active: boolean) {
  attentionActive = active;
  renderTitle();
}

export function resetAuthenticatedTitle() {
  baseTitle = DEFAULT_TITLE;
  baseTitleOwner = null;
  attentionActive = false;
  renderTitle();
}
