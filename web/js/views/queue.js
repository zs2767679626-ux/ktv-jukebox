export function render(el, ctx) {
  if (el.__jukeboxBuilt) return;
  el.__jukeboxBuilt = true;
  el.innerHTML = '<div class="loading">建设中…</div>';
}
