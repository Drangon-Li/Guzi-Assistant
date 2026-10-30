(() => {
  const root = document.documentElement;
  const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
  const normalize = value => ['light', 'dark'].includes(value) ? value : 'system';
  let preference = 'system';
  let select;

  try { preference = normalize(localStorage.getItem('guzi-theme')); } catch {}

  function renderTheme() {
    const theme = preference === 'system' ? (systemTheme.matches ? 'dark' : 'light') : preference;
    root.dataset.theme = theme;
    root.dataset.themePreference = preference;
    root.style.colorScheme = theme;
    document.querySelector('meta[name="theme-color"]').content = theme === 'dark' ? '#17251F' : '#FFFAF0';
    if (select) select.value = preference;
  }

  renderTheme();
  systemTheme.addEventListener('change', () => {
    if (preference === 'system') renderTheme();
  });
  window.addEventListener('storage', event => {
    if (event.key !== 'guzi-theme' && event.key !== null) return;
    preference = normalize(event.newValue);
    renderTheme();
  });
  document.addEventListener('DOMContentLoaded', () => {
    select = document.querySelector('#theme-select');
    select.value = preference;
    select.addEventListener('change', () => {
      preference = normalize(select.value);
      try { localStorage.setItem('guzi-theme', preference); } catch {}
      renderTheme();
    });
    select.closest('.theme-control').hidden = false;
  }, { once: true });
})();
